'use strict';

const os = require('os');
const { getMysqlPool } = require('../../db/mysqlPool');
const { loadShopsForOpenApiCollect } = require('../../lib/readSyncShops');
const { syncOneShop } = require('../../modules/sync/shopSyncRunner');
const { claimNextJob, updateJob } = require('../services/syncJobRepository');
const { appendSyncLog } = require('../services/syncLogService');
const { patchShopSyncStatus } = require('../services/shopSyncStatusService');
const { acquireShopSyncLock, releaseShopSyncLock } = require('../locks/shopSyncLock');
const { isTokenError, tokenErrorCode } = require('../services/tokenErrorDetector');
const { retryDelayMs, shouldDisableAfterFailures, maxAttempts } = require('../services/syncRetryPolicy');
const { isSyncJobRetryEnabled } = require('../services/syncEnv');
const { logSyncSqlError } = require('../services/syncSql');
const { isOrderApiScopeError } = require('../../lib/openApiWorkerEligibility');
const { applyApiVerifiedHealthyState } = require('../../lib/staleAuthHealthRepair');

const WORKER_ID = `${os.hostname()}-${process.pid}`;

function logWorker(parts) {
  const line = parts.join(' ');
  console.log(`[sync-worker] ${line}`);
  console.log(`[sync-job] ${line}`);
}

/**
 * @param {Record<string, unknown>} job
 */
async function resolveShopForJob(job) {
  const tid = Number(job.tenant_id);
  const sid = Number(job.shop_id);
  const shops = await loadShopsForOpenApiCollect({ tenantId: tid });
  return shops.find((s) => Number(s.internal_shop_id) === sid) || null;
}

/**
 * @param {import('mysql2/promise').Pool} pool
 * @param {Record<string, unknown>} job
 * @param {Awaited<ReturnType<typeof syncOneShop>>} result
 * @param {number} durationMs
 */
async function finalizeJobSuccess(pool, job, result, durationMs) {
  const tid = Number(job.tenant_id);
  const sid = Number(job.shop_id);
  const platform = String(job.platform || 'tiktok');
  const jobId = Number(job.id);
  const st = String(result.status || (result.ok ? 'success' : 'failed'));
  const syncStatus = st === 'partial_success' ? 'partial_success' : 'success';

  await updateJob(pool, tid, jobId, {
    status: 'success',
    finished_at: new Date(),
    error_message: null,
  });
  const orderCount = Number(result.fetched_orders_count ?? result.inserted_orders_count ?? 0) || 0;
  await applyApiVerifiedHealthyState(pool, {
    tenantId: tid,
    shopId: sid,
    orderCount,
    source: 'shop_sync_worker',
  });
  await appendSyncLog({
    tenant_id: tid,
    shop_id: sid,
    platform,
    sync_job_id: jobId,
    level: 'info',
    message: `sync ${syncStatus}`,
    context_json: { durationMs, status: st },
  });
  logWorker([
    `job=${jobId}`,
    `tenant=${tid}`,
    `shop=${sid}`,
    `status=success`,
    `durationMs=${durationMs}`,
  ]);
}

/**
 * @param {import('mysql2/promise').Pool} pool
 * @param {Record<string, unknown>} job
 * @param {string} errMsg
 * @param {number} durationMs
 */
async function finalizeJobFailure(pool, job, errMsg, durationMs) {
  const tid = Number(job.tenant_id);
  const sid = Number(job.shop_id);
  const platform = String(job.platform || 'tiktok');
  const jobId = Number(job.id);
  const attempt = Number(job.attempt_count || 0) + 1;
  const tokenBad = isTokenError(errMsg);

  if (isOrderApiScopeError(errMsg)) {
    await updateJob(pool, tid, jobId, {
      status: 'failed',
      attempt_count: attempt,
      finished_at: new Date(),
      error_message: String(errMsg).slice(0, 2000),
    });
    await patchShopSyncStatus(pool, tid, sid, platform, {
      sync_status: 'failed',
      last_sync_at: new Date(),
      last_error: String(errMsg).slice(0, 2000),
      last_error_code: 'scope_error',
      sync_fail_count: attempt,
      is_token_valid: 1,
    });
    await appendSyncLog({
      tenant_id: tid,
      shop_id: sid,
      platform,
      sync_job_id: jobId,
      level: 'error',
      message: 'scope_error',
      context_json: { errMsg, durationMs },
    });
    logWorker([`job=${jobId}`, `tenant=${tid}`, `shop=${sid}`, 'status=scope_error', `durationMs=${durationMs}`]);
    return;
  }

  if (tokenBad) {
    await updateJob(pool, tid, jobId, {
      status: 'failed',
      attempt_count: attempt,
      finished_at: new Date(),
      error_message: String(errMsg).slice(0, 2000),
    });
    await patchShopSyncStatus(pool, tid, sid, platform, {
      sync_status: 'token_expired',
      last_sync_at: new Date(),
      last_error: String(errMsg).slice(0, 2000),
      last_error_code: tokenErrorCode(errMsg),
      sync_fail_count: attempt,
      is_token_valid: 0,
      token_expired_at: new Date(),
    });
    await appendSyncLog({
      tenant_id: tid,
      shop_id: sid,
      platform,
      sync_job_id: jobId,
      level: 'error',
      message: 'token_expired',
      context_json: { errMsg, durationMs },
    });
    logWorker([`job=${jobId}`, `tenant=${tid}`, `shop=${sid}`, 'status=token_expired', `durationMs=${durationMs}`]);
    return;
  }

  const retryOn = isSyncJobRetryEnabled() && attempt < maxAttempts();
  if (retryOn) {
    const nextAt = new Date(Date.now() + retryDelayMs(attempt));
    await updateJob(pool, tid, jobId, {
      status: 'retry_wait',
      attempt_count: attempt,
      next_retry_at: nextAt,
      error_message: String(errMsg).slice(0, 2000),
      locked_by: null,
      locked_at: null,
    });
    await patchShopSyncStatus(pool, tid, sid, platform, {
      sync_status: 'failed',
      last_sync_at: new Date(),
      last_error: String(errMsg).slice(0, 2000),
      last_error_code: 'sync_failed',
      sync_fail_count: attempt,
    });
    await appendSyncLog({
      tenant_id: tid,
      shop_id: sid,
      platform,
      sync_job_id: jobId,
      level: 'warn',
      message: `retry_wait attempt=${attempt}`,
      context_json: { nextAt, errMsg, durationMs },
    });
    logWorker([`job=${jobId}`, `tenant=${tid}`, `shop=${sid}`, 'status=retry_wait', `attempt=${attempt}`]);
    return;
  }

  const disabled = shouldDisableAfterFailures(attempt);
  await updateJob(pool, tid, jobId, {
    status: 'failed',
    attempt_count: attempt,
    finished_at: new Date(),
    error_message: String(errMsg).slice(0, 2000),
  });
  await patchShopSyncStatus(pool, tid, sid, platform, {
    sync_status: disabled ? 'disabled' : 'failed',
    last_sync_at: new Date(),
    last_error: String(errMsg).slice(0, 2000),
    last_error_code: disabled ? 'max_retries' : 'sync_failed',
    sync_fail_count: attempt,
  });
  await appendSyncLog({
    tenant_id: tid,
    shop_id: sid,
    platform,
    sync_job_id: jobId,
    level: 'error',
    message: disabled ? 'disabled_after_max_retries' : 'failed',
    context_json: { errMsg, attempt, durationMs },
  });
  logWorker([`job=${jobId}`, `tenant=${tid}`, `shop=${sid}`, `status=failed`, `attempt=${attempt}`]);
}

/**
 * 处理单条 job；无 job 时返回 false
 * @param {import('mysql2/promise').Pool} pool
 */
async function processOneSyncJob(pool) {
  const job = await claimNextJob(pool, WORKER_ID);
  if (!job) return false;

  const tid = Number(job.tenant_id);
  const sid = Number(job.shop_id);
  const platform = String(job.platform || 'tiktok');
  const jobId = Number(job.id);
  const t0 = Date.now();

  const lock = await acquireShopSyncLock(pool, { tenant_id: tid, shop_id: sid, platform, job_id: jobId }, WORKER_ID);
  if (!lock.acquired) {
    await updateJob(pool, tid, jobId, {
      status: 'queued',
      locked_by: null,
      locked_at: null,
      started_at: null,
    });
    return true;
  }

  await patchShopSyncStatus(pool, tid, sid, platform, { sync_status: 'syncing', current_job_id: jobId });

  try {
    const shop = await resolveShopForJob(job);
    if (!shop) {
      await finalizeJobFailure(pool, job, 'shop_not_found_or_not_eligible', Date.now() - t0);
      return true;
    }

    const result = await syncOneShop(shop, { deadlineMs: Date.now() + 55000 });
    const durationMs = Date.now() - t0;

    if (result.ok) {
      await finalizeJobSuccess(pool, job, result, durationMs);
    } else {
      await finalizeJobFailure(pool, job, result.error_message || 'sync_failed', durationMs);
    }
  } catch (e) {
    if (!e?.sqlTagLogged) {
      logSyncSqlError('process_sync_job', 'unknown', e, { jobId, tenant_id: tid, shop_id: sid });
    }
    await finalizeJobFailure(pool, job, String(e?.message || e), Date.now() - t0);
  } finally {
    await releaseShopSyncLock(pool, { tenant_id: tid, shop_id: sid, platform });
  }
  return true;
}

module.exports = { WORKER_ID, processOneSyncJob };
