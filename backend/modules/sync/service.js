'use strict';

const { getMysqlPool } = require('../../db/mysqlPool');
const { getMetricsSnapshot } = require('../../lib/syncMetrics');
const { getUserScope, canManualSync } = require('../../lib/dataScope');
const {
  authTenantId,
  enforceAuthTenantScope,
  dedupeShopsByPlatformShopId,
} = require('../../lib/resolveTenantShop');
const repo = require('./repository');
const { enrichSyncShopRow, stripLegacyDiagnostic } = require('./saasSyncLabels');
const { syncOneShop } = require('./shopSyncRunner');
const { resolveManualSyncShop } = require('../../lib/syncManualResolve');
const { mapSyncApiMessage } = require('../../lib/syncApiMessages');
const { assertTenantActive } = require('../tenants/planService');

function ensurePool() {
  const pool = getMysqlPool();
  if (!pool) {
    const err = new Error('mysql_unavailable');
    err.code = 'mysql_unavailable';
    throw err;
  }
  return pool;
}

function logSyncTenantDebug(row) {
  console.log(
    '[sync-tenant-debug]',
    JSON.stringify({
      tenant_id: row.tenant_id,
      shop_id: row.shop_id,
      platform_shop_id: row.platform_shop_id,
      token_status: row.token_status,
    }),
  );
}

async function getStatus(tenantId, auth) {
  const pool = ensurePool();
  const authTid =
    Number(tenantId) > 0 && Number.isFinite(Number(tenantId)) ? Number(tenantId) : authTenantId(auth);
  if (!authTid) {
    return {
      ok: true,
      module: 'sync',
      source: 'mysql',
      data_source: 'mysql',
      time_window: 'last_24h',
      scope_mode: 'none',
      tenant_id: null,
      can_manual_sync: false,
      metrics: getMetricsSnapshot(),
      worker: 'tiktok-openapi-sync',
      shops: [],
    };
  }

  const scope = enforceAuthTenantScope(await getUserScope(pool, auth), auth, authTid);
  const rawShops = await repo.listShopSyncStatus(pool, scope, authTid);
  const enriched = rawShops.map((row) => {
    const out = enrichSyncShopRow(row);
    delete out.access_token;
    delete out.refresh_token;
    delete out.scope_json;
    delete out.raw_auth_json;
    return out;
  });
  const shops = dedupeShopsByPlatformShopId(enriched, authTid);
  for (const row of shops) {
    logSyncTenantDebug(row);
  }

  const metrics = getMetricsSnapshot();
  return {
    ok: true,
    module: 'sync',
    source: 'mysql',
    data_source: 'mysql',
    time_window: 'last_24h',
    scope_mode: scope.mode,
    tenant_id: authTid,
    can_manual_sync: canManualSync(scope),
    metrics,
    worker: 'tiktok-openapi-sync',
    shops,
  };
}

async function listLogs(tenantId, auth, query) {
  const pool = ensurePool();
  const scope = enforceAuthTenantScope(await getUserScope(pool, auth), auth);
  const rawItems = await repo.listSyncShopLogs(pool, scope, {
    shop_id: query.shop_id || query.shopId,
    platform: query.platform,
    status: query.status,
    date_from: query.date_from || query.dateFrom,
    date_to: query.date_to || query.dateTo,
    limit: query.limit,
  });
  const { mapSyncErrorLabel, mapSyncStatusLabel } = require('./saasSyncLabels');
  const items = rawItems.map((row) => {
    const error_message = mapSyncErrorLabel({
      last_error: row.error_message,
      last_health_message: row.error_message,
    });
    return {
      ...row,
      status: mapSyncStatusLabel(row.status),
      error_message,
    };
  });
  return { items, source: 'mysql', total: items.length, scope_mode: scope.mode };
}

async function runShop(tenantId, auth, shopKey) {
  const pool = ensurePool();
  const authTid = authTenantId(auth) ?? Number(tenantId);
  if (authTid) {
    await assertTenantActive(pool, authTid);
  }
  const scope = enforceAuthTenantScope(await getUserScope(pool, auth), auth);
  if (!canManualSync(scope)) {
    const err = new Error('sync_forbidden');
    err.code = 'forbidden';
    throw err;
  }
  const resolved = await resolveManualSyncShop(authTid, shopKey, auth);
  const shop = resolved.shop;
  if (!shop) {
    const reason = resolved.reason || 'shop_not_found_or_not_eligible';
    const err = new Error(mapSyncApiMessage(reason));
    err.code = 'shop_not_found';
    err.reason = reason;
    throw err;
  }
  if (scope.mode === 'tenant_assigned') {
    const sid = Number(shop.internal_shop_id);
    if (!scope.shopIds || !scope.shopIds.includes(sid)) {
      const err = new Error('shop_forbidden');
      err.code = 'forbidden';
      throw err;
    }
  } else if (Number(shop.tenant_id) !== authTid) {
    const err = new Error('shop_forbidden');
    err.code = 'forbidden';
    throw err;
  }
  const result = await syncOneShop(shop, { deadlineMs: Date.now() + 55000 });
  return { ok: Boolean(result.ok), shop_id: shop.internal_shop_id, platform_shop_id: shop.platform_shop_id, result };
}

async function retryShop(tenantId, auth, shopKey) {
  return runShop(tenantId, auth, shopKey);
}

module.exports = { getStatus, listLogs, runShop, retryShop };
