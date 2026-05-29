'use strict';

const { getMysqlPool } = require('../../db/mysqlPool');
const repo = require('./repository');
const summaryService = require('../analytics/summaryService');
const { buildAuthorityServiceQuery } = require('../../lib/dashboardQueryAuthority');

function ensurePool() {
  const pool = getMysqlPool();
  if (!pool) {
    const err = new Error('mysql_unavailable');
    err.code = 'mysql_unavailable';
    throw err;
  }
  return pool;
}

async function list(tenantId, query, auth) {
  const pool = ensurePool();
  const { query: q } = buildAuthorityServiceQuery(query, tenantId);
  const out = await repo.listOrders(pool, tenantId, q, auth);
  return { ...out, source: 'mysql', summary_source: 'ordersListService.list' };
}

async function detail(tenantId, orderKey, auth) {
  const pool = ensurePool();
  const row = await repo.getOrderDetail(pool, tenantId, orderKey, auth);
  if (!row) {
    const err = new Error('order_not_found');
    err.code = 'not_found';
    throw err;
  }
  return { ...row, source: 'mysql' };
}

async function stats(tenantId, query, auth) {
  const { query: q } = buildAuthorityServiceQuery(query, tenantId);
  ensurePool();
  const out = await summaryService.getUnifiedSummary(tenantId, q, auth);
  return {
    orders: out.orders,
    gmv: out.gmv,
    shops: out.shops,
    trends: out.trends,
    sample_orders: out.sample_orders,
    cancelled_orders: out.cancelled_orders,
    summary_source: out.summary_source,
    source: out.source,
  };
}

module.exports = { list, detail, stats };
