'use strict';

const realtimeService = require('../realtime/service');

/**
 * War-Room 实时订单（MySQL，与 summary/ranking/trend 同一时间窗）
 * @param {number} tenantId
 * @param {Record<string, string>} q
 * @param {object} auth
 */
async function getWarRoomRealtimeOrders(tenantId, q, auth) {
  return realtimeService.listOrders(tenantId, q, auth);
}

module.exports = { getWarRoomRealtimeOrders };
