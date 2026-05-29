'use strict';

const { getMysqlPool } = require('../../db/mysqlPool');
const { isPlatformScope } = require('../../lib/userScope');
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

async function getAll(tenantId, auth) {
  const pool = ensurePool();
  const tid = auth && isPlatformScope(auth) ? null : tenantId;
  const [settings, exchangeRates] = await Promise.all([
    repo.listSettings(pool, tid),
    repo.listExchangeRates(pool),
  ]);
  return {
    settings,
    exchange_rates: exchangeRates,
    exchange_rates_source: 'mysql',
    exchange_rates_empty: exchangeRates.length === 0,
  };
}

module.exports = { getAll };
