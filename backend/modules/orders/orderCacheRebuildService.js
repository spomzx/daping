'use strict';

const fs = require('fs');
const dayjs = require('dayjs');
const { getMysqlPool } = require('../../db/mysqlPool');
const { isPlatformScope } = require('../../lib/userScope');
const { loadMysqlShopGateForTenant } = require('../../lib/dashboardShopGate');
const { loadPlatformReconcileGate } = require('./orderReconcileService');
const { orderAnalyticsEventTimeExpr } = require('../../lib/analyticsFilter');
const { mysqlRowToCacheOrder } = require('./mysqlDashboardOrdersService');
const { atomicWriteJsonSync } = require('../../lib/storageFile');
const { ORDERS_CACHE_PATH, STORAGE_DIR, cacheFileStats } = require('../../lib/ordersCachePath');

function rebuildWindowHours() {
  const h = Number(process.env.CACHE_REBUILD_WINDOW_HOURS || 720);
  return Number.isFinite(h) && h > 0 ? Math.min(2160, Math.max(24, h)) : 720;
}

/**
 * 从 MySQL 重建 orders-cache.json（与 OpenAPI worker 写盘格式兼容）
 * @param {number} tenantId
 * @param {object} auth
 */
async function rebuildOrdersCacheFromMysql(tenantId, auth) {
  const pool = getMysqlPool();
  if (!pool) {
    throw Object.assign(new Error('mysql_unavailable'), { code: 'mysql_unavailable' });
  }

  const platformMode = isPlatformScope(auth);
  let gate;
  if (platformMode) {
    gate = await loadPlatformReconcileGate(pool);
  } else {
    gate = await loadMysqlShopGateForTenant(Number(tenantId), { skipDashboardLog: true });
    if (!gate) {
      throw Object.assign(new Error('mysql_unavailable'), { code: 'mysql_unavailable' });
    }
    const [idRows] = await pool.query(
      `SELECT id FROM shops WHERE tenant_id = ? AND status = 'active' AND hidden = 0`,
      [Number(tenantId)],
    );
    gate.shopDbIds = (Array.isArray(idRows) ? idRows : []).map((r) => Number(r.id)).filter(Boolean);
  }

  const shopDbIds = gate.shopDbIds || [];
  if (shopDbIds.length === 0) {
    const empty = { orders: [], updatedAt: dayjs().format('YYYY-MM-DD HH:mm:ss'), source: 'mysql_rebuild' };
    atomicWriteJsonSync(ORDERS_CACHE_PATH, empty);
    return { ok: true, ordersWritten: 0, cachePath: ORDERS_CACHE_PATH, ...cacheFileStats() };
  }

  const hours = rebuildWindowHours();
  const evt = orderAnalyticsEventTimeExpr('o');
  const ph = shopDbIds.map(() => '?').join(',');
  const tenantClause = platformMode
    ? ''
    : ' AND o.tenant_id = ? ';
  const params = platformMode ? [...shopDbIds, hours] : [...shopDbIds, Number(tenantId), hours];

  const sql = `
    SELECT o.*, s.platform_shop_id, s.shop_name, s.display_name, s.market, s.region
    FROM orders o
    LEFT JOIN shops s ON s.id = o.shop_id
    WHERE o.shop_id IN (${ph})
      ${tenantClause}
      AND ${evt} IS NOT NULL
      AND ${evt} >= DATE_SUB(NOW(3), INTERVAL ? HOUR)
    ORDER BY ${evt} DESC
    LIMIT 50000
  `;

  const [rows] = await pool.query(sql, params);
  const orders = [];
  const seen = new Set();
  for (const row of Array.isArray(rows) ? rows : []) {
    const pid = String(row.platform_order_id || '').trim();
    const platform = String(row.platform || 'tiktok').toLowerCase();
    const k = `${platform}::${pid}`;
    if (!pid || seen.has(k)) continue;
    seen.add(k);
    orders.push(mysqlRowToCacheOrder(row));
  }

  const payload = {
    orders,
    updatedAt: dayjs().format('YYYY-MM-DD HH:mm:ss'),
    source: 'mysql_rebuild',
    rebuiltFrom: 'mysql',
    windowHours: hours,
  };

  fs.mkdirSync(STORAGE_DIR, { recursive: true });
  atomicWriteJsonSync(ORDERS_CACHE_PATH, payload);

  const stats = cacheFileStats();
  return {
    ok: true,
    ordersWritten: orders.length,
    windowHours: hours,
    cachePath: ORDERS_CACHE_PATH,
    cache_file_path: ORDERS_CACHE_PATH,
    storage_dir: STORAGE_DIR,
    process_cwd: process.cwd(),
    ...stats,
  };
}

module.exports = {
  rebuildOrdersCacheFromMysql,
  ORDERS_CACHE_PATH,
  cacheFileStats,
};
