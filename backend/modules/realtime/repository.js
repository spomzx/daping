'use strict';

const { queryDashboardRealtimeOrders } = require('../dashboard/ordersQuery');

async function listRealtimeOrders(tenantId, query, auth) {
  return queryDashboardRealtimeOrders(tenantId, query, auth);
}

module.exports = {
  listRealtimeOrders,
};
