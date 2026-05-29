'use strict';

/**
 * Analytics 统一 WHERE：委托 dashboard filterContract，禁止滑动 hours 窗与字段混用。
 */

const { marketClauseOrdersOnly } = require('./analyticsMysqlScope');
const {
  parseDashboardFilterQuery,
  buildDashboardWhere,
  buildOrderFilterWhere,
  resolveShopClause,
  orderAnalyticsEventTimeExpr,
} = require('../modules/dashboard/filterContract');

function analyticsStatusCondition(alias, qStatus) {
  const { sql, params } = buildOrderFilterWhere(qStatus, alias);
  return { sql, params };
}

/**
 * @deprecated 仅兼容旧调用；新代码请用 parseDashboardFilterQuery + buildDashboardWhere
 */
function resolveHoursFromQuery(q) {
  const r = String(q.timeRange || q.range || '').toLowerCase();
  if (r === 'last7' || r === '7d') return 168;
  if (r === 'last30' || r === '30d') return 720;
  if (r === 'today' || r === 'yesterday') return 24;
  return 24;
}

/**
 * @param {import('mysql2/promise').Pool} pool
 * @param {number} tenantId
 * @param {Record<string, unknown>} q
 * @param {{ alias?: string, includeStatus?: boolean, skipTenant?: boolean, allTenantShops?: boolean }} [options]
 */
async function buildAnalyticsFilter(pool, tenantId, q, options = {}) {
  const contract = parseDashboardFilterQuery(q, tenantId);
  const alias = options.alias || 'o';
  const includeStatus = options.includeStatus !== false;

  if (q.analytics_time_from != null && contract.startSec == null) {
    const ts =
      q.analytics_time_from instanceof Date
        ? q.analytics_time_from.getTime()
        : Number(q.analytics_time_from);
    const d = Number.isFinite(ts) ? new Date(ts) : new Date(q.analytics_time_from);
    const te = orderAnalyticsEventTimeExpr(alias);
    const parts = [];
    const params = [];
    if (!options.skipTenant && tenantId != null && Number.isFinite(Number(tenantId))) {
      parts.push(`${alias}.tenant_id = ?`);
      params.push(Number(tenantId));
    }
    parts.push(`${te} >= ?`);
    params.push(d);
    parts.push(`${te} < NOW(3)`);
    const mkt = marketClauseOrdersOnly(alias, contract.market);
    if (mkt.sql) {
      parts.push(String(mkt.sql).replace(/^\s*AND\s+/i, '').trim());
      params.push(...mkt.params);
    }
    if (contract.shopId !== 'all') {
      const shop = await require('../modules/dashboard/filterContract').buildShopWhere(
        pool,
        tenantId,
        contract.shopId,
        alias,
        { allTenants: options.allTenantShops === true },
      );
      if (shop.invalidShop) return { sql: '', params: [], invalidShop: true };
      if (shop.sql) {
        parts.push(String(shop.sql).replace(/^\s*AND\s+/i, '').trim());
        params.push(...shop.params);
      }
    }
    if (includeStatus) {
      const st = buildOrderFilterWhere(contract.orderFilter, alias);
      if (st.sql) {
        parts.push(String(st.sql).replace(/^\s*AND\s+/i, '').trim());
        params.push(...st.params);
      }
    }
    const sql = parts.map((p) => `(${p})`).join(' AND ');
    return { sql: ` AND (${sql})`, params, invalidShop: false };
  }

  const partial = { ...contract };
  if (!includeStatus) {
    partial.orderFilter = 'all';
  }

  const out = await buildDashboardWhere(pool, tenantId, partial, {
    alias,
    includeStatus,
    skipTenant: options.skipTenant === true,
    allTenantShops: options.allTenantShops === true,
  });
  return out;
}

module.exports = {
  buildAnalyticsFilter,
  resolveShopClause,
  analyticsStatusCondition,
  resolveHoursFromQuery,
  orderAnalyticsEventTimeExpr,
};
