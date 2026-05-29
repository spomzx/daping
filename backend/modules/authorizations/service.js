'use strict';

const { getMysqlPool } = require('../../db/mysqlPool');
const { getUserScope } = require('../../lib/dataScope');
const { authTenantId, enforceAuthTenantScope } = require('../../lib/resolveTenantShop');
const repo = require('./repository');
const { aggregateAuthorizationRows } = require('./aggregate');
const { loadAuthContractByShopId } = require('../../lib/shopAuthContract');

function ensurePool() {
  const pool = getMysqlPool();
  if (!pool) {
    const err = new Error('mysql_unavailable');
    err.code = 'mysql_unavailable';
    throw err;
  }
  return pool;
}

function resolveListTenantId(tenantId, auth) {
  const fromReq = Number(tenantId);
  if (Number.isFinite(fromReq) && fromReq > 0) return fromReq;
  return authTenantId(auth);
}

function isStagingEnv() {
  const env = String(
    process.env.APP_ENV || process.env.DEPLOY_ENV || process.env.STAGE || process.env.APP_STAGE || '',
  ).toLowerCase();
  return env === 'staging' || env.includes('staging');
}

function logAuthorizationsScope(payload) {
  if (!isStagingEnv()) return;
  console.info('[authorizations.scope]', payload);
}

async function list(tenantId, auth) {
  const pool = ensurePool();
  const currentTenantId = authTenantId(auth);
  const finalTenantId = resolveListTenantId(tenantId, auth);
  if (!finalTenantId) {
    return {
      items: [],
      source: 'mysql',
      data_source: 'mysql',
      scope_mode: 'none',
      meta: { data_source: 'mysql', scope: 'none' },
    };
  }
  const scope = enforceAuthTenantScope(await getUserScope(pool, auth), auth, finalTenantId);
  const rows = await repo.listAuthorizations(pool, scope, finalTenantId);
  const shopIds = rows.map((r) => Number(r.shop_id)).filter((id) => id > 0);
  const authMap = await loadAuthContractByShopId(pool, finalTenantId, shopIds);
  const merged = rows.map((row) => {
    const sid = Number(row.shop_id);
    const authPack = authMap.get(sid) || {};
    return {
      ...row,
      access_token: authPack.access_token ?? row.access_token,
      raw_auth_json: authPack.raw_auth_json ?? row.raw_auth_json,
      token_expire_at: authPack.token_expire_at ?? row.token_expire_at,
      has_token: authPack.has_token ?? row.has_token,
    };
  });
  const items = aggregateAuthorizationRows(merged);
  logAuthorizationsScope({
    currentTenantId,
    finalTenantId,
    reqTenantId: Number(tenantId) || null,
    scopeMode: scope.mode,
    itemTenantIds: [...new Set(items.map((r) => Number(r.tenant_id)).filter(Boolean))],
    itemCount: items.length,
  });
  return {
    items,
    source: 'mysql',
    data_source: 'mysql',
    scope_mode: scope.mode,
    tenant_id: finalTenantId,
    meta: { data_source: 'mysql', scope: scope.mode, tenant_id: finalTenantId },
  };
}

async function detail(tenantId, shopKey, auth) {
  const pool = ensurePool();
  const finalTenantId = resolveListTenantId(tenantId, auth);
  const scope = enforceAuthTenantScope(await getUserScope(pool, auth), auth, finalTenantId);
  const row = await repo.getAuthorizationDetail(pool, scope, shopKey);
  if (!row) {
    const err = new Error('authorization_not_found');
    err.code = 'not_found';
    throw err;
  }
  return { item: row, source: 'mysql' };
}

module.exports = { list, detail };
