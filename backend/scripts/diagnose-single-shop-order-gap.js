#!/usr/bin/env node
'use strict';

/**
 * 单店订单差异诊断（只读）：平台后台单量 vs 大屏 valid 口径 vs API vs MySQL
 *
 * 验收（staging 服务器，勿在 Cursor 环境执行写库）：
 *   node scripts/diagnose-single-shop-order-gap.js --tenant-id=6 --market=MY --date=2026-05-25
 *   node scripts/diagnose-single-shop-order-gap.js --tenant-id=6 --shop-id=<id> --date=2026-05-25
 *
 * 可选：--platform-orders=131  （平台后台展示的订单数，用于差异归因）
 *
 * 不写库、不清订单、不改 KPI contract / worker / deploy。
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
  ORDER_SEARCH_PATH,
} = require('../tiktok-api/orders');
const { ensureShopAccessTokenFresh } = require('../lib/tiktokTokenRefresh');
const { deriveAnalyticsStatusFromOrder } = require('../lib/orderFilter');
const {
  parseDashboardFilterQuery,
  buildLockedKpiDashboardWhere,
  buildDashboardWhere,
  countDashboardOrdersMatchingWhere,
  orderAnalyticsEventTimeExpr,
  buildIndexFriendlyEventTimeWhere,
} = require('../modules/dashboard/filterContract');
const { getTimeRangeBounds } = require('../lib/dashboardTimeRange');
const {
  queryTodayMetricsForShopId,
  queryTodayMetricsTenantTotal,
  queryTodayMetricsRankingRows,
} = require('../modules/dashboard/todayMetricsQuery');

function parseArgs(argv) {
  let tenantId = null;
  let shopId = null;
  let market = null;
  let dateYmd = null;
  let platformOrders = null;
  for (const a of argv) {
    if (a.startsWith('--tenant-id=')) tenantId = Number(a.split('=')[1]);
    else if (a.startsWith('--shop-id=')) shopId = Number(a.split('=')[1]);
    else if (a.startsWith('--market=')) market = String(a.split('=')[1] || '').trim().toUpperCase();
    else if (a.startsWith('--date=')) dateYmd = String(a.split('=')[1] || '').trim();
    else if (a.startsWith('--platform-orders=')) platformOrders = Number(a.split('=')[1]);
  }
  return { tenantId, shopId, market, dateYmd, platformOrders };
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

function platformOrderIdFromApiRow(row) {
  return String(row?.id || row?.order_id || row?.platform_order_id || '').trim().toLowerCase();
}

function platformOrderIdFromMysqlRow(row) {
  return String(row?.platform_order_id || '').trim().toLowerCase();
}

function breakdownFromRows(rows, keyFn) {
  const m = {};
  for (const r of rows) {
    const k = keyFn(r) || 'unknown';
    m[k] = (m[k] || 0) + (Number(r.c) || 0);
  }
  return m;
}

async function listCandidateShops(pool, tenantId, market) {
  const params = [tenantId];
  let marketSql = '';
  if (market) {
    marketSql = ` AND UPPER(TRIM(COALESCE(s.market, s.region, ''))) = ? `;
    params.push(market);
  }
  const [rows] = await pool.query(
    `SELECT s.id, s.tenant_id, s.platform, s.platform_shop_id, s.shop_name, s.display_name,
            s.market, s.region, s.status, s.hidden, s.sync_enabled,
            t.raw_auth_json
     FROM shops s
     LEFT JOIN shop_auth_tokens t ON t.id = (
       SELECT t2.id FROM shop_auth_tokens t2 WHERE t2.shop_id = s.id ORDER BY t2.id DESC LIMIT 1
     )
     WHERE s.tenant_id = ? AND s.status <> 'deleted' ${marketSql}
     ORDER BY s.id ASC`,
    params,
  );
  return (Array.isArray(rows) ? rows : []).map((r) => {
    const mkt = String(r.market || r.region || '').trim().toUpperCase();
    return {
      shop_id: Number(r.id),
      shop_name: String(r.display_name || r.shop_name || '').trim(),
      market: mkt,
      platform_shop_id: String(r.platform_shop_id || '').trim(),
      shop_cipher_present: Boolean(extractShopCipher(r.raw_auth_json)),
    };
  });
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
    shop_id: Number(r.id),
    shop_name: String(r.display_name || r.shop_name || '').trim(),
    market,
    platform_shop_id: String(r.platform_shop_id || '').trim(),
    shop_cipher_present: Boolean(shop_cipher),
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
    region: market,
  };
}

function buildDateContract(tenantId, shopId, market, orderFilter, dateYmd) {
  return parseDashboardFilterQuery(
    {
      timeRange: 'custom',
      startDate: dateYmd,
      endDate: dateYmd,
      shopId: String(shopId),
      market: market && market !== 'ALL' ? market : 'ALL',
      orderFilter,
    },
    tenantId,
  );
}

async function mysqlBreakdownForShop(pool, tenantId, shopId, startSec, endSec) {
  const tw = buildIndexFriendlyEventTimeWhere('o', startSec, endSec);
  const base = `FROM orders o WHERE o.tenant_id = ? AND o.shop_id = ? ${tw.sql}`;
  const params = [tenantId, shopId, ...tw.params];

  const [byAnalytics] = await pool.query(
    `SELECT COALESCE(NULLIF(TRIM(o.analytics_status), ''), 'unknown') AS k,
            COUNT(DISTINCT o.id) AS c ${base} GROUP BY k`,
    params,
  );
  const [byOrderStatus] = await pool.query(
    `SELECT COALESCE(NULLIF(TRIM(o.order_status), ''), 'unknown') AS k,
            COUNT(DISTINCT o.id) AS c ${base} GROUP BY k`,
    params,
  );

  const analyticsMap = breakdownFromRows(Array.isArray(byAnalytics) ? byAnalytics : [], (r) => r.k);
  const orderStatusMap = breakdownFromRows(Array.isArray(byOrderStatus) ? byOrderStatus : [], (r) => r.k);

  const pick = (k) => Number(analyticsMap[k]) || 0;
  const all = Object.values(analyticsMap).reduce((s, n) => s + Number(n), 0);

  return {
    mysql_all_orders_count: all,
    mysql_valid_orders_count: pick('valid'),
    mysql_cancelled_orders_count: pick('cancelled'),
    mysql_unpaid_orders_count: pick('unpaid'),
    mysql_sample_orders_count: pick('sample'),
    mysql_by_order_status: orderStatusMap,
    mysql_by_analytics_status: analyticsMap,
    dashboard_event_window: { startSec, endSec },
  };
}

async function mysqlIdsInApiCreateWindow(pool, tenantId, shopId, apiRange) {
  const [rows] = await pool.query(
    `SELECT LOWER(TRIM(o.platform_order_id)) AS pid
     FROM orders o
     WHERE o.tenant_id = ? AND o.shop_id = ?
       AND o.platform_order_id IS NOT NULL AND TRIM(o.platform_order_id) <> ''
       AND o.created_at_platform IS NOT NULL
       AND o.created_at_platform >= FROM_UNIXTIME(?)
       AND o.created_at_platform < FROM_UNIXTIME(?)`,
    [tenantId, shopId, apiRange.startEpochSec, apiRange.endEpochSec],
  );
  return new Set((Array.isArray(rows) ? rows : []).map((r) => String(r.pid || '').trim()).filter(Boolean));
}

async function mysqlIdsForShopAll(pool, tenantId, shopId) {
  const [rows] = await pool.query(
    `SELECT LOWER(TRIM(o.platform_order_id)) AS pid
     FROM orders o
     WHERE o.tenant_id = ? AND o.shop_id = ?
       AND o.platform_order_id IS NOT NULL AND TRIM(o.platform_order_id) <> ''`,
    [tenantId, shopId],
  );
  return new Set((Array.isArray(rows) ? rows : []).map((r) => String(r.pid || '').trim()).filter(Boolean));
}

async function countMysqlOutsideDashboardWindow(pool, tenantId, shopId, apiRange, dashStartSec, dashEndSec) {
  const evt = orderAnalyticsEventTimeExpr('o');
  const [rows] = await pool.query(
    `SELECT COUNT(DISTINCT o.id) AS c
     FROM orders o
     WHERE o.tenant_id = ? AND o.shop_id = ?
       AND o.created_at_platform IS NOT NULL
       AND o.created_at_platform >= FROM_UNIXTIME(?)
       AND o.created_at_platform < FROM_UNIXTIME(?)
       AND (
         ${evt} IS NULL
         OR ${evt} < FROM_UNIXTIME(?)
         OR ${evt} > FROM_UNIXTIME(?)
       )`,
    [tenantId, shopId, apiRange.startEpochSec, apiRange.endEpochSec, dashStartSec, dashEndSec],
  );
  const row = Array.isArray(rows) && rows[0] ? rows[0] : null;
  return Number(row?.c) || 0;
}

function apiStatusBreakdown(orders) {
  const status = {};
  const analytics = {};
  for (const o of orders) {
    const st = String(o.order_status || o.status || 'unknown').trim() || 'unknown';
    status[st] = (status[st] || 0) + 1;
    const a = deriveAnalyticsStatusFromOrder(o);
    analytics[a] = (analytics[a] || 0) + 1;
  }
  return { api_status_breakdown: status, api_analytics_breakdown_derived: analytics };
}

function buildPossibleReason(ctx) {
  const details = [];
  const excluded =
    ctx.mysql_all_orders_count - ctx.mysql_valid_orders_count;
  const platform = ctx.platform_ui_orders;

  if (excluded > 0) {
    details.push({
      code: 'analytics_status_excludes_non_valid',
      detail: `MySQL 事件窗内全量 ${ctx.mysql_all_orders_count}，valid ${ctx.mysql_valid_orders_count}；非 valid 共 ${excluded}（cancelled/unpaid/sample/other）`,
    });
  }

  if (
    platform != null &&
    Number.isFinite(platform) &&
    Math.abs(platform - ctx.mysql_all_orders_count) <= 5 &&
    platform - ctx.dashboard_valid_count >= 10
  ) {
    details.push({
      code: 'platform_all_vs_dashboard_valid',
      detail: `平台后台约 ${platform} 单接近 MySQL 全量 ${ctx.mysql_all_orders_count}，大屏 valid ${ctx.dashboard_valid_count} — 多为「全部订单」vs「有效订单」口径差`,
    });
  }

  if (ctx.dashboard_valid_count === ctx.mysql_valid_orders_count && excluded > 0) {
    details.push({
      code: 'dashboard_matches_mysql_valid',
      detail: '大屏 valid 与 MySQL analytics_status=valid 一致；与平台全量差异来自状态筛选',
    });
  }

  if (ctx.api_vs_mysql_missing_count > 0) {
    details.push({
      code: 'api_orders_not_persisted_for_shop',
      detail: `API 窗口内 ${ctx.api_vs_mysql_missing_count} 个 platform_order_id 在 MySQL 该 shop_id 下不存在（入库漏单或店铺映射错误）`,
    });
  }

  if (ctx.api_total_orders_count > ctx.mysql_all_orders_count + 3) {
    details.push({
      code: 'api_exceeds_mysql_in_same_windows',
      detail: `API ${ctx.api_total_orders_count} > MySQL 事件窗全量 ${ctx.mysql_all_orders_count}，检查同步 worker / 分页上限 / 时区`,
    });
  }

  if (ctx.mysql_outside_date_count > 0) {
    details.push({
      code: 'create_time_in_api_window_but_event_outside_dashboard',
      detail: `${ctx.mysql_outside_date_count} 单 create_at_platform 在 API 日窗内，但 paid_at→created_at_platform→created_at 落在大屏 custom 日窗外`,
    });
  }

  if (ctx.api_pagination_cap_hit) {
    details.push({
      code: 'api_pagination_cap_possible_truncation',
      detail: '已拉满 20 页且末页仍有 next_page_token，API 结果可能被截断（最多约 2000 单/日）',
    });
  }

  if (!ctx.shop_cipher_present) {
    details.push({
      code: 'shop_cipher_missing',
      detail: 'shop_cipher 缺失，OpenAPI 订单列表可能失败或不完整',
    });
  }

  if (ctx.dashboard_valid_count !== ctx.ranking_count || ctx.dashboard_valid_count !== ctx.summary_count) {
    details.push({
      code: 'dashboard_module_count_mismatch',
      detail: `valid=${ctx.dashboard_valid_count} ranking=${ctx.ranking_count} summary=${ctx.summary_count}，应一致（同 locked WHERE）`,
    });
  }

  const serverToday = getTimeRangeBounds('today');
  const custom = getTimeRangeBounds('custom', ctx.date_ymd, ctx.date_ymd);
  if (
    custom.startSec !== serverToday.startSec ||
    custom.endSec !== serverToday.endSec
  ) {
    details.push({
      code: 'diagnose_date_not_server_today',
      detail: `--date=${ctx.date_ymd} 的大屏 custom 窗与服务器「today」窗 epoch 不同；若大屏未切 custom 日，live today 可能不同`,
    });
  }

  let possible_reason = 'within_tolerance_or_minor_gap';
  if (details.length) {
    possible_reason = details.map((d) => d.code).join('|');
  }

  return { possible_reason, possible_reason_details: details };
}

async function runShopDiagnosis(pool, tenantId, shopRow, dateYmd, platformOrders) {
  const shopId = shopRow.shop_id;
  const shop = await loadShopForDiagnose(pool, tenantId, shopId);
  if (!shop) {
    return { error: 'shop_not_found', shop_id: shopId };
  }

  const offsetHours = getMarketOffsetHours(shop.market);
  const apiRange = getCalendarDayRangeByOffsetHours(dateYmd, offsetHours);
  const customContract = buildDateContract(tenantId, shopId, shop.market, 'valid', dateYmd);
  const dashWindow = getTimeRangeBounds('custom', dateYmd, dateYmd);

  let apiSection = {
    api_ok: false,
    api_error: null,
    api_time_range_used: {
      market_offset_hours: offsetHours,
      date_ymd: dateYmd,
      create_time_ge: apiRange.startEpochSec,
      create_time_lt: apiRange.endEpochSec,
      api_path: ORDER_SEARCH_PATH,
    },
    api_pages_fetched: 0,
    api_total_orders_count: 0,
    api_status_breakdown: {},
    api_analytics_breakdown_derived: {},
    api_order_ids_sample: [],
    api_pagination_cap_hit: false,
  };

  let apiOrders = [];
  if (shop.access_token) {
    const tokenRefresh = await ensureShopAccessTokenFresh(
      {
        internal_shop_id: shop.shop_id,
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
        shopCipher: tokenRefresh.shop.shop_cipher || shop.shopCipher,
      };
    }
    const apiRet = await fetchOrdersInTimeRange(shopForApi, {
      dateYmd,
      logPrefix: '[diagnose-single-shop-order-gap]',
      deadlineMs: Date.now() + 120000,
    });
    apiSection.api_ok = Boolean(apiRet?.ok);
    apiSection.api_error = apiRet?.ok
      ? null
      : apiRet?.error?.message || apiRet?.debug?.responseMessage || 'api_failed';
    if (apiRet?.timeRangeUsed) {
      apiSection.api_time_range_used = {
        ...apiSection.api_time_range_used,
        ...apiRet.timeRangeUsed,
        status_filter_used: apiRet.status_filter_used || 'none',
      };
    }
    apiSection.api_pages_fetched = Number(apiRet?.pagesFetched) || 0;
    const pages = Array.isArray(apiRet?.requestPages) ? apiRet.requestPages : [];
    const lastPage = pages.length ? pages[pages.length - 1] : null;
    apiSection.api_pagination_cap_hit =
      apiSection.api_pages_fetched >= 20 && Boolean(lastPage?.next_page_token);
    apiOrders = Array.isArray(apiRet?.data) ? apiRet.data : [];
    apiSection.api_total_orders_count = apiOrders.length;
    const br = apiStatusBreakdown(apiOrders);
    apiSection.api_status_breakdown = br.api_status_breakdown;
    apiSection.api_analytics_breakdown_derived = br.api_analytics_breakdown_derived;
    apiSection.api_order_ids_sample = apiOrders.slice(0, 8).map(platformOrderIdFromApiRow);
  } else {
    apiSection.api_error = 'missing_access_token';
  }

  const mysql = await mysqlBreakdownForShop(
    pool,
    tenantId,
    shopId,
    customContract.startSec,
    customContract.endSec,
  );

  const contractValid = buildDateContract(tenantId, shopId, shop.market, 'valid', dateYmd);
  const contractAll = buildDateContract(tenantId, shopId, shop.market, 'all', dateYmd);

  const whereValid = await buildLockedKpiDashboardWhere(pool, tenantId, contractValid, {});
  const whereAll = await buildDashboardWhere(pool, tenantId, contractAll, {});

  const dashboard_valid_count = await countDashboardOrdersMatchingWhere(pool, whereValid);
  const dashboard_all_count = await countDashboardOrdersMatchingWhere(pool, whereAll);

  const rankingRows = await queryTodayMetricsRankingRows(pool, tenantId, contractValid, {});
  const rankingRow = rankingRows.find((r) => Number(r.shop_id) === shopId);
  const ranking_count = Number(rankingRow?.today_orders ?? rankingRow?.orders ?? 0) || dashboard_valid_count;

  const summaryPack = await queryTodayMetricsTenantTotal(pool, tenantId, contractValid, {});
  const summary_count = Number(summaryPack.orders ?? summaryPack.today_orders ?? 0) || dashboard_valid_count;

  const todayLive = await queryTodayMetricsForShopId(pool, tenantId, shopId);
  const todayLiveCount = Number(todayLive.today_orders ?? todayLive.orders ?? 0);

  const mysqlIdsApiWindow = await mysqlIdsInApiCreateWindow(pool, tenantId, shopId, apiRange);
  const mysqlIdsShopAll = await mysqlIdsForShopAll(pool, tenantId, shopId);

  const apiIdList = apiOrders.map(platformOrderIdFromApiRow).filter(Boolean);
  const missingInMysql = [];
  const missingWrongShop = [];
  for (const id of apiIdList) {
    if (mysqlIdsShopAll.has(id)) {
      if (!mysqlIdsApiWindow.has(id)) missingWrongShop.push(id);
      continue;
    }
    missingInMysql.push(id);
  }

  const mysql_outside_date_count = await countMysqlOutsideDashboardWindow(
    pool,
    tenantId,
    shopId,
    apiRange,
    customContract.startSec,
    customContract.endSec,
  );

  const gapCtx = {
    platform_ui_orders: platformOrders,
    mysql_all_orders_count: mysql.mysql_all_orders_count,
    mysql_valid_orders_count: mysql.mysql_valid_orders_count,
    dashboard_valid_count,
    ranking_count,
    summary_count,
    api_total_orders_count: apiSection.api_total_orders_count,
    api_vs_mysql_missing_count: missingInMysql.length,
    mysql_outside_date_count,
    api_pagination_cap_hit: apiSection.api_pagination_cap_hit,
    shop_cipher_present: shop.shop_cipher_present,
    date_ymd: dateYmd,
  };
  const reasonPack = buildPossibleReason(gapCtx);

  return {
    matched_shop: {
      shop_id: shop.shop_id,
      shop_name: shop.shop_name,
      market: shop.market,
      platform_shop_id: shop.platform_shop_id,
      shop_cipher_present: shop.shop_cipher_present,
    },

    diagnose_date: dateYmd,
    platform_ui_orders_hint: platformOrders,

    api_diagnosis: apiSection,

    mysql_diagnosis: {
      ...mysql,
      mysql_dashboard_event_expr: orderAnalyticsEventTimeExpr('o'),
      mysql_api_create_window: apiRange,
    },

    dashboard_metrics: {
      dashboard_date_contract: {
        timeRange: 'custom',
        startDate: dateYmd,
        endDate: dateYmd,
        orderFilter_valid: 'valid',
        startSec: customContract.startSec,
        endSec: customContract.endSec,
      },
      dashboard_valid_count,
      dashboard_all_count,
      ranking_count,
      summary_count,
      dashboard_live_today_valid_count: todayLiveCount,
      note:
        'dashboard_* 使用 --date 的 custom 日窗 + locked valid；dashboard_live_today_valid_count 为服务器本地「today」窗（可能与 --date 不同）',
    },

    gap_analysis: {
      api_vs_mysql_missing_count: missingInMysql.length,
      api_vs_mysql_missing_order_ids_sample: missingInMysql.slice(0, 10),
      api_in_mysql_other_window_count: missingWrongShop.length,
      api_in_mysql_other_window_ids_sample: missingWrongShop.slice(0, 5),
      mysql_outside_date_count,
      possible_reason: reasonPack.possible_reason,
      possible_reason_details: reasonPack.possible_reason_details,
    },

    timezone_note: {
      api_uses_market_calendar_day: true,
      market_offset_hours: offsetHours,
      dashboard_custom_epoch: { startSec: customContract.startSec, endSec: customContract.endSec },
      dashboard_server_today_epoch: getTimeRangeBounds('today'),
    },
  };
}

async function main() {
  const { tenantId, shopId, market, dateYmd, platformOrders } = parseArgs(process.argv.slice(2));
  if (!Number.isFinite(tenantId)) {
    console.error(
      '用法: node scripts/diagnose-single-shop-order-gap.js --tenant-id=6 [--market=MY] [--shop-id=] [--date=YYYY-MM-DD] [--platform-orders=131]',
    );
    process.exit(1);
  }

  const pool = getMysqlPool();
  if (!pool) {
    console.error('[diagnose-single-shop-order-gap] 无 MySQL 连接');
    process.exit(2);
  }

  const diagDate = dateYmd || dayjs().format('YYYY-MM-DD');

  let candidates = [];
  if (Number.isFinite(shopId)) {
    const shop = await loadShopForDiagnose(pool, tenantId, shopId);
    if (!shop) {
      console.log(
        JSON.stringify(
          { ok: false, error: 'shop_not_found', tenant_id: tenantId, shop_id: shopId },
          null,
          2,
        ),
      );
      process.exit(1);
    }
    candidates = [
      {
        shop_id: shop.shop_id,
        shop_name: shop.shop_name,
        market: shop.market,
        platform_shop_id: shop.platform_shop_id,
        shop_cipher_present: shop.shop_cipher_present,
      },
    ];
  } else {
    candidates = await listCandidateShops(pool, tenantId, market);
    if (!candidates.length) {
      console.log(
        JSON.stringify(
          {
            ok: false,
            error: 'no_shops_matched',
            tenant_id: tenantId,
            market: market || null,
            hint: '请检查 --market 或指定 --shop-id',
          },
          null,
          2,
        ),
      );
      process.exit(1);
    }
    if (candidates.length > 1) {
      console.log(
        JSON.stringify(
          {
            ok: false,
            error: 'ambiguous_shop_requires_shop_id',
            tenant_id: tenantId,
            market: market || null,
            matched_shops: candidates,
            hint: '多个店铺匹配，请追加 --shop-id=<内部 shops.id>',
          },
          null,
          2,
        ),
      );
      process.exit(2);
    }
  }

  const report = await runShopDiagnosis(pool, tenantId, candidates[0], diagDate, platformOrders);

  const out = {
    ok: report.error ? false : true,
    script: 'diagnose-single-shop-order-gap',
    tenant_id: tenantId,
    date: diagDate,
    market_filter: market || null,
    matched_shops: candidates,
    ...report,
  };

  console.log(JSON.stringify(out, null, 2));
  const apiOk = out.api_diagnosis?.api_ok !== false;
  process.exit(out.ok && apiOk ? 0 : 1);
}

main().catch((e) => {
  console.error('[diagnose-single-shop-order-gap] fatal', e);
  process.exit(1);
});
