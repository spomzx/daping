'use strict';

const { parseDashboardFilterQuery, contractToAnalyticsQuery } = require('../modules/dashboard/filterContract');

function isDebugAuthorityEnabled() {
  if (process.env.DEBUG_AUTHORITY === '1') return true;
  const env = String(process.env.SAAS_ENV || process.env.NODE_ENV || '').toLowerCase();
  return env === 'staging' || env === 'development' || env === 'dev' || env === 'test';
}

/**
 * 统一 HTTP query → filterContract（含 hours/status/shop_id 兼容）。
 * @param {Record<string, unknown>} [raw]
 * @param {number|null} [tenantId]
 */
function parseAuthorityQuery(raw = {}, tenantId = null) {
  return parseDashboardFilterQuery(raw, tenantId);
}

/**
 * 契约 → 各 service 使用的 query 对象（保留 limit/sort 等 extra）。
 * @param {import('../modules/dashboard/filterContract').DashboardFilterContract} contract
 * @param {Record<string, unknown>} [raw]
 */
function mergeAuthorityServiceQuery(contract, raw = {}) {
  const base = contractToAnalyticsQuery(contract);
  const out = { ...base };
  for (const [k, v] of Object.entries(raw || {})) {
    if (v == null || String(v).trim() === '') continue;
    if (k === 'market' || k === 'region' || k === 'range' || k === 'timeRange') continue;
    if (k === 'orderFilter' || k === 'status' || k === 'orderStatus') continue;
    if (k === 'shopId' || k === 'shop_id' || k === 'selectedShopId') continue;
    if (k === 'hours') continue;
    out[k] = String(v);
  }
  return out;
}

/**
 * @param {Record<string, unknown>} raw
 * @param {number|null} tenantId
 */
function buildAuthorityServiceQuery(raw = {}, tenantId = null) {
  const contract = parseAuthorityQuery(raw, tenantId);
  return { contract, query: mergeAuthorityServiceQuery(contract, raw) };
}

/**
 * @param {import('../modules/dashboard/filterContract').DashboardFilterContract} contract
 * @param {string} source
 */
function buildDebugAuthority(contract, source) {
  return {
    source,
    normalizedQuery: {
      market: contract.market,
      range: contract.timeRange,
      orderFilter: contract.orderFilter,
      shopId: contract.shopId,
      startDate: contract.startDate || '',
      endDate: contract.endDate || '',
    },
  };
}

/**
 * @param {Record<string, unknown>} payload
 * @param {import('../modules/dashboard/filterContract').DashboardFilterContract} contract
 * @param {string} source
 */
function attachDebugAuthority(payload, contract, source) {
  if (!isDebugAuthorityEnabled()) return payload;
  return {
    ...payload,
    debugAuthority: buildDebugAuthority(contract, source),
  };
}

module.exports = {
  isDebugAuthorityEnabled,
  parseAuthorityQuery,
  mergeAuthorityServiceQuery,
  buildAuthorityServiceQuery,
  buildDebugAuthority,
  attachDebugAuthority,
};
