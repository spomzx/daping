'use strict';

const { maxAttempts } = require('./syncRetryPolicy');
const { runSyncSql } = require('./syncSql');

const ACTIVE_STATUSES = ['queued', 'running', 'retry_wait'];

/**
 * @param {import('mysql2/promise').Pool} pool
 * @param {{ tenant_id: number, shop_id: number, platform?: string, job_type?: string, priority?: number }} input
 */
async function hasActiveJobForShop(pool, input) {
  const tid = Number(input.tenant_id);
  const sid = Number(input.shop_id);
  const platform = String(input.platform || 'tiktok');
  const [rows] = await runSyncSql(pool, {
    tag: 'has_active_job',
    table: 'sync_jobs',
    sql: `SELECT id FROM sync_jobs
     WHERE tenant_id = ? AND shop_id = ? AND platform = ?
       AND status IN ('queued', 'running', 'retry_wait')
     LIMIT 1`,
    params: [tid, sid, platform],
  });
  return Array.isArray(rows) && rows.length > 0;
}

/**
 * @param {import('mysql2/promise').Pool} pool
 * @param {{ tenant_id: number, shop_id: number, platform?: string, job_type?: string, priority?: number }} input
 */
async function enqueueShopSyncJob(pool, input) {
  const tid = Number(input.tenant_id);
  const sid = Number(input.shop_id);
  const platform = String(input.platform || 'tiktok');
  const jobType = String(input.job_type || 'shop_orders').slice(0, 64);
  const priority = Number.isFinite(Number(input.priority)) ? Number(input.priority) : 100;

  if (await hasActiveJobForShop(pool, input)) {
    return { created: false, reason: 'duplicate_active_job' };
  }

  const [res] = await runSyncSql(pool, {
    tag: 'enqueue_job',
    table: 'sync_jobs',
    sql: `INSERT INTO sync_jobs
      (tenant_id, shop_id, platform, job_type, status, priority, attempt_count, max_attempts)
     VALUES (?, ?, ?, ?, 'queued', ?, 0, ?)`,
    params: [tid, sid, platform, jobType, priority, maxAttempts()],
  });
  return { created: true, jobId: res?.insertId };
}

/**
 * @param {import('mysql2/promise').Pool} pool
 * @param {string} workerId
 */
async function claimNextJob(pool, workerId) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await runSyncSql(conn, {
      tag: 'claim_next_job',
      table: 'sync_jobs',
      sql: `SELECT id, tenant_id, shop_id, platform, job_type, status, priority,
              attempt_count, max_attempts
       FROM sync_jobs
       WHERE status IN ('queued', 'retry_wait')
         AND (next_retry_at IS NULL OR next_retry_at <= NOW(3))
       ORDER BY priority DESC, id ASC
       LIMIT 1
       FOR UPDATE SKIP LOCKED`,
      params: [],
    });
    const job = rows?.[0];
    if (!job) {
      await conn.commit();
      return null;
    }
    await runSyncSql(conn, {
      tag: 'claim_mark_running',
      table: 'sync_jobs',
      sql: `UPDATE sync_jobs
       SET status = 'running', locked_by = ?, locked_at = NOW(3), started_at = NOW(3), updated_at = NOW(3)
       WHERE id = ? AND tenant_id = ?`,
      params: [workerId, job.id, job.tenant_id],
    });
    await conn.commit();
    return job;
  } catch (e) {
    try {
      await conn.rollback();
    } catch (_) {}
    throw e;
  } finally {
    conn.release();
  }
}

/**
 * @param {import('mysql2/promise').Pool} pool
 * @param {number} tenantId
 * @param {number} jobId
 * @param {Record<string, unknown>} patch
 */
async function updateJob(pool, tenantId, jobId, patch) {
  const sets = [];
  const params = [];
  const allowed = [
    'status',
    'attempt_count',
    'finished_at',
    'next_retry_at',
    'error_message',
    'locked_by',
    'locked_at',
    'started_at',
  ];
  for (const key of allowed) {
    if (Object.prototype.hasOwnProperty.call(patch, key)) {
      sets.push(`${key} = ?`);
      params.push(patch[key]);
    }
  }
  if (!sets.length) return;
  sets.push('updated_at = NOW(3)');
  params.push(jobId, tenantId);
  await runSyncSql(pool, {
    tag: 'update_job',
    table: 'sync_jobs',
    sql: `UPDATE sync_jobs SET ${sets.join(', ')} WHERE id = ? AND tenant_id = ?`,
    params,
  });
}

/**
 * @param {import('mysql2/promise').Pool} pool
 * @param {import('../../lib/dataScope').UserDataScope} scope
 * @param {number} tenantId
 * @param {Record<string, string>} query
 */
async function listJobsForTenant(pool, scope, tenantId, query = {}) {
  const tid = Number(tenantId);
  if (!Number.isFinite(tid) || tid <= 0) return [];

  const params = [tid];
  let sql = `SELECT j.id, j.tenant_id, j.shop_id, j.platform, j.job_type, j.status, j.priority,
                    j.attempt_count, j.max_attempts, j.locked_by, j.locked_at, j.started_at, j.finished_at,
                    j.next_retry_at, j.error_message, j.created_at, j.updated_at,
                    s.shop_name, s.platform_shop_id,
                    TIMESTAMPDIFF(MICROSECOND, j.started_at, COALESCE(j.finished_at, NOW(3))) / 1000 AS duration_ms
             FROM sync_jobs j
             INNER JOIN shops s ON s.id = j.shop_id AND s.tenant_id = j.tenant_id
             WHERE j.tenant_id = ?`;

  if (scope?.mode === 'tenant_assigned') {
    const ids = Array.isArray(scope.shopIds) ? scope.shopIds : [];
    if (!ids.length) return [];
    sql += ` AND j.shop_id IN (${ids.map(() => '?').join(',')})`;
    params.push(...ids);
  } else if (!scope || scope.mode === 'none') {
    return [];
  }

  const status = String(query.status || '').trim();
  if (status) {
    sql += ' AND j.status = ?';
    params.push(status);
  }
  const shopId = String(query.shop_id || query.shopId || '').trim();
  if (shopId) {
    sql += ' AND (j.shop_id = ? OR s.platform_shop_id = ?)';
    params.push(shopId, shopId);
  }

  const limit = Math.min(200, Math.max(1, Number(query.limit) || 50));
  sql += ' ORDER BY j.id DESC LIMIT ?';
  params.push(limit);

  const [rows] = await runSyncSql(pool, {
    tag: 'list_jobs',
    table: 'sync_jobs',
    sql,
    params,
  });
  return Array.isArray(rows) ? rows : [];
}

module.exports = {
  ACTIVE_STATUSES,
  hasActiveJobForShop,
  enqueueShopSyncJob,
  claimNextJob,
  updateJob,
  listJobsForTenant,
};
