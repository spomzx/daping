'use strict';

/**
 * 店铺管理今日 KPI — 薄封装，唯一实现在 todayMetricsQuery.js（【LOCKED DATA SOURCE】）
 */

const {
  LOCKED_SOURCE,
  enforceTodayMetricsInvariant,
  queryTodayMetricsByShopForTenant,
  queryTodayMetricsForShopId,
} = require('../dashboard/todayMetricsQuery');

/**
 * @param {import('mysql2/promise').Pool} pool
 * @param {number | null} tenantId
 */
async function aggregateTodayStatsByShopId(pool, tenantId) {
  const { byShopId, byPlatformId } = await queryTodayMetricsByShopForTenant(pool, tenantId);
  return { byShopId, byPlatformId };
}

/**
 * @param {import('mysql2/promise').Pool} pool
 * @param {object} shop
 * @param {number | null} tenantId
 */
async function fetchTodayStatsForShopRow(pool, shop, tenantId) {
  const sid = Number(shop.id);
  if (!Number.isFinite(sid) || sid <= 0) return null;
  const pack = await queryTodayMetricsForShopId(pool, Number(tenantId), sid);
  return {
    today_orders: pack.today_orders,
    today_gmv: pack.today_gmv,
    latest_order_at: 0,
  };
}

/**
 * @param {{ today_orders: number, today_gmv: number, latest_order_at?: number }} stats
 * @param {object} shop
 * @param {{ lastSyncOk?: boolean }|null} [openApiSync]
 */
function applyTrustedTodayKpi(stats, shop, openApiSync) {
  const base = enforceTodayMetricsInvariant({
    today_orders: stats?.today_orders,
    today_gmv: stats?.today_gmv,
    latest_order_at: stats?.latest_order_at,
  });

  const syncStatus = String(shop.sync_status || '').toLowerCase();
  const queueFailed = syncStatus === 'failed' || syncStatus === 'error';
  const openApiFailed = openApiSync && openApiSync.lastSyncOk === false;
  const syncFailed = queueFailed || openApiFailed;

  if (syncFailed && base.today_orders <= 0) {
    return {
      ...base,
      today_gmv: 0,
      latest_order_at: Number(stats?.latest_order_at) || 0,
      kpi_trusted: false,
      kpi_untrusted_reason: 'sync_failed_no_intraday_orders',
    };
  }

  return {
    ...base,
    latest_order_at: Number(stats?.latest_order_at) || 0,
    kpi_trusted: true,
    kpi_untrusted_reason: null,
  };
}

module.exports = {
  aggregateTodayStatsByShopId,
  fetchTodayStatsForShopRow,
  applyTrustedTodayKpi,
  LOCKED_SOURCE,
};
