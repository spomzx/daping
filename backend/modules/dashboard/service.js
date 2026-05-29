'use strict';

const { getMysqlPool } = require('../../db/mysqlPool');
const metricService = require('../analytics/metricService');
const { getUnifiedSummary } = require('../../lib/metricsAuthority');
const { normalizeTrendRows } = require('../../lib/dashboardTrendNormalize');

function ensurePool() {
  const pool = getMysqlPool();
  if (!pool) {
    const err = new Error('mysql_unavailable');
    err.code = 'mysql_unavailable';
    throw err;
  }
  return pool;
}

async function getSummary(tenantId, q, auth) {
  ensurePool();
  return getUnifiedSummary(tenantId, q, auth);
}

async function getTrend(tenantId, q, auth) {
  ensurePool();
  const { rows, debug } = await metricService.getDashboardTrend(tenantId, q, auth);
  return { rows: normalizeTrendRows(rows), debug };
}

async function getOrderVolume(tenantId, q, auth) {
  ensurePool();
  const { rows, debug } = await metricService.getDashboardOrderVolume(tenantId, q, auth);
  return { rows: normalizeTrendRows(rows), debug };
}

async function getGmvCompare(tenantId, q) {
  ensurePool();
  return metricService.getDashboardGmvCompare(tenantId, q);
}

async function getRanking(tenantId, q, auth) {
  ensurePool();
  const { items, debug } = await metricService.getDashboardShopRanking(tenantId, q, auth);
  return { items, source: 'mysql', debug };
}

async function getProductRanking(tenantId, q) {
  ensurePool();
  const { items, debug } = await metricService.getDashboardProductRanking(tenantId, q);
  return { items, source: 'mysql', debug };
}

module.exports = {
  getSummary,
  getTrend,
  getRanking,
  getProductRanking,
  getOrderVolume,
  getGmvCompare,
  normalizeTrendRows,
};
