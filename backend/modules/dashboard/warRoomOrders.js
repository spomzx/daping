'use strict';

const analyticsSvc = require('../analytics/service');
const { normalizeOrderFilter } = require('../../lib/orderFilter');
const { normalizeRange } = require('../../lib/dashboardTimeRange');

/**
 * War-Room 实时订单（MySQL，与 /api/analytics/recent-orders 同源）
 * @param {number} tenantId
 * @param {Record<string, string>} q
 * @param {object} auth
 */
async function getWarRoomRealtimeOrders(tenantId, q, auth) {
  const range = normalizeRange(q.range != null ? String(q.range) : 'today');
  const hours =
    range === 'today' ? 24 : range === 'last7' ? 168 : range === 'last30' ? 720 : Number(q.hours) || 24;

  const rows = await analyticsSvc.getRecentOrders(
    tenantId,
    {
      market: q.market || q.region,
      shop_id: q.shop_id ?? q.shopId,
      status: q.status ?? q.orderFilter,
      orderFilter: q.orderFilter ?? q.status,
      hours: String(hours),
      limit: String(Math.min(50, Math.max(1, Number(q.limit) || 50))),
    },
    auth,
  );

  return {
    orders: Array.isArray(rows) ? rows : [],
    meta: {
      data_source: 'mysql',
      time_window: 'last_24h',
      hours,
      scope: auth?.scope ?? null,
      order_filter: normalizeOrderFilter(q.orderFilter ?? q.status),
    },
  };
}

module.exports = { getWarRoomRealtimeOrders };
