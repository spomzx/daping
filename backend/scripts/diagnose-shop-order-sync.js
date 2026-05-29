#!/usr/bin/env node
'use strict';

/**
 * 单店 TikTok 订单同步诊断（API 拉取 vs MySQL 入库 vs 大屏今日窗）
 *
 *   node backend/scripts/diagnose-shop-order-sync.js --tenant-id=6 --shop-id=31 --date=2026-05-25
 *   node backend/scripts/diagnose-shop-order-sync.js --tenant-id=6 --shop-id=31 --date=2026-05-25 --write
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const dayjs = require('dayjs');
const { getMysqlPool } = require('../db/mysqlPool');
const {
  fetchOrdersInTimeRange,
  getMarketOffsetHours,
  getCalendarDayRangeByOffsetHours,
  getTodayRangeByOffsetHours,
  ORDER_SEARCH_PATH,
} = require('../tiktok-api/orders');
const { ensureShopAccessTokenFresh } = require('../lib/tiktokTokenRefresh');
const { stampOrdersWithShopContext } = require('../lib/readSyncShops');
const { persistOrdersFromCache } = require('../modules/orders/orderPersistenceService');
const { orderAnalyticsEventTimeExpr } = require('../modules/dashboard/filterContract');
const { getTimeRangeBounds } = require('../lib/dashboardTimeRange');
const { queryTodayMetricsForShopId } = require('../modules/dashboard/todayMetricsQuery');
const { backfillShopCipher } = require('../lib/shopCipherBackfill');
const {
  computeWorkerWouldSkip,
  scopeIncludesOrderInfoDeclared,
} = require('../lib/openApiWorkerEligibility');

function parseArgs(argv) {
  let tenantId = null;
  let shopId = null;
  let dateYmd = null;
  let write = false;
  let backfillCipher = false;
  for (const a of argv) {
    if (a.startsWith('--tenant-id=')) tenantId = Number(a.split('=')[1]);
    else if (a.startsWith('--shop-id=')) shopId = Number(a.split('=')[1]);
    else if (a.startsWith('--date=')) dateYmd = String(a.split('=')[1]).trim();
    else if (a === '--write') write = true;
    else if (a === '--backfill-cipher') backfillCipher = true;
  }
  return { tenantId, shopId, dateYmd, write, backfillCipher };
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

async function loadShopForDiagnose(pool, tenantId, shopId) {
  const [rows] = await pool.query(
    `SELECT s.id, s.tenant_id, s.platform, s.platform_shop_id, s.shop_name, s.display_name,
            s.market, s.region, s.status, s.hidden, s.sync_enabled, s.last_sync_at,
            t.access_token, t.refresh_token, t.token_expire_at, t.scope_json, t.raw_auth_json
     FROM shops s
     LEFT JOIN shop_auth_tokens t ON t.id = (
       SELECT t2.id FROM shop_auth_tokens t2 WHERE t2.shop_id = s.id ORDER BY t2.id DESC LIMIT 1
     )
     WHERE s.id = ? AND s.tenant_id = ?
     LIMIT 1`,
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
    shop_id: Number(r.id),
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
    rawTokenPayload,
    scope_has_order_info: scopeIncludesOrderInfoDeclared(r.scope_json, r.raw_auth_json),
  };
}

async function loadSyncStatus(pool, tenantId, shopId) {
  const [rows] = await pool.query(
    `SELECT sync_status, last_error, last_success_sync_at, sync_fail_count, is_token_valid
     FROM shop_sync_status WHERE tenant_id = ? AND shop_id = ? LIMIT 1`,
    [tenantId, shopId],
  );
  return rows?.[0] || null;
}

async function mysqlOrdersForDay(pool, shopId, dateYmd, offsetHours) {
  const evt = orderAnalyticsEventTimeExpr('o');
  const range = getCalendarDayRangeByOffsetHours(dateYmd, offsetHours);
  const [rows] = await pool.query(
    `
    SELECT o.id, o.platform_order_id, o.order_status, o.total_amount, o.currency,
           ${evt} AS event_at
    FROM orders o
    WHERE o.shop_id = ?
      AND ${evt} IS NOT NULL
      AND ${evt} >= FROM_UNIXTIME(?)
      AND ${evt} <= FROM_UNIXTIME(?)
    ORDER BY ${evt} DESC
    LIMIT 500
    `,
    [shopId, range.startEpochSec, range.endEpochSec],
  );
  const list = Array.isArray(rows) ? rows : [];
  return {
    count: list.length,
    order_ids_sample: list.slice(0, 5).map((r) => r.platform_order_id),
    status_breakdown: list.reduce((m, r) => {
      const k = String(r.order_status || 'unknown');
      m[k] = (m[k] || 0) + 1;
      return m;
    }, {}),
    range,
  };
}

function classifyOutcome(apiCount, mysqlCount, apiOk, writeResult) {
  if (!apiOk) return 'sync_error_api_failed';
  if (apiCount > 0 && mysqlCount === 0 && writeResult?.skipped > 0) return 'persist_skipped';
  if (apiCount > 0 && mysqlCount === 0) return 'persist_or_time_mismatch';
  if (apiCount === 0 && mysqlCount === 0) return 'today_no_orders_confirmed';
  if (apiCount > 0 && mysqlCount > 0) return 'ok';
  if (apiCount === 0 && mysqlCount > 0) return 'mysql_has_api_empty';
  return 'unknown';
}

async function main() {
  const { tenantId, shopId, dateYmd, write, backfillCipher } = parseArgs(process.argv.slice(2));
  if (!Number.isFinite(tenantId) || !Number.isFinite(shopId)) {
    console.error('用法: --tenant-id=6 --shop-id=31 [--date=2026-05-25] [--write]');
    process.exit(1);
  }

  const pool = getMysqlPool();
  if (!pool) {
    console.error('[diagnose-shop-order-sync] 无 MySQL');
    process.exit(2);
  }

  let cipherBackfillReport = null;
  if (backfillCipher) {
    cipherBackfillReport = await backfillShopCipher(pool, {
      tenantId,
      shopId,
      tryApi: true,
    });
    if (cipherBackfillReport.need_reauthorize?.length) {
      console.error(
        '[diagnose-shop-order-sync] shop_cipher 无法回填，需重新授权:',
        JSON.stringify(cipherBackfillReport.need_reauthorize, null, 2),
      );
      process.exit(2);
    }
  }

  const shop = await loadShopForDiagnose(pool, tenantId, shopId);
  if (!shop) {
    console.error('[diagnose-shop-order-sync] 未找到店铺');
    process.exit(1);
  }

  const diagDate = dateYmd || dayjs().format('YYYY-MM-DD');
  const offsetHours = getMarketOffsetHours(shop.market);
  const syncRow = await loadSyncStatus(pool, tenantId, shopId);

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
    shopForApi = { ...shop, ...tokenRefresh.shop, shopCipher: tokenRefresh.shop.shop_cipher || shop.shop_cipher };
  }

  const apiRet = await fetchOrdersInTimeRange(shopForApi, {
    dateYmd: diagDate,
    logPrefix: '[diagnose-shop-order-sync]',
    deadlineMs: Date.now() + 120000,
  });

  const apiOk = apiRet.ok === true;
  const apiOrders = apiOk && Array.isArray(apiRet.data) ? apiRet.data : [];
  const apiOrderIds = apiOrders.map((o) => String(o.orderId || o.id || '')).filter(Boolean);

  let writeResult = { inserted: 0, updated: 0, skipped: 0, attempted: false };
  if (apiOk && apiOrders.length > 0 && write) {
    const { orders: stamped, ctx } = stampOrdersWithShopContext(apiOrders, shopForApi);
    writeResult.attempted = true;
    writeResult = {
      attempted: true,
      ...(await persistOrdersFromCache(stamped, {
        shopContext: {
          internal_shop_id: shop.internal_shop_id,
          tenant_id: tenantId,
          platform_shop_id: ctx.platform_shop_id,
          shop_name: ctx.shop_name,
          market: ctx.market,
        },
        preview: true,
      })),
    };
  }

  const mysqlBefore = await mysqlOrdersForDay(pool, shopId, diagDate, offsetHours);
  if (writeResult.attempted) {
    await new Promise((r) => setTimeout(r, 300));
  }
  const mysqlAfter = await mysqlOrdersForDay(pool, shopId, diagDate, offsetHours);

  const dashboardToday = await queryTodayMetricsForShopId(pool, tenantId, shopId);
  const serverTodayBounds = getTimeRangeBounds('today');
  const syncTodayRange = getTodayRangeByOffsetHours(offsetHours);
  const bangkokDayRange = getCalendarDayRangeByOffsetHours(diagDate, 7);

  const firstPage = apiRet.requestPages?.[0] || {};
  const httpStatus = Number(
    apiRet.debug?.status ?? apiRet.debug?.responseHttpStatus ?? apiRet.error?.httpStatus ?? firstPage.response_code ?? 0,
  );

  const report = {
    shop_id: shopId,
    platform_shop_id: shop.platform_shop_id,
    shop_name: shop.shop_name,
    market: shop.market,
    tenant_id: tenantId,
    expected_cavera_platform_shop_id: '7496312889470388950',
    platform_shop_id_matches_cavera: String(shop.platform_shop_id) === '7496312889470388950',

    shop_cipher_backfill: cipherBackfillReport,

    sync_eligibility: {
      sync_enabled: shop.sync_enabled,
      status: shop.status,
      hidden: shop.hidden === 1,
      scope_has_order_info: shop.scope_has_order_info,
      shop_cipher_present: Boolean(shop.shop_cipher),
      worker_would_skip: computeWorkerWouldSkip(shop),
      worker_skip_note:
        '与 readSyncShops/worker 一致：不因 scope 字段缺失预判跳过；API 权限失败才 scope_error',
    },

    shop_sync_status: syncRow,

    token_refresh_result: {
      ok: tokenRefresh.ok,
      refreshed: tokenRefresh.refreshed === true,
      category: tokenRefresh.category || null,
      userLabel: tokenRefresh.userLabel || null,
      fullMessage: tokenRefresh.fullMessage || null,
    },

    tiktok_order_api: {
      request_path: ORDER_SEARCH_PATH,
      time_range_used: apiRet.timeRangeUsed || apiRet.requestBody || null,
      status_filter_used: apiRet.status_filter_used || 'none（未传 order_status）',
      response_http_status: httpStatus,
      response_code: apiRet.debug?.responseCode ?? apiRet.error?.code ?? firstPage.response_code ?? null,
      response_message: apiRet.debug?.responseMessage ?? apiRet.error?.message ?? firstPage.response_message ?? null,
      api_orders_count: apiOrders.length,
      api_order_ids_sample: apiOrderIds.slice(0, 5),
      api_status_breakdown: apiOrders.reduce((m, o) => {
        const k = String(o.status || o.orderStatus || 'unknown');
        m[k] = (m[k] || 0) + 1;
        return m;
      }, {}),
      pages_fetched: apiRet.pagesFetched ?? 0,
      error_full: apiOk ? null : String(apiRet.error?.message || apiRet.debug?.responseMessage || JSON.stringify(apiRet.error || {})),
    },

    timezone_audit: {
      diagnose_date: diagDate,
      market_offset_hours: offsetHours,
      openapi_sync_today_window: syncTodayRange,
      bangkok_calendar_day_utc7: bangkokDayRange,
      dashboard_today_server_local: serverTodayBounds,
      mysql_event_expr: orderAnalyticsEventTimeExpr('o'),
      note:
        'OpenAPI 按市场 offset 自然日拉 create_time；大屏 today 默认服务器本地日；MySQL 统计用 paid_at→created_at_platform→created_at',
    },

    mysql_orders_count: mysqlAfter.count,
    mysql_order_ids_sample: mysqlAfter.order_ids_sample,
    mysql_status_breakdown: mysqlAfter.status_breakdown,
    mysql_before_write: write ? mysqlBefore : undefined,

    dashboard_locked_today: {
      today_orders: dashboardToday.today_orders,
      today_gmv: dashboardToday.today_gmv,
    },

    write_result: writeResult,

    display_classification: classifyOutcome(apiOrders.length, mysqlAfter.count, apiOk, writeResult),
    health_ui_hint: !apiOk
      ? '同步异常（API 失败）— 禁止显示今日无单'
      : apiOrders.length === 0
        ? '今日无单（API 成功返回 0）'
        : mysqlAfter.count === 0
          ? '入库异常或时间窗不一致 — 禁止显示今日无单'
          : '数据正常',

    acceptance_checks: {
      no_fake_zero_when_tiktok_has_orders:
        apiOrders.length === 0 || mysqlAfter.count > 0 || !apiOk,
    },
  };

  console.log(JSON.stringify(report, null, 2));
  process.exit(apiOk && report.platform_shop_id_matches_cavera !== false ? 0 : 1);
}

main().catch((e) => {
  console.error('[diagnose-shop-order-sync] fatal', e);
  process.exit(1);
});
