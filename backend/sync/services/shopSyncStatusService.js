'use strict';

const { runSyncSql } = require('./syncSql');

/**
 * @param {import('mysql2/promise').Pool} pool
 * @param {{ tenant_id: number, shop_id: number, platform?: string }} key
 */
async function ensureShopSyncStatusRow(pool, key) {
  const tid = Number(key.tenant_id);
  const sid = Number(key.shop_id);
  const platform = String(key.platform || 'tiktok');
  await runSyncSql(pool, {
    tag: 'ensure_shop_sync_status',
    table: 'shop_sync_status',
    sql: `INSERT IGNORE INTO shop_sync_status (shop_id, tenant_id, platform, sync_status)
     VALUES (?, ?, ?, 'idle')`,
    params: [sid, tid, platform],
  });
}

/**
 * @param {import('mysql2/promise').Pool} pool
 * @param {number} tenantId
 * @param {number} shopId
 * @param {string} [platform]
 * @param {Record<string, unknown>} patch
 */
async function patchShopSyncStatus(pool, tenantId, shopId, platform, patch) {
  const tid = Number(tenantId);
  const sid = Number(shopId);
  const plat = String(platform || 'tiktok');
  await ensureShopSyncStatusRow(pool, { tenant_id: tid, shop_id: sid, platform: plat });

  const sets = [];
  const params = [];
  const map = {
    sync_status: 'sync_status',
    last_sync_at: 'last_sync_at',
    last_success_sync_at: 'last_success_sync_at',
    last_error: 'last_error',
    last_error_code: 'last_error_code',
    sync_fail_count: 'sync_fail_count',
    is_token_valid: 'is_token_valid',
    token_expired_at: 'token_expired_at',
    current_job_id: 'current_job_id',
    sync_lock_until: 'sync_lock_until',
    avg_sync_ms: 'avg_sync_ms',
  };
  for (const [k, col] of Object.entries(map)) {
    if (Object.prototype.hasOwnProperty.call(patch, k)) {
      sets.push(`${col} = ?`);
      params.push(patch[k]);
    }
  }
  if (!sets.length) return;
  sets.push('updated_at = NOW(3)');
  params.push(sid, plat, tid);
  await runSyncSql(pool, {
    tag: 'patch_shop_sync_status',
    table: 'shop_sync_status',
    sql: `UPDATE shop_sync_status SET ${sets.join(', ')}
     WHERE shop_id = ? AND platform = ? AND tenant_id = ?`,
    params,
  });
}

/**
 * @param {import('mysql2/promise').Pool} pool
 * @param {number} tenantId
 * @param {number[]} shopIds
 */
async function listShopSyncStatusByShopIds(pool, tenantId, shopIds) {
  const tid = Number(tenantId);
  const ids = (Array.isArray(shopIds) ? shopIds : [])
    .map((x) => Number(x))
    .filter((n) => Number.isFinite(n) && n > 0);
  if (!ids.length) return new Map();

  const [rows] = await runSyncSql(pool, {
    tag: 'list_shop_sync_status',
    table: 'shop_sync_status',
    sql: `SELECT shop_id, tenant_id, platform, sync_status, last_sync_at, last_success_sync_at,
            last_error, last_error_code, sync_fail_count, is_token_valid, token_expired_at,
            current_job_id, sync_lock_until, avg_sync_ms, updated_at
     FROM shop_sync_status
     WHERE tenant_id = ? AND shop_id IN (${ids.map(() => '?').join(',')})`,
    params: [tid, ...ids],
  });
  const m = new Map();
  for (const r of Array.isArray(rows) ? rows : []) {
    m.set(Number(r.shop_id), r);
  }
  return m;
}

function mergeStatusIntoShopRow(shopRow, statusRow) {
  if (!statusRow) return shopRow;
  return {
    ...shopRow,
    sync_status: statusRow.sync_status,
    last_success_sync_at: statusRow.last_success_sync_at,
    sync_fail_count: statusRow.sync_fail_count,
    last_error: statusRow.last_error,
    last_error_full: statusRow.last_error,
    last_error_code: statusRow.last_error_code,
    is_token_valid: statusRow.is_token_valid,
    token_expired_at: statusRow.token_expired_at,
    queue_sync_status: statusRow.sync_status,
  };
}

module.exports = {
  ensureShopSyncStatusRow,
  patchShopSyncStatus,
  listShopSyncStatusByShopIds,
  mergeStatusIntoShopRow,
};
