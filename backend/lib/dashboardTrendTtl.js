'use strict';

/** gmv-compare / order-volume / trend 走 dashboard_trend_cache */
const TREND_CACHE_ENDPOINTS = new Set(['gmv-compare', 'order-volume', 'trend']);

function isTrendCacheEndpoint(endpoint) {
  return TREND_CACHE_ENDPOINTS.has(String(endpoint || ''));
}

/**
 * 趋势类端点 TTL：today/yesterday 60–90s；last7/last30/custom 5–10min
 * @param {import('../modules/dashboard/filterContract').DashboardFilterContract} [contract]
 */
function trendCacheTtlMs(contract) {
  const tr = String(contract?.timeRange || 'today').trim().toLowerCase();
  if (tr === 'last7' || tr === 'last30' || tr === 'custom') {
    const raw = Number(process.env.DASHBOARD_TREND_TTL_RANGE_MS);
    let n = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 300_000;
    return Math.min(600_000, Math.max(300_000, n));
  }
  const raw = Number(process.env.DASHBOARD_TREND_TTL_TODAY_MS);
  if (Number.isFinite(raw) && raw > 0) {
    return Math.min(120_000, Math.max(60_000, Math.floor(raw)));
  }
  return 90_000;
}

module.exports = { TREND_CACHE_ENDPOINTS, isTrendCacheEndpoint, trendCacheTtlMs };
