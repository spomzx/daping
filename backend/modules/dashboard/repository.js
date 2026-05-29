'use strict';

const { strictAnalyticsFilterOpts } = require('../../lib/resolveTenantShop');
const {
  parseDashboardFilterQuery,
  logDashboardContract,
} = require('./filterContract');
const { getTodayOrderSummary } = require('../../services/orderMetricsService');

function afOpts(_auth) {
  return strictAnalyticsFilterOpts();
}

/**
 * @param {import('mysql2/promise').Pool} pool
 * @param {number} tenantId
 * @param {{ hours?: number, market?: string, shop_id?: string, status?: string }} q
 * @param {unknown} auth
 */
async function querySummary(pool, tenantId, q, auth) {
  const contract = parseDashboardFilterQuery(q, tenantId);
  const snap = await getTodayOrderSummary(tenantId, q, auth);

  logDashboardContract('summary', contract, { orders: snap.orders, gmv: snap.gmv });
  return {
    orders: snap.orders,
    gmv: snap.gmv,
    shop_count: snap.shop_count,
    timeRange: contract.timeRange,
    range: contract.timeRange,
    source: 'mysql',
    gmv_currency: snap.gmv_currency || 'USD',
    debug: snap.debug,
  };
}

module.exports = { querySummary, afOpts };
