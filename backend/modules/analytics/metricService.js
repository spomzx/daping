'use strict';

const repo = require('./metricRepository');

async function getDashboardSummary(tenantId, query, auth) {
  return repo.getTodaySummary(tenantId, query, auth);
}

async function getDashboardGmvCompare(tenantId, query) {
  return repo.getGmvCompare(tenantId, query);
}

async function getDashboardTrend(tenantId, query, auth) {
  return repo.getTrend(tenantId, query, auth);
}

async function getDashboardOrderVolume(tenantId, query, auth) {
  return repo.getOrderVolume(tenantId, query, auth);
}

async function getDashboardShopRanking(tenantId, query, auth) {
  return repo.getShopRanking(tenantId, query, auth);
}

async function getDashboardProductRanking(tenantId, query) {
  return repo.getProductRanking(tenantId, query);
}

async function getAnalyticsTopProducts(tenantId, query, auth) {
  return repo.getAnalyticsTopProducts(tenantId, query, auth);
}

async function getAnalyticsTopShops(tenantId, query, auth) {
  return repo.getAnalyticsTopShops(tenantId, query, auth);
}

async function getAnalyticsShopTrend(tenantId, query, auth) {
  return repo.getAnalyticsShopTrend(tenantId, query, auth);
}

async function getAnalyticsRecentOrders(tenantId, query, auth) {
  return repo.getAnalyticsRecentOrders(tenantId, query, auth);
}

async function searchAnalyticsSku(tenantId, query, auth) {
  return repo.searchAnalyticsSku(tenantId, query, auth);
}

async function getAnalyticsStatusDebug(tenantId, query, auth) {
  return repo.getAnalyticsStatusDebug(tenantId, query, auth);
}

async function getAnalyticsGmvCompare(tenantId, query, opts) {
  return repo.getAnalyticsCompare(tenantId, query, opts);
}

module.exports = {
  getDashboardSummary,
  getDashboardGmvCompare,
  getDashboardTrend,
  getDashboardOrderVolume,
  getDashboardShopRanking,
  getDashboardProductRanking,
  getAnalyticsTopProducts,
  getAnalyticsTopShops,
  getAnalyticsShopTrend,
  getAnalyticsRecentOrders,
  searchAnalyticsSku,
  getAnalyticsStatusDebug,
  getAnalyticsGmvCompare,
};
