'use strict';

const { syncLockTimeoutMs } = require('../services/syncEnv');
const { patchShopSyncStatus } = require('../services/shopSyncStatusService');
const { runSyncSql } = require('../services/syncSql');

function logLock(parts) {
  console.log(`[sync-lock] ${parts.join(' ')}`);
}

/**
 * @param {import('mysql2/promise').Pool} pool
 * @param {{ tenant_id: number, shop_id: number, platform?: string, job_id?: number }} key
 * @param {string} workerId
 */
async function acquireShopSyncLock(pool, key, workerId) {
  const tid = Number(key.tenant_id);
  const sid = Number(key.shop_id);
  const platform = String(key.platform || 'tiktok');
  const timeoutMs = syncLockTimeoutMs();
  const jobId = key.job_id != null ? Number(key.job_id) : null;

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await runSyncSql(conn, {
      tag: 'lock_select',
      table: 'shop_sync_status',
      sql: `SELECT sync_lock_until, sync_status, current_job_id
       FROM shop_sync_status
       WHERE tenant_id = ? AND shop_id = ? AND platform = ?
       FOR UPDATE`,
      params: [tid, sid, platform],
    });
    const row = rows?.[0];
    const lockUntil = row?.sync_lock_until ? new Date(row.sync_lock_until).getTime() : 0;
    if (lockUntil > Date.now() && row?.sync_status === 'syncing') {
      await conn.rollback();
      logLock([`skip tenant=${tid}`, `shop=${sid}`, 'reason=locked']);
      return { acquired: false, reason: 'locked' };
    }

    const lockSec = Math.max(60, Math.ceil(timeoutMs / 1000));
    await runSyncSql(conn, {
      tag: 'lock_upsert',
      table: 'shop_sync_status',
      sql: `INSERT INTO shop_sync_status (shop_id, tenant_id, platform, sync_status, sync_lock_until, current_job_id)
       VALUES (?, ?, ?, 'syncing', DATE_ADD(NOW(3), INTERVAL ? SECOND), ?)
       ON DUPLICATE KEY UPDATE
         sync_status = 'syncing',
         sync_lock_until = DATE_ADD(NOW(3), INTERVAL ? SECOND),
         current_job_id = VALUES(current_job_id),
         updated_at = NOW(3)`,
      params: [sid, tid, platform, lockSec, Number.isFinite(jobId) ? jobId : null, lockSec],
    });
    await conn.commit();
    logLock([`acquired tenant=${tid}`, `shop=${sid}`, `worker=${workerId}`, `job=${jobId ?? '-'}`]);
    return { acquired: true };
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
 * @param {{ tenant_id: number, shop_id: number, platform?: string }} key
 */
async function releaseShopSyncLock(pool, key) {
  const tid = Number(key.tenant_id);
  const sid = Number(key.shop_id);
  const platform = String(key.platform || 'tiktok');
  await patchShopSyncStatus(pool, tid, sid, platform, {
    sync_lock_until: null,
    current_job_id: null,
  });
  logLock([`released tenant=${tid}`, `shop=${sid}`]);
}

/**
 * @param {import('mysql2/promise').Pool} pool
 */
async function releaseExpiredLocks(pool) {
  const [res] = await runSyncSql(pool, {
    tag: 'release_expired_locks',
    table: 'shop_sync_status',
    sql: `UPDATE shop_sync_status
     SET sync_status = IF(sync_status = 'syncing', 'idle', sync_status),
         sync_lock_until = NULL,
         current_job_id = NULL,
         updated_at = NOW(3)
     WHERE sync_lock_until IS NOT NULL AND sync_lock_until < NOW(3)`,
    params: [],
  });
  const n = res?.affectedRows ?? 0;
  if (n > 0) logLock([`expired_cleared count=${n}`]);
  return n;
}

module.exports = { acquireShopSyncLock, releaseShopSyncLock, releaseExpiredLocks };
