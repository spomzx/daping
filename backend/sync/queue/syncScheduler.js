'use strict';

const { getMysqlPool } = require('../../db/mysqlPool');
const { loadShopsForOpenApiCollect } = require('../../lib/readSyncShops');
const { enqueueShopSyncJob, hasActiveJobForShop } = require('../services/syncJobRepository');
const { ensureShopSyncStatusRow } = require('../services/shopSyncStatusService');
const { releaseExpiredLocks } = require('../locks/shopSyncLock');
const { appendSyncLog } = require('../services/syncLogService');
const { isMissingSyncTableError } = require('../services/syncSchemaGuard');
const { logSyncSqlError } = require('../services/syncSql');
const { recoverShopSyncStatusIfEligible } = require('../../lib/shopCipherBackfill');

let schedulerPaused = false;
let schedulerPauseLogged = false;
let syncStatusRecoveredOnce = false;

async function recoverStaleSyncStatusOnce(pool) {
  if (syncStatusRecoveredOnce) return;
  syncStatusRecoveredOnce = true;
  try {
    const [rows] = await pool.query(
      `SELECT DISTINCT tenant_id FROM shops WHERE platform = 'tiktok' AND status = 'active'`,
    );
    for (const r of Array.isArray(rows) ? rows : []) {
      const tid = Number(r.tenant_id);
      if (!Number.isFinite(tid) || tid <= 0) continue;
      const rep = await recoverShopSyncStatusIfEligible(pool, { tenantId: tid });
      const n = rep.recovered?.length || 0;
      if (n > 0) logQueue([`sync_status_recovered tenant=${tid} count=${n}`]);
    }
  } catch (e) {
    console.warn('[sync-queue] sync_status_recovery_failed', e?.message || e);
  }
}

function logQueue(parts) {
  console.log(`[sync-queue] ${parts.join(' ')}`);
}

/**
 * 扫描授权店铺并入队（同店 running/queued/retry_wait 不重复）
 * @param {import('mysql2/promise').Pool} pool
 */
async function runSyncSchedulerTick(pool) {
  await releaseExpiredLocks(pool);
  await recoverStaleSyncStatusOnce(pool);

  const shops = await loadShopsForOpenApiCollect();
  let enqueued = 0;
  let skipped = 0;

  for (const shop of shops) {
    const tid = Number(shop.tenant_id ?? shop.tenantId);
    const sid = Number(shop.internal_shop_id);
    const platform = String(shop.platform || 'tiktok');
    if (!Number.isFinite(tid) || tid <= 0 || !Number.isFinite(sid) || sid <= 0) {
      skipped += 1;
      continue;
    }

    await ensureShopSyncStatusRow(pool, { tenant_id: tid, shop_id: sid, platform });

    if (await hasActiveJobForShop(pool, { tenant_id: tid, shop_id: sid, platform })) {
      skipped += 1;
      continue;
    }

    const out = await enqueueShopSyncJob(pool, {
      tenant_id: tid,
      shop_id: sid,
      platform,
      job_type: 'shop_orders',
      priority: 100,
    });
    if (out.created) {
      enqueued += 1;
      await appendSyncLog({
        tenant_id: tid,
        shop_id: sid,
        platform,
        sync_job_id: out.jobId,
        level: 'info',
        message: 'job_enqueued',
      });
    } else {
      skipped += 1;
    }
  }

  logQueue([`tick shops=${shops.length}`, `enqueued=${enqueued}`, `skipped=${skipped}`]);
  return { enqueued, skipped, shops: shops.length };
}

/**
 * 启动定时 scheduler
 */
function startSyncScheduler(opts = {}) {
  if (!opts.schemaReady) {
    return () => {};
  }

  const pool = getMysqlPool();
  if (!pool) {
    console.error('[sync-queue] mysql_unavailable — scheduler not started');
    return () => {};
  }

  const { syncSchedulerIntervalMs } = require('../services/syncEnv');
  const intervalMs = syncSchedulerIntervalMs();

  schedulerPaused = false;
  schedulerPauseLogged = false;

  const tick = () => {
    if (schedulerPaused) return;
    void runSyncSchedulerTick(pool).catch((e) => {
      if (isMissingSyncTableError(e)) {
        schedulerPaused = true;
        if (!schedulerPauseLogged) {
          const sqlTag = e?.sqlTag || 'scheduler_tick';
          const table = e?.sqlTable || 'unknown';
          console.log(
            `[sync-queue] scheduler paused reason=schema_invalid sqlTag=${sqlTag} table=${table} error=${e?.message || e}`,
          );
          schedulerPauseLogged = true;
        }
        return;
      }
      if (!e?.sqlTagLogged) {
        logSyncSqlError('scheduler_tick', 'unknown', e);
      }
    });
  };

  tick();
  const timer = setInterval(tick, intervalMs);
  console.log(`[sync-queue] scheduled intervalMs=${intervalMs}`);
  logQueue([`scheduler intervalMs=${intervalMs}`]);
  return () => clearInterval(timer);
}

module.exports = { runSyncSchedulerTick, startSyncScheduler };
