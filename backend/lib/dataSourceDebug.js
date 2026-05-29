'use strict';

const { orderAnalyticsEventTimeExpr } = require('../modules/dashboard/filterContract');

/**
 * 核心 API 统一 debug 块（MySQL-only）
 * @param {import('../modules/dashboard/filterContract').DashboardFilterContract} contract
 * @param {Record<string, unknown>} [extra]
 */
function buildDataSourceDebug(contract, extra = {}) {
  const filter = String(contract?.orderFilter || 'all');
  const timeRange = String(contract?.timeRange || 'today');
  const timeField = orderAnalyticsEventTimeExpr('o');
  const filterLabel =
    filter === 'valid'
      ? timeRange === 'today'
        ? 'VALID_ORDERS_TODAY'
        : `VALID_ORDERS_${timeRange}`.toUpperCase()
      : filter === 'all'
        ? timeRange === 'today'
          ? 'ALL_ORDERS_TODAY'
          : `ALL_ORDERS_${timeRange}`.toUpperCase()
        : filter === 'sample'
          ? timeRange === 'today'
            ? 'SAMPLE_ORDERS_TODAY'
            : `SAMPLE_ORDERS_${timeRange}`.toUpperCase()
          : `${filter}_orders_${timeRange}`.toUpperCase();

  const dateWindow =
    extra.dateWindow != null
      ? String(extra.dateWindow)
      : timeRange === 'today'
        ? 'CURDATE'
        : timeRange === 'yesterday'
          ? 'YESTERDAY'
          : timeRange === 'last7'
            ? 'LAST7_TO_CURDATE'
            : timeRange === 'last30'
              ? 'LAST30_TO_CURDATE'
              : 'CUSTOM_RANGE';

  const orderFilterApplied =
    extra.orderFilterApplied != null
      ? Boolean(extra.orderFilterApplied)
      : filter !== 'all';

  return {
    source: 'mysql',
    filter: filterLabel,
    orderFilter: filter,
    timeRange,
    table: 'orders',
    timeField,
    timeColumnExpr: timeField,
    dateWindow,
    timeWindow: dateWindow,
    orderFilterStatusSupported:
      extra.orderFilterStatusSupported != null
        ? Boolean(extra.orderFilterStatusSupported)
        : true,
    orderFilterApplied,
    note: '禁止 orders-cache.json / gmv-cache.json fallback',
    ...extra,
  };
}

module.exports = { buildDataSourceDebug };
