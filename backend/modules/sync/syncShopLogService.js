'use strict';

const { getMysqlPool } = require('../../db/mysqlPool');
const { runSyncSql, logSyncSqlError } = require('../../sync/services/syncSql');

function poolOrNull() {
  try {
    return getMysqlPool();
  } catch {
    return null;
  }
}

/**
 * @param {import('../lib/readSyncShops').SyncShopRecord|Record<string, unknown>} shop
 */
function shopLogIds(shop) {
  return {
    tenant_id: Number(shop.tenant_id) || null,
    shop_id: Number(shop.internal_shop_id ?? shop.shop_id) || null,
    platform_shop_id: String(shop.platform_shop_id || shop.shopId || '').trim() || null,
    platform: String(shop.platform || 'tiktok').trim() || 'tiktok',
  };
}

/**
 * @param {import('mysql2/promise').Pool} pool
 * @param {ReturnType<typeof shopLogIds>} ids
 */
async function beginShopSyncLog(pool, ids) {
  const [result] = await runSyncSql(pool, {
    tag: 'begin_shop_sync_log',
    table: 'sync_shop_logs',
    sql: `INSERT INTO sync_shop_logs (
      tenant_id, shop_id, platform_shop_id, platform, status,
      started_at, created_at
    ) VALUES (?, ?, ?, ?, 'running', CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))`,
    params: [ids.tenant_id, ids.shop_id, ids.platform_shop_id, ids.platform],
  });
  return Number(result?.insertId) || null;
}

/**
 * @param {import('mysql2/promise').Pool} pool
 * @param {number|null} logId
 * @param {{
 *   status: string,
 *   fetched_orders_count?: number,
 *   inserted_orders_count?: number,
 *   updated_orders_count?: number,
 *   failed_orders_count?: number,
 *   duration_ms?: number,
 *   error_message?: string,
 *   message?: string,
 * }} patch
 */
async function finishShopSyncLog(pool, logId, patch) {
  if (!logId || !Number.isFinite(Number(logId))) return;
  const fetched = Number(patch.fetched_orders_count) || 0;
  const inserted = Number(patch.inserted_orders_count) || 0;
  const updated = Number(patch.updated_orders_count) || 0;
  const failed = Number(patch.failed_orders_count) || 0;
  const duration = patch.duration_ms != null ? Number(patch.duration_ms) : null;
  const errMsg = patch.error_message != null ? String(patch.error_message).slice(0, 4000) : null;
  const msg = patch.message != null ? String(patch.message).slice(0, 2000) : errMsg;

  await runSyncSql(pool, {
    tag: 'finish_shop_sync_log',
    table: 'sync_shop_logs',
    sql: `UPDATE sync_shop_logs SET
      status = ?,
      message = ?,
      error_message = ?,
      orders_fetched = ?,
      fetched_orders_count = ?,
      inserted_orders_count = ?,
      updated_orders_count = ?,
      failed_orders_count = ?,
      duration_ms = ?,
      finished_at = CURRENT_TIMESTAMP(3)
     WHERE id = ?`,
    params: [
      String(patch.status || 'failed').slice(0, 32),
      msg,
      errMsg,
      fetched,
      fetched,
      inserted,
      updated,
      failed,
      Number.isFinite(duration) ? duration : null,
      Number(logId),
    ],
  });
}

/**
 * @param {Record<string, unknown>} shop
 * @returns {Promise<number|null>}
 */
async function startShopSyncLog(shop) {
  const pool = poolOrNull();
  if (!pool) return null;
  try {
    return await beginShopSyncLog(pool, shopLogIds(shop));
  } catch (e) {
    logSyncSqlError('start_shop_sync_log', 'sync_shop_logs', e);
    return null;
  }
}

/**
 * @param {number|null} logId
 * @param {Record<string, unknown>} shop
 * @param {Parameters<typeof finishShopSyncLog>[2]} patch
 */
async function endShopSyncLog(logId, shop, patch) {
  const pool = poolOrNull();
  if (!pool || !logId) return;
  try {
    await finishShopSyncLog(pool, logId, patch);
  } catch (e) {
    logSyncSqlError('end_shop_sync_log', 'sync_shop_logs', e, {
      logId,
      shop_id: shopLogIds(shop).shop_id,
    });
  }
}

module.exports = {
  shopLogIds,
  beginShopSyncLog,
  finishShopSyncLog,
  startShopSyncLog,
  endShopSyncLog,
};
