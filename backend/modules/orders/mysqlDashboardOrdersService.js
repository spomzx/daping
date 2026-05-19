'use strict';

const dayjs = require('dayjs');
const { getMysqlPool } = require('../../db/mysqlPool');
const { getTimeRangeBounds } = require('../../lib/dashboardTimeRange');
const { orderAnalyticsEventTimeExpr } = require('../../lib/analyticsFilter');
const DEFAULT_LIMIT = Math.min(50000, Math.max(1000, Number(process.env.DASHBOARD_MYSQL_ORDER_LIMIT || 20000)));

/**
 * MySQL orders 行 → orders-cache 聚合所需结构（优先 raw_json）
 * @param {Record<string, unknown>} row
 */
function mysqlRowToCacheOrder(row) {
  if (row.raw_json) {
    try {
      const parsed = JSON.parse(String(row.raw_json));
      if (parsed && typeof parsed === 'object') {
        const o = parsed;
        if (!o.shopId && row.platform_shop_id) {
          o.shopId = String(row.platform_shop_id).trim().toLowerCase();
        }
        if (row.shop_id != null) o.internal_shop_id = Number(row.shop_id);
        if (row.platform_shop_id) o.platform_shop_id = String(row.platform_shop_id).trim();
        return o;
      }
    } catch {
      /* fallback columns */
    }
  }
  const pid = String(row.platform_shop_id ?? '').trim().toLowerCase();
  let createTime = row.created_at_platform;
  if (createTime instanceof Date) createTime = createTime.toISOString();
  const internalId = row.shop_id != null ? Number(row.shop_id) : null;
  return {
    orderId: String(row.platform_order_id || ''),
    id: String(row.platform_order_id || ''),
    internal_shop_id: internalId,
    platform_shop_id: pid,
    shopId: pid,
    shop_id: pid,
    shopName: String(row.shop_name || ''),
    shop_name: String(row.shop_name || ''),
    region: String(row.market || ''),
    market: String(row.market || ''),
    orderStatus: String(row.order_status || ''),
    status: String(row.order_status || ''),
    currency: String(row.currency || ''),
    customerName: String(row.buyer_name || ''),
    orderAmountBase: Number(row.total_amount) || 0,
    totalAmount: Number(row.total_amount) || 0,
    createTime: createTime != null ? String(createTime) : '',
    create_time: createTime != null ? String(createTime) : '',
  };
}

/**
 * 大屏主数据源：从 MySQL orders 读取（按时间窗 + 可选 tenant shop gate）
 * @param {{
 *   mysqlGate: import('../../lib/dashboardShopGate').loadMysqlShopGateForTenant extends Function ? object : null,
 *   auth?: { scope?: string, role?: string },
 *   range?: string,
 *   startDate?: string,
 *   endDate?: string,
 *   limit?: number,
 * }} opts
 */
async function loadDashboardOrdersFromMysql(opts = {}) {
  const pool = getMysqlPool();
  if (!pool) {
    return { orders: [], updatedAt: null, source: 'mysql_unavailable', rowCount: 0 };
  }

  const mysqlGate = opts.mysqlGate ?? null;
  const range = opts.range != null ? String(opts.range) : 'today';
  const bounds = getTimeRangeBounds(range, opts.startDate, opts.endDate);
  const fromDt = dayjs.unix(bounds.startSec).format('YYYY-MM-DD HH:mm:ss.SSS');
  const toDt = dayjs.unix(bounds.endSec).format('YYYY-MM-DD HH:mm:ss.SSS');
  const limit = Math.min(DEFAULT_LIMIT, Math.max(1, Number(opts.limit) || DEFAULT_LIMIT));

  if (mysqlGate && mysqlGate.shopIdSet && mysqlGate.shopIdSet.size === 0) {
    return {
      orders: [],
      updatedAt: dayjs().format('YYYY-MM-DD HH:mm:ss'),
      source: 'mysql',
      rowCount: 0,
    };
  }

  const params = [fromDt, toDt];
  let tenantClause = '';
  if (mysqlGate && Number.isFinite(Number(mysqlGate.tenantId))) {
    tenantClause = ' AND o.tenant_id = ? ';
    params.push(Number(mysqlGate.tenantId));
  }

  let shopClause = '';
  if (mysqlGate && mysqlGate.shopIdSet && mysqlGate.shopIdSet.size > 0) {
    const ids = [...mysqlGate.shopIdSet];
    shopClause = ` AND LOWER(TRIM(s.platform_shop_id)) IN (${ids.map(() => '?').join(',')})`;
    params.push(...ids);
  }

  const evt = orderAnalyticsEventTimeExpr('o');
  const sql = `
    SELECT
      o.id, o.tenant_id, o.shop_id, o.platform, o.platform_order_id,
      o.shop_name, o.market, o.currency, o.buyer_name, o.order_status,
      o.analytics_status, o.total_amount, o.created_at_platform, o.paid_at, o.raw_json,
      o.updated_at,
      s.platform_shop_id
    FROM orders o
    LEFT JOIN shops s ON s.id = o.shop_id
    WHERE ${evt} IS NOT NULL
      AND ${evt} >= ?
      AND ${evt} <= ?
      ${tenantClause}
      ${shopClause}
    ORDER BY ${evt} DESC
    LIMIT ?
  `;
  params.push(limit);

  const [rows] = await pool.query(sql, params);
  const list = Array.isArray(rows) ? rows : [];
  const orders = list.map((r) => mysqlRowToCacheOrder(r));

  let maxUpdated = null;
  for (const r of list) {
    const u = r.updated_at;
    if (!u) continue;
    const t = dayjs(u);
    if (t.isValid() && (!maxUpdated || t.isAfter(maxUpdated))) maxUpdated = t;
  }

  return {
    orders,
    updatedAt: (maxUpdated || dayjs()).format('YYYY-MM-DD HH:mm:ss'),
    source: 'mysql',
    rowCount: orders.length,
  };
}

/**
 * @deprecated legacy war-room only (`routes/legacyDashboardRoutes.js`).
 * SaaS `/api/dashboard/*` 模块始终 MySQL Only，不受 `DASHBOARD_DATA_SOURCE` 影响。
 */
function isMysqlPrimaryDashboard() {
  return String(process.env.DASHBOARD_DATA_SOURCE || 'mysql').trim().toLowerCase() !== 'cache';
}

module.exports = {
  loadDashboardOrdersFromMysql,
  mysqlRowToCacheOrder,
  isMysqlPrimaryDashboard,
};
