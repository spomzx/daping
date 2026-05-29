'use strict';

const dashboardMetrics = require('../../services/orderMetricsService');
const analyticsService = require('./service');
const realtimeService = require('../realtime/service');
const { normalizeTrendRows } = require('../../lib/dashboardTrendNormalize');
const { buildAuthorityServiceQuery } = require('../../lib/dashboardQueryAuthority');

async function getTodaySummary(tenantId, query, auth) {
  const { query: q } = buildAuthorityServiceQuery(query, tenantId);
  return dashboardMetrics.getTodayOrderSummary(tenantId, q, auth);
}

async function getGmvCompare(tenantId, query) {
  const { query: q } = buildAuthorityServiceQuery(query, tenantId);
  return dashboardMetrics.getGmvCompare(tenantId, q);
}

async function getTrend(tenantId, query, auth) {
  const { query: q } = buildAuthorityServiceQuery(query, tenantId);
  return dashboardMetrics.getOrderTrend(tenantId, q, auth, 'trend');
}

async function getOrderVolume(tenantId, query, auth) {
  const { query: q } = buildAuthorityServiceQuery(query, tenantId);
  return dashboardMetrics.getOrderTrend(tenantId, q, auth, 'order-volume');
}

async function getShopRanking(tenantId, query, auth) {
  const { query: q } = buildAuthorityServiceQuery(query, tenantId);
  return dashboardMetrics.getShopRanking(tenantId, q, auth);
}

async function getProductRanking(tenantId, query) {
  const { query: q } = buildAuthorityServiceQuery(query, tenantId);
  return dashboardMetrics.getProductRanking(tenantId, q);
}

async function getAnalyticsTopProducts(tenantId, query, auth) {
  void auth;
  const { query: q } = buildAuthorityServiceQuery(query, tenantId);
  const out = await dashboardMetrics.getProductRanking(tenantId, q);
  return Array.isArray(out?.items) ? out.items : [];
}

async function getAnalyticsTopShops(tenantId, query, auth) {
  const { query: q } = buildAuthorityServiceQuery(query, tenantId);
  const out = await dashboardMetrics.getShopRanking(tenantId, q, auth);
  return Array.isArray(out?.items) ? out.items : [];
}

async function getAnalyticsShopTrend(tenantId, query, auth) {
  const { query: q } = buildAuthorityServiceQuery(query, tenantId);
  const out = await dashboardMetrics.getOrderTrend(tenantId, q, auth, 'trend');
  const rows = Array.isArray(out?.rows) ? out.rows : [];
  return normalizeTrendRows(rows);
}

async function getAnalyticsRecentOrders(tenantId, query, auth) {
  const { query: q } = buildAuthorityServiceQuery(query, tenantId);
  const out = await realtimeService.listOrders(tenantId, q, auth);
  return Array.isArray(out?.orders) ? out.orders : [];
}

async function searchAnalyticsSku(tenantId, query, auth) {
  const { query: q } = buildAuthorityServiceQuery(query, tenantId);
  return analyticsService.searchSku(tenantId, q, auth);
}

async function getAnalyticsStatusDebug(tenantId, query, auth) {
  const { query: q } = buildAuthorityServiceQuery(query, tenantId);
  return analyticsService.getStatusDebugCounts(tenantId, q, auth);
}

async function getAnalyticsCompare(tenantId, query, opts) {
  void opts;
  const { query: q } = buildAuthorityServiceQuery(query, tenantId);
  return dashboardMetrics.getGmvCompare(tenantId, q);
}

module.exports = {
  getTodaySummary,
  getGmvCompare,
  getTrend,
  getOrderVolume,
  getShopRanking,
  getProductRanking,
  getAnalyticsTopProducts,
  getAnalyticsTopShops,
  getAnalyticsShopTrend,
  getAnalyticsRecentOrders,
  searchAnalyticsSku,
  getAnalyticsStatusDebug,
  getAnalyticsCompare,
};
