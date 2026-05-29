'use strict';

const { isPlatformScope } = require('../../lib/userScope');
const repo = require('./repository');

function resolveScope(auth, tenantIdFromReq) {
  const platform = isPlatformScope(auth);
  if (platform) {
    return { platform: true, tenantId: null };
  }
  const tid = Number(tenantIdFromReq);
  if (!Number.isFinite(tid) || tid <= 0) {
    const err = new Error('invalid_tenant');
    err.code = 'invalid_tenant';
    throw err;
  }
  return { platform: false, tenantId: tid };
}

/**
 * @param {import('mysql2/promise').Pool} pool
 * @param {object} auth
 * @param {number} tenantIdFromReq
 * @param {Record<string, unknown>} query
 */
async function listForActor(pool, auth, tenantIdFromReq, query) {
  const scope = resolveScope(auth, tenantIdFromReq);
  return repo.listLogs(pool, query, scope);
}

async function statsForActor(pool, auth, tenantIdFromReq) {
  const scope = resolveScope(auth, tenantIdFromReq);
  return repo.getStats(pool, scope);
}

async function detailForActor(pool, auth, tenantIdFromReq, id) {
  const scope = resolveScope(auth, tenantIdFromReq);
  const row = await repo.getLogById(pool, id, scope);
  if (!row) {
    const err = new Error('not_found');
    err.code = 'not_found';
    throw err;
  }
  return row;
}

module.exports = { listForActor, statsForActor, detailForActor, resolveScope };
