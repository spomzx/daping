'use strict';

const { buildAnalyticsFilter } = require('../../lib/analyticsFilter');
const { isPlatformScope } = require('../../lib/userScope');
const { getUserScope, buildOrderScopeWhere } = require('../../lib/dataScope');

function afOpts(auth) {
  const skip = Boolean(auth && isPlatformScope(auth));
  return { skipTenant: skip, allTenantShops: skip };
}

/**
 * @param {import('mysql2/promise').Pool} pool
 * @param {number} tenantId
 * @param {Record<string, unknown>} q
 * @param {unknown} auth
 */
async function mergeOrderFilter(pool, tenantId, q, auth) {
  const scope = await getUserScope(pool, auth);
  const orderScope = buildOrderScopeWhere('o', scope);
  if (orderScope.empty) {
    return { invalidShop: true, empty: true, sql: '', params: [] };
  }
  const af = await buildAnalyticsFilter(pool, tenantId, q, { ...afOpts(auth), alias: 'o' });
  if (af.invalidShop) {
    return { invalidShop: true, empty: false, sql: '', params: [] };
  }
  return {
    invalidShop: false,
    empty: false,
    sql: `${af.sql}${orderScope.sql}`,
    params: [...af.params, ...orderScope.params],
    scope,
  };
}

/**
 * @param {import('mysql2/promise').Pool} pool
 * @param {number} tenantId
 * @param {Record<string, unknown>} q
 * @param {unknown} auth
 */
/**
 * @param {import('mysql2/promise').Pool} pool
 * @param {number} tenantId
 * @param {Record<string, unknown>} q
 * @param {unknown} auth
 */
async function listOrders(pool, tenantId, q, auth) {
  const page = Math.max(1, Number(q.page) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(q.page_size || q.pageSize) || 30));
  const offset = (page - 1) * pageSize;

  const merged = await mergeOrderFilter(pool, tenantId, q, auth);
  if (merged.invalidShop || merged.empty) {
    return { items: [], total: 0, page, page_size: pageSize };
  }

  const [countRows] = await pool.query(
    `SELECT COUNT(*) AS c FROM orders o WHERE 1=1${merged.sql}`,
    merged.params,
  );
  const total = Number(countRows?.[0]?.c) || 0;

  const [rows] = await pool.query(
    `SELECT o.id, o.tenant_id, o.shop_id, o.platform_shop_id, o.platform_order_id,
            o.shop_name, o.market, o.currency, o.buyer_name, o.order_status,
            o.analytics_status, o.total_amount, o.created_at_platform, o.paid_at, o.updated_at
     FROM orders o
     WHERE 1=1${merged.sql}
     ORDER BY o.created_at_platform DESC, o.id DESC
     LIMIT ? OFFSET ?`,
    [...merged.params, pageSize, offset],
  );

  return {
    items: Array.isArray(rows) ? rows : [],
    total,
    page,
    page_size: pageSize,
  };
}

/**
 * @param {import('mysql2/promise').Pool} pool
 * @param {number} tenantId
 * @param {string} orderKey
 * @param {unknown} auth
 */
async function getOrderDetail(pool, tenantId, orderKey, auth) {
  const key = String(orderKey || '').trim();
  const scope = await getUserScope(pool, auth);
  if (scope.mode === 'none') return null;

  const fo = afOpts(auth);
  const tenantClause = fo.skipTenant ? '' : ' AND o.tenant_id = ? ';
  const baseParams = fo.skipTenant ? [key, key] : [key, key, tenantId];
  const orderScope = buildOrderScopeWhere('o', scope);
  if (orderScope.empty) return null;

  const params = [...baseParams, ...orderScope.params];
  const [rows] = await pool.query(
    `SELECT o.* FROM orders o
     WHERE (o.platform_order_id = ? OR CAST(o.id AS CHAR) = ?)${tenantClause}${orderScope.sql}
     LIMIT 1`,
    params,
  );
  const order = rows?.[0] || null;
  if (!order) return null;

  const [items] = await pool.query(
    `SELECT id, sku_id, sku_name, product_id, product_name, quantity, total_amount, currency, market
     FROM order_items
     WHERE platform_order_id = ? AND tenant_id = ?
     ORDER BY id ASC`,
    [order.platform_order_id, order.tenant_id],
  );

  return { order, items: Array.isArray(items) ? items : [] };
}

module.exports = { listOrders, getOrderDetail };
