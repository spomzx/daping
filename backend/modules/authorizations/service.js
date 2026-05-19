'use strict';

const { getMysqlPool } = require('../../db/mysqlPool');
const { getUserScope } = require('../../lib/dataScope');
const { authTenantId, enforceAuthTenantScope } = require('../../lib/resolveTenantShop');
const repo = require('./repository');
const { aggregateAuthorizationRows } = require('./aggregate');

function ensurePool() {
  const pool = getMysqlPool();
  if (!pool) {
    const err = new Error('mysql_unavailable');
    err.code = 'mysql_unavailable';
    throw err;
  }
  return pool;
}

async function list(tenantId, auth) {
  const pool = ensurePool();
  const authTid = authTenantId(auth) ?? Number(tenantId);
  const scope = enforceAuthTenantScope(await getUserScope(pool, auth), auth);
  const rows = await repo.listAuthorizations(pool, scope, authTid);
  const items = aggregateAuthorizationRows(rows);
  return {
    items,
    source: 'mysql',
    data_source: 'mysql',
    scope_mode: scope.mode,
    meta: { data_source: 'mysql', scope: scope.mode },
  };
}

async function detail(tenantId, shopKey, auth) {
  const pool = ensurePool();
  const scope = enforceAuthTenantScope(await getUserScope(pool, auth), auth);
  const row = await repo.getAuthorizationDetail(pool, scope, shopKey);
  if (!row) {
    const err = new Error('authorization_not_found');
    err.code = 'not_found';
    throw err;
  }
  return { item: row, source: 'mysql' };
}

module.exports = { list, detail };
