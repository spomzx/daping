#!/usr/bin/env node
'use strict';

/**
 * 订单入库链路验收：API 分页拉取 vs persist vs MySQL（同日历日大屏事件窗�? *
 *   node scripts/diagnose-order-persist-gap.js --tenant-id=6 --shop-id=28 --date=2026-05-25
 *   node scripts/diagnose-order-persist-gap.js --tenant-id=6 --shop-id=28 --date=2026-05-25 --write
 *
 * --write：执�?persist（upsert），默认只读对比�? */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const dayjs = require('dayjs');
const { getMysqlPool } = require('../../db/mysqlPool');
const { fetchOrdersInTimeRange, getMarketOffsetHours } = require('../../tiktok-api/orders');
const { ensureShopAccessTokenFresh } = require('../../lib/tiktokTokenRefresh');
const { stampOrdersWithShopContext } = require('../../lib/readSyncShops');
const {
  persistOrdersFromCache,
  splitOrdersByApiPages,
  pickPlatformOrderId,
} = require('../../modules/orders/orderPersistenceService');
const {
  parseDashboardFilterQuery,
  buildDashboardWhere,
  countDashboardOrdersMatchingWhere,
} = require('../../modules/dashboard/filterContract');

function parseArgs(argv) {
  let tenantId = null;
  let shopId = null;
  let dateYmd = null;
  let write = false;
  for (const a of argv) {
    if (a.startsWith('--tenant-id=')) tenantId = Number(a.split('=')[1]);
    else if (a.startsWith('--shop-id=')) shopId = Number(a.split('=')[1]);
    else if (a.startsWith('--date=')) dateYmd = String(a.split('=')[1] || '').trim();
    else if (a === '--write') write = true;
  }
  return { tenantId, shopId, dateYmd, write };
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

function extractShopCipher(rawAuth) {
  const raw = rawAuth && typeof rawAuth === 'object' ? rawAuth : parseJsonField(rawAuth);
  return String(raw.shop_cipher || raw.shopCipher || '').trim();
}

async function loadShop(pool, tenantId, shopId) {
  const [rows] = await pool.query(
    `SELECT s.id, s.tenant_id, s.platform_shop_id, s.shop_name, s.display_name,
            s.market, s.region, t.access_token, t.refresh_token, t.token_expire_at, t.raw_auth_json
     FROM shops s
     LEFT JOIN shop_auth_tokens t ON t.id = (
       SELECT t2.id FROM shop_auth_tokens t2 WHERE t2.shop_id = s.id ORDER BY t2.id DESC LIMIT 1
     )
     WHERE s.id = ? AND s.tenant_id = ? LIMIT 1`,
    [shopId, tenantId],
  );
  const r = rows?.[0];
  if (!r) return null;
  const market = String(r.market || r.region || '').trim().toUpperCase();
  const shop_cipher = extractShopCipher(r.raw_auth_json);
  const rawTokenPayload = parseJsonField(r.raw_auth_json);
  if (!rawTokenPayload.shop_cipher) rawTokenPayload.shop_cipher = shop_cipher;
  return {
    internal_shop_id: Number(r.id),
    tenant_id: Number(r.tenant_id),
    platform_shop_id: String(r.platform_shop_id || '').trim(),
    shop_name: String(r.display_name || r.shop_name || '').trim(),
    market,
    region: market,
    shopId: String(r.platform_shop_id || '').trim(),
    shopName: String(r.display_name || r.shop_name || '').trim(),
    shopCipher: shop_cipher,
    accessToken: String(r.access_token || '').trim(),
    refreshToken: String(r.refresh_token || '').trim(),
    accessTokenExpiresAt: r.token_expire_at ? dayjs(r.token_expire_at).toISOString() : '',
    rawTokenPayload,
  };
}

async function countMysqlAllForShopDay(pool, tenantId, shopId, dateYmd) {
  const contract = parseDashboardFilterQuery(
    {
      timeRange: 'custom',
      startDate: dateYmd,
      endDate: dateYmd,
      shopId: String(shopId),
      market: 'ALL',
      orderFilter: 'all',
    },
    tenantId,
  );
  const where = await buildDashboardWhere(pool, tenantId, contract, {});
  return countDashboardOrdersMatchingWhere(pool, where);
}

async function mysqlPidSetForShop(pool, tenantId, shopId, pids) {
  if (!pids.length) return new Set();
  const uniq = [...new Set(pids.map((x) => String(x).trim().toLowerCase()).filter(Boolean))];
  const found = new Set();
  const chunk = 200;
  for (let i = 0; i < uniq.length; i += chunk) {
    const part = uniq.slice(i, i + chunk);
    const ph = part.map(() => '?').join(',');
    const [rows] = await pool.query(
      `SELECT LOWER(TRIM(platform_order_id)) AS pid FROM orders
       WHERE tenant_id = ? AND shop_id = ? AND platform_order_id IN (${ph})`,
      [tenantId, shopId, ...part],
    );
    for (const r of Array.isArray(rows) ? rows : []) {
      if (r.pid) found.add(String(r.pid));
    }
  }
  return found;
}

async function main() {
  const { tenantId, shopId, dateYmd, write } = parseArgs(process.argv.slice(2));
  if (!Number.isFinite(tenantId) || !Number.isFinite(shopId)) {
    console.error('用法: --tenant-id=6 --shop-id=28 [--date=YYYY-MM-DD] [--write]');
    process.exit(1);
  }

  const pool = getMysqlPool();
  if (!pool) {
    console.error('[diagnose-order-persist-gap] �?MySQL');
    process.exit(2);
  }

  const diagDate = dateYmd || dayjs().format('YYYY-MM-DD');
  const shop = await loadShop(pool, tenantId, shopId);
  if (!shop) {
    console.log(JSON.stringify({ ok: false, error: 'shop_not_found' }, null, 2));
    process.exit(1);
  }

  const tokenRefresh = await ensureShopAccessTokenFresh(
    {
      internal_shop_id: shop.internal_shop_id,
      refreshToken: shop.refreshToken,
      accessToken: shop.accessToken,
      accessTokenExpiresAt: shop.accessTokenExpiresAt,
    },
    { skewMs: 48 * 3600 * 1000 },
  );
  let shopForApi = shop;
  if (tokenRefresh.ok && tokenRefresh.shop) {
    shopForApi = {
      ...shop,
      ...tokenRefresh.shop,
      shopCipher: tokenRefresh.shop.shop_cipher || shop.shopCipher,
    };
  }

  const apiRet = await fetchOrdersInTimeRange(shopForApi, {
    dateYmd: diagDate,
    logPrefix: '[diagnose-order-persist-gap]',
    deadlineMs: Date.now() + 120000,
  });

  if (!apiRet?.ok) {
    console.log(
      JSON.stringify(
        {
          ok: false,
          error: 'api_fetch_failed',
          message: apiRet?.error?.message || apiRet?.debug?.responseMessage,
        },
        null,
        2,
      ),
    );
    process.exit(1);
  }

  const apiOrders = Array.isArray(apiRet.data) ? apiRet.data : [];
  const apiIds = apiOrders.map((o) => pickPlatformOrderId(o)).filter(Boolean);
  const pageSlices = splitOrdersByApiPages(apiOrders, apiRet.requestPages);

  const shopContext = {
    internal_shop_id: shop.internal_shop_id,
    tenant_id: shop.tenant_id,
    platform_shop_id: shop.platform_shop_id,
    shop_name: shop.shop_name,
    market: shop.market,
  };

  const page_breakdown = [];
  let aggregateDebug = null;

  if (write) {
    for (const slice of pageSlices) {
      const { orders: stamped } = stampOrdersWithShopContext(slice.orders, shopForApi);
      const stats = await persistOrdersFromCache(stamped, {
        shopContext,
        preview: false,
        persistDebug: true,
        verifyAfterInsert: true,
      });
      page_breakdown.push({
        page: slice.page,
        api_orders: slice.api_orders,
        raw_orders: stamped.length,
        persisted:
          (stats.inserted || 0) + (stats.updated || 0) + (stats.updated_unchanged || 0),
        inserted: stats.inserted,
        updated: stats.updated,
        updated_unchanged: stats.updated_unchanged,
        skipped: stats.skipped,
        persist_debug: stats.persist_debug,
      });
      aggregateDebug = stats.persist_debug;
    }
  } else {
    for (const slice of pageSlices) {
      const { orders: stamped } = stampOrdersWithShopContext(slice.orders, shopForApi);
      page_breakdown.push({
        page: slice.page,
        api_orders: slice.api_orders,
        raw_orders: stamped.length,
        persisted: null,
        note: 'dry-run (use --write to upsert)',
      });
    }
  }

  const mysqlBeforeWrite = await countMysqlAllForShopDay(pool, tenantId, shopId, diagDate);
  const mysqlAfter = write
    ? await countMysqlAllForShopDay(pool, tenantId, shopId, diagDate)
    : mysqlBeforeWrite;

  const mysqlPidSet = await mysqlPidSetForShop(pool, tenantId, shopId, apiIds);
  const missing = apiIds.filter((id) => !mysqlPidSet.has(String(id).trim().toLowerCase()));

  const report = {
    ok: missing.length === 0,
    script: 'diagnose-order-persist-gap',
    tenant_id: tenantId,
    shop_id: shopId,
    shop_name: shop.shop_name,
    market: shop.market,
    date: diagDate,
    write_mode: write,
    api_total_orders: apiOrders.length,
    api_pages_fetched: Number(apiRet.pagesFetched) || pageSlices.length,
    mysql_total_orders: mysqlAfter,
    mysql_total_before_write: write ? mysqlBeforeWrite : undefined,
    missing_orders_after_sync: missing.length,
    missing_order_ids_sample: missing.slice(0, 15),
    duplicate_conflicts: aggregateDebug?.duplicate_conflicts || [],
    persist_failures: aggregateDebug?.failed_order_ids || [],
    persist_debug: aggregateDebug || undefined,
    page_breakdown,
    market_offset_hours: getMarketOffsetHours(shop.market),
  };

  console.log(JSON.stringify(report, null, 2));
  process.exit(report.ok ? 0 : 1);
}

main().catch((e) => {
  console.error('[diagnose-order-persist-gap] fatal', e);
  process.exit(1);
});
