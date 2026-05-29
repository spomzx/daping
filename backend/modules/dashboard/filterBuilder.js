'use strict';

/**
 * 大屏统一订单状态 WHERE（dashboard 契约 API 专用）。
 *
 * orderFilter=paid：valid + 已付款后取消（见 orderFilter.mysqlDashboardOrdersFilterClause）；与 valid 视图分离。
 * orderFilter=all：不筛 analytics_status；GMV 仍仅计 valid 行（见 dashboardGmvNativeSumExpr）。
 *
 * MySQL `orders` 实列：
 * - analytics_status VARCHAR(20) — 入库时 deriveAnalyticsStatusFromOrder 写入；**主查询仅用此列**
 * - order_status VARCHAR(64) — 仅 analytics_status IS NULL 时兜底（不扫 raw_json）
 * - raw_json — 禁止进入 dashboard 默认 WHERE
 */

const {
  normalizeOrderFilter,
  mysqlDashboardOrdersFilterClause,
  orderFilterExcludesGmv,
} = require('../../lib/orderFilter');

/**
 * @param {unknown} orderFilter - all | valid | unpaid | sample | cancelled | paid
 * @param {string} [alias='o'] - orders 表别名
 * @returns {{ sql: string, params: unknown[], filter: string, statusField: string }}
 */
function buildOrderFilterWhere(orderFilter, alias = 'o') {
  const filter = normalizeOrderFilter(orderFilter);
  if (filter === 'all') {
    return { sql: '', params: [], filter, statusField: 'none' };
  }
  const { sql, params, statusField } = mysqlDashboardOrdersFilterClause(alias, filter);
  return {
    sql: sql && String(sql).trim() ? String(sql) : '',
    params: Array.isArray(params) ? params : [],
    filter,
    statusField: statusField || `${alias}.analytics_status`,
  };
}

/**
 * @param {string} endpoint
 * @param {Record<string, unknown>} q
 * @param {Record<string, string|number>} [meta]
 */
function logDashboardFilterLine(endpoint, q, meta = {}) {
  const { parseDashboardFilterQuery, logDashboardContract } = require('./filterContract');
  const contract = parseDashboardFilterQuery(q);
  logDashboardContract(endpoint, contract, meta);
}

/**
 * GMV 聚合：orderFilter=all 时订单数含 cancelled，GMV 仅计 analytics_status=valid。
 * @param {unknown} orderFilter
 * @param {string} [alias='o']
 */
/**
 * order_items 联结排行 GMV（all 时仅计父单 analytics_status=valid）
 * @param {unknown} orderFilter
 * @param {string} [orderAlias='o']
 * @param {string} [itemAlias='oi']
 */
function dashboardOrderItemGmvSumExpr(orderFilter, orderAlias = 'o', itemAlias = 'oi') {
  const filter = normalizeOrderFilter(orderFilter);
  const o = String(orderAlias || 'o').trim() || 'o';
  const oi = String(itemAlias || 'oi').trim() || 'oi';
  if (orderFilterExcludesGmv(filter)) return '0';
  if (filter === 'all') {
    return `SUM(CASE WHEN ${o}.analytics_status = 'valid' THEN ${oi}.total_amount ELSE 0 END)`;
  }
  return `SUM(${oi}.total_amount)`;
}

function dashboardGmvNativeSumExpr(orderFilter, alias = 'o') {
  const filter = normalizeOrderFilter(orderFilter);
  const a = String(alias || 'o').trim() || 'o';
  if (orderFilterExcludesGmv(filter)) return '0';
  if (filter === 'all') {
    return `COALESCE(SUM(CASE WHEN ${a}.analytics_status = 'valid' THEN ${a}.total_amount ELSE 0 END), 0)`;
  }
  return `COALESCE(SUM(${a}.total_amount), 0)`;
}

module.exports = {
  buildOrderFilterWhere,
  dashboardGmvNativeSumExpr,
  dashboardOrderItemGmvSumExpr,
  normalizeOrderFilter,
  logDashboardFilterLine,
};
