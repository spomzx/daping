'use strict';

const { getMysqlPool } = require('../../db/mysqlPool');
const repo = require('./repository');

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
  const q = {
    market: query.market || query.region,
    shop_id: query.shop_id ?? query.shopId,
    hours: query.hours,
    status: query.status ?? query.orderFilter,
    orderFilter: query.orderFilter ?? query.status,
    page: query.page,
    page_size: query.page_size ?? query.pageSize,
    start_date: query.start_date ?? query.startDate,
    end_date: query.end_date ?? query.endDate,
  };
  const out = await repo.listOrders(pool, tenantId, q, auth);
  return { ...out, source: 'mysql' };
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
  const pool = ensurePool();
  const q = {
    market: query.market || query.region,
    shop_id: query.shop_id ?? query.shopId,
    hours: query.hours,
    status: query.status ?? query.orderFilter,
    orderFilter: query.orderFilter ?? query.status,
  };
  const out = await repo.orderStats(pool, tenantId, q, auth);
  return { ...out, source: 'mysql' };
}

module.exports = { list, detail, stats };
