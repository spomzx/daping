'use strict';

const { getMysqlPool } = require('../../db/mysqlPool');
const { getUserScope } = require('../../lib/dataScope');
const { enforceAuthTenantScope, authTenantId } = require('../../lib/resolveTenantShop');
const { listJobsForTenant } = require('../../sync/services/syncJobRepository');

function ensurePool() {
  const pool = getMysqlPool();
  if (!pool) {
    const err = new Error('mysql_unavailable');
    err.code = 'mysql_unavailable';
    throw err;
  }
  return pool;
}

async function listJobs(tenantId, auth, query) {
  const pool = ensurePool();
  const authTid = authTenantId(auth) ?? Number(tenantId);
  if (!authTid) {
    return { items: [], total: 0, tenant_id: null };
  }
  const scope = enforceAuthTenantScope(await getUserScope(pool, auth), auth, authTid);
  const items = await listJobsForTenant(pool, scope, authTid, query);
  return {
    items,
    total: items.length,
    tenant_id: authTid,
    scope_mode: scope.mode,
  };
}

module.exports = { listJobs };
