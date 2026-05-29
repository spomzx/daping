'use strict';

const repo = require('./repository');
const { parseDashboardFilterQuery } = require('../dashboard/filterContract');

async function listOrders(tenantId, query, auth) {
  const contract = parseDashboardFilterQuery(query || {}, tenantId);
  const orders = await repo.listRealtimeOrders(tenantId, query || {}, auth);
  return {
    orders,
    realtimeWindow: {
      range: contract.timeRange,
      startSec: contract.startSec,
      endSec: contract.endSec,
      orderFilter: contract.orderFilter,
      market: contract.market,
      shopId: contract.shopId,
      serverNow: new Date().toISOString(),
    },
    meta: {
      data_source: 'mysql',
      time_window: contract.timeRange,
      order_filter: contract.orderFilter,
      shopId: contract.shopId,
      market: contract.market,
    },
  };
}

module.exports = {
  listOrders,
};
