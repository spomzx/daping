'use strict';

/**
 * 跨 dashboard / analytics / orders 的统一 KPI 组合（仅编排，SQL 仍在 orderMetricsService）。
 * 禁止 require dashboard/service，避免与 metricRepository 形成环。
 */

function normalizeSummaryRange(query = {}) {
  const out = { ...(query || {}) };
  const hasExplicitRange =
    (out.range != null && String(out.range).trim() !== '') ||
    (out.timeRange != null && String(out.timeRange).trim() !== '');
  if (hasExplicitRange) return out;
  const h = Number(out.hours);
  if (h === 24) out.range = 'today';
  else if (h === 168) out.range = '7d';
  else if (h === 720) out.range = '30d';
  return out;
}

function withOrderFilter(query, orderFilter) {
  return {
    ...query,
    status: orderFilter,
    orderFilter,
  };
}

async function getUnifiedSummary(tenantId, query, auth) {
  const metricService = require('../modules/analytics/metricService');
  const normalizedQuery = normalizeSummaryRange(query || {});
  const [summary, trend, sample, cancelled] = await Promise.all([
    metricService.getDashboardSummary(tenantId, normalizedQuery, auth),
    metricService.getDashboardTrend(tenantId, normalizedQuery, auth),
    metricService.getDashboardSummary(tenantId, withOrderFilter(normalizedQuery, 'sample'), auth),
    metricService.getDashboardSummary(tenantId, withOrderFilter(normalizedQuery, 'cancelled'), auth),
  ]);

  const trends = Array.isArray(trend?.rows) ? trend.rows : [];
  return {
    orders: Number(summary?.orders) || 0,
    gmv: Number(summary?.gmv) || 0,
    shops: Number(summary?.shop_count) || 0,
    trends,
    sample_orders: Number(sample?.orders) || 0,
    cancelled_orders: Number(cancelled?.orders) || 0,
    gmv_currency: summary?.gmv_currency || 'USD',
    source: 'metricService',
    summary_source: 'analytics.summaryService',
    debug: summary?.debug || null,
  };
}

module.exports = {
  normalizeSummaryRange,
  withOrderFilter,
  getUnifiedSummary,
};
