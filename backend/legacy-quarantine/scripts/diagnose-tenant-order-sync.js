#!/usr/bin/env node
'use strict';

/**
 * 全租�?active 店订单同步验收（与正�?worker 准入一致）
 *
 *   node scripts/diagnose-tenant-order-sync.js --tenant-id=6 --date=2026-05-25
 *   node scripts/diagnose-tenant-order-sync.js --tenant-id=6 --date=2026-05-25 --write
 *   node scripts/diagnose-tenant-order-sync.js --tenant-id=6 --no-recover-sync
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const dayjs = require('dayjs');
const { getMysqlPool } = require('../../db/mysqlPool');
const {
  fetchOrdersInTimeRange,
  getMarketOffsetHours,
  getCalendarDayRangeByOffsetHours,
} = require('../../tiktok-api/orders');
const { ensureShopAccessTokenFresh } = require('../../lib/tiktokTokenRefresh');
const { stampOrdersWithShopContext } = require('../../lib/readSyncShops');
const { persistOrdersFromCache } = require('../../modules/orders/orderPersistenceService');
const { orderAnalyticsEventTimeExpr } = require('../../modules/dashboard/filterContract');
const { recoverShopSyncStatusIfEligible } = require('../../lib/shopCipherBackfill');
const {
  computeWorkerWouldSkip,
  scopeIncludesOrderInfoDeclared,
  classifyOrderSyncApiFailure,
} = require('../../lib/openApiWorkerEligibility');
const { applyApiVerifiedHealthyState } = require('../../lib/staleAuthHealthRepair');

function parseArgs(argv) {
  let tenantId = null;
  let dateYmd = null;
  let write = false;
  let recoverSync = true;
  for (const a of argv) {
    if (a.startsWith('--tenant-id=')) tenantId = Number(a.split('=')[1]);
    else if (a.startsWith('--date=')) dateYmd = String(a.split('=')[1]).trim();
    else if (a === '--write') write = true;
    else if (a === '--no-recover-sync') recoverSync = false;
  }
  return { tenantId, dateYmd, write, recoverSync };
}

function parseJsonField(v) {
  if (v == null) return {};
  if (typeof v === 'object') return v;
  try {
    return JSON.parse(String(v));
  } catch {
    return {};
  }
}

async function loadActiveShops(pool, tenantId) {
  const [rows] = await pool.query(
    `SELECT s.id AS shop_id, s.tenant_id, s.platform_shop_id, s.shop_name, s.display_name,
            s.market, s.region, s.status, s.hidden, s.sync_enabled,
            t.access_token, t.refresh_token, t.token_expire_at, t.scope_json, t.raw_auth_json,
            ss.sync_status, ss.last_error, ss.last_error_code
     FROM shops s
     LEFT JOIN shop_auth_tokens t ON t.id = (
       SELECT t2.id FROM shop_auth_tokens t2 WHERE t2.shop_id = s.id ORDER BY t2.id DESC LIMIT 1
     )
     LEFT JOIN shop_sync_status ss ON ss.shop_id = s.id AND ss.tenant_id = s.tenant_id AND ss.platform = s.platform
     WHERE s.tenant_id = ? AND s.platform = 'tiktok' AND s.status = 'active'
       AND (s.hidden = 0 OR s.hidden IS NULL)
     ORDER BY s.id ASC`,
    [tenantId],
  );
  return Array.isArray(rows) ? rows : [];
}

async function loadSyncStatus(pool, tenantId, shopId) {
  const [rows] = await pool.query(
    `SELECT sync_status, last_error, last_error_code, last_success_sync_at
     FROM shop_sync_status WHERE tenant_id = ? AND shop_id = ? LIMIT 1`,
    [tenantId, shopId],
  );
  return rows?.[0] || null;
}

function rowToShop(r) {
  const market = String(r.market || r.region || '').trim().toUpperCase();
  const raw = parseJsonField(r.raw_auth_json);
  const shop_cipher = String(raw.shop_cipher || raw.shopCipher || '').trim();
  if (!raw.shop_cipher) raw.shop_cipher = shop_cipher;
  return {
    internal_shop_id: Number(r.shop_id),
    shop_id: Number(r.shop_id),
    tenant_id: Number(r.tenant_id),
    platform_shop_id: String(r.platform_shop_id || '').trim(),
    shop_name: String(r.display_name || r.shop_name || '').trim(),
    market,
    region: market,
    status: r.status,
    hidden: r.hidden,
    sync_enabled: r.sync_enabled !== 0,
    shop_cipher,
    access_token: String(r.access_token || '').trim(),
    refresh_token: String(r.refresh_token || '').trim(),
    token_expire_at: r.token_expire_at,
    shopId: String(r.platform_shop_id || '').trim(),
    shopName: String(r.display_name || r.shop_name || '').trim(),
    shopCipher: shop_cipher,
    accessToken: String(r.access_token || '').trim(),
    refreshToken: String(r.refresh_token || '').trim(),
    accessTokenExpiresAt: r.token_expire_at ? dayjs(r.token_expire_at).toISOString() : '',
    rawTokenPayload: raw,
    scope_has_order_info: scopeIncludesOrderInfoDeclared(r.scope_json, r.raw_auth_json),
  };
}

async function mysqlOrdersForDay(pool, shopId, dateYmd, offsetHours) {
  const evt = orderAnalyticsEventTimeExpr('o');
  const range = getCalendarDayRangeByOffsetHours(dateYmd, offsetHours);
  const [rows] = await pool.query(
    `SELECT COUNT(*) AS c FROM orders o
     WHERE o.shop_id = ?
       AND ${evt} IS NOT NULL
       AND ${evt} >= FROM_UNIXTIME(?)
       AND ${evt} <= FROM_UNIXTIME(?)`,
    [shopId, range.startEpochSec, range.endEpochSec],
  );
  return Number(rows?.[0]?.c || 0);
}

async function diagnoseOneShop(pool, tenantId, row, diagDate, write) {
  const shop = rowToShop(row);
  const syncStatusBefore = String(row.sync_status || 'none');
  const workerWouldSkip = computeWorkerWouldSkip(shop);

  const base = {
    shop_id: shop.shop_id,
    shop_name: shop.shop_name,
    market: shop.market,
    shop_cipher_present: Boolean(shop.shop_cipher),
    scope_declared_has_order_info: shop.scope_has_order_info,
    sync_enabled: shop.sync_enabled,
    sync_status_before: syncStatusBefore,
    worker_would_skip: workerWouldSkip,
    api_orders_count: 0,
    mysql_orders_count: 0,
    write_result: { attempted: false },
    api_ok: false,
    api_error_code: null,
    display: null,
    sync_status_after: syncStatusBefore,
  };

  if (workerWouldSkip) {
    base.display = 'worker_skip';
    const offsetHours = getMarketOffsetHours(shop.market || 'TH');
    base.mysql_orders_count = await mysqlOrdersForDay(pool, shop.shop_id, diagDate, offsetHours);
    const after = await loadSyncStatus(pool, tenantId, shop.shop_id);
    base.sync_status_after = String(after?.sync_status || syncStatusBefore);
    return base;
  }

  const tokenRefresh = await ensureShopAccessTokenFresh(
    {
      internal_shop_id: shop.internal_shop_id,
      refreshToken: shop.refresh_token,
      accessToken: shop.access_token,
      accessTokenExpiresAt: shop.token_expire_at,
    },
    { skewMs: 48 * 3600 * 1000 },
  );

  let shopForApi = shop;
  if (tokenRefresh.ok && tokenRefresh.shop) {
    shopForApi = {
      ...shop,
      ...tokenRefresh.shop,
      shopCipher: tokenRefresh.shop.shop_cipher || shop.shop_cipher,
    };
  }

  const apiRet = await fetchOrdersInTimeRange(shopForApi, {
    dateYmd: diagDate,
    logPrefix: `[tenant-sync:${shop.shop_id}]`,
    deadlineMs: Date.now() + 90000,
  });

  const apiOk = apiRet.ok === true;
  const apiOrders = apiOk && Array.isArray(apiRet.data) ? apiRet.data : [];
  base.api_ok = apiOk;
  base.api_orders_count = apiOrders.length;

  if (!apiOk) {
    const msg = String(apiRet.error?.message || apiRet.debug?.responseMessage || '');
    const httpStatus = Number(
      apiRet.debug?.status ?? apiRet.debug?.responseHttpStatus ?? apiRet.error?.httpStatus ?? 0,
    );
    const failure = classifyOrderSyncApiFailure(msg, httpStatus);
    base.api_error_code = failure.code;
    base.display = failure.code === 'scope_error' ? 'scope_error' : 'sync_error';
  } else if (apiOrders.length === 0) {
    base.display = 'today_no_orders';
  } else {
    base.display = 'api_has_orders';
  }

  const offsetHours = getMarketOffsetHours(shop.market);
  let writeResult = { attempted: false, inserted: 0, updated: 0, skipped: 0 };
  if (apiOk && apiOrders.length > 0 && write) {
    const { orders: stamped } = stampOrdersWithShopContext(apiOrders, shopForApi);
    writeResult.attempted = true;
    writeResult = {
      attempted: true,
      ...(await persistOrdersFromCache(stamped, {
        shopContext: {
          internal_shop_id: shop.internal_shop_id,
          tenant_id: tenantId,
          platform_shop_id: shop.platform_shop_id,
          shop_name: shop.shop_name,
          market: shop.market,
        },
        preview: true,
      })),
    };
    await new Promise((r) => setTimeout(r, 200));
  }
  base.write_result = writeResult;

  base.mysql_orders_count = await mysqlOrdersForDay(pool, shop.shop_id, diagDate, offsetHours);
  if (apiOk && apiOrders.length > 0 && base.mysql_orders_count > 0) base.display = 'ok';
  if (apiOk && apiOrders.length > 0 && base.mysql_orders_count === 0 && !write) {
    base.display = 'persist_or_time_mismatch';
  }

  if (apiOk) {
    await applyApiVerifiedHealthyState(pool, {
      tenantId,
      shopId: shop.shop_id,
      orderCount: apiOrders.length,
      source: 'diagnose_tenant_order_sync',
    });
  }

  const after = await loadSyncStatus(pool, tenantId, shop.shop_id);
  base.sync_status_after = String(after?.sync_status || syncStatusBefore);
  if (apiOk) {
    base.health_status_after = apiOrders.length > 0 ? 'normal' : 'no_orders_today';
  }

  return base;
}

async function main() {
  const { tenantId, dateYmd, write, recoverSync } = parseArgs(process.argv.slice(2));
  if (!Number.isFinite(tenantId)) {
    console.error('用法: node scripts/diagnose-tenant-order-sync.js --tenant-id=6 [--date=YYYY-MM-DD] [--write]');
    process.exit(1);
  }

  const pool = getMysqlPool();
  if (!pool) {
    console.error('[diagnose-tenant-order-sync] �?MySQL');
    process.exit(2);
  }

  const diagDate = dateYmd || dayjs().format('YYYY-MM-DD');
  let syncRecovery = null;
  if (recoverSync) {
    syncRecovery = await recoverShopSyncStatusIfEligible(pool, { tenantId });
  }

  const shopRows = await loadActiveShops(pool, tenantId);
  const shops = [];
  for (const row of shopRows) {
    shops.push(await diagnoseOneShop(pool, tenantId, row, diagDate, write));
  }

  const scopePreSkip = shops.filter((s) =>
    String(s.worker_would_skip || '').includes('seller.order.info'),
  ).length;
  const disabledBefore = shops.filter((s) => String(s.sync_status_before).toLowerCase() === 'disabled').length;
  const disabledAfter = shops.filter((s) => String(s.sync_status_after).toLowerCase() === 'disabled').length;
  const workerEligible = shops.filter((s) => !s.worker_would_skip).length;

  const report = {
    tenant_id: tenantId,
    date: diagDate,
    write_mode: write,
    sync_status_recovery: syncRecovery,
    summary: {
      active_shops: shops.length,
      worker_eligible: workerEligible,
      scope_pre_skip_count: scopePreSkip,
      sync_status_disabled_before: disabledBefore,
      sync_status_disabled_after: disabledAfter,
      api_ok_count: shops.filter((s) => s.api_ok).length,
      today_no_orders: shops.filter((s) => s.display === 'today_no_orders').length,
      scope_error_count: shops.filter((s) => s.display === 'scope_error').length,
      sync_error_count: shops.filter((s) => s.display === 'sync_error').length,
      ok_count: shops.filter((s) => s.display === 'ok').length,
    },
    shops,
  };

  console.log(JSON.stringify(report, null, 2));

  const fail =
    scopePreSkip > 0 ||
    (disabledAfter > 0 && shops.some((s) => s.shop_cipher_present && !s.worker_would_skip));
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error('[diagnose-tenant-order-sync] fatal', e);
  process.exit(1);
});
