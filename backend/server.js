const path = require('path');
const fs = require('fs');
const express = require('express');
const cors = require('cors');
const dayjs = require('dayjs');

try {
  require('dotenv').config({ path: path.join(__dirname, '.env') });
} catch (_) {}
require('dotenv').config();

const {
  normalizeBaseCurrency,
  normalizeTargetCurrency,
  getConversionRate,
  getFallbackRate,
} = require('./lib/rates');
const {
  getAuthUrl,
  handleCallbackByCode,
  buildPartnerAuthorizeUrl,
  normalizeOAuthRegion,
  consumeOAuthState,
  debugShopList,
  runAuthorizedShopsSignTest,
} = require('./tiktok-api/auth');
const {
  SHOPS_PATH,
  readShops,
  readShopsFileInfo,
  listEligibleDashboardShops,
  pickDashboardShop,
  shopCipherString,
  grantedScopesString,
  sanitizeShop,
  patchShopEnabled,
} = require('./tiktok-api/shops');
const { collectOnce } = require('./tiktok-api/scheduler');
const { requestShopApi } = require('./tiktok-api/client');
const { pickAmountAndCurrency, fetchTodayOrders } = require('./tiktok-api/orders');
const { isMysqlPrimaryDashboard } = require('./modules/orders/mysqlDashboardOrdersService');
const { runHealthCheck } = require('./lib/healthCheck');
const { getMetricsSnapshot } = require('./lib/syncMetrics');
const { orderStatusToZh } = require('./lib/orderStatusZh');
const { optionalAuth } = require('./middlewares/optionalAuth');
const { authRequired, authRequiredAllowQueryToken } = require('./middlewares/authRequired');
const { requireRole } = require('./middlewares/requireRole');
const { requireFullAccess } = require('./middlewares/requireFullAccess');
const { collectNowLimiter } = require('./middlewares/rateLimit');

const app = express();
const PORT = Number(process.env.PORT) || 3001;
const SERVICE_VERSION = 'p8-ops-isolated';
const SERVICE_STARTED_AT = new Date().toISOString();
const STORAGE_DIR = path.join(__dirname, 'storage');

try {
  const { initSqliteOrdersDatabase } = require('./db/sqliteOrdersInit');
  const { getDbFilePath } = require('./db/sqlite');
  if (initSqliteOrdersDatabase()) {
    console.log('[dashboard-db] SQLite ready:', getDbFilePath());
  }
} catch (e) {
  console.error('[dashboard-db] init error (continuing without DB):', e && e.message ? e.message : e);
}

app.use(cors());
app.use(express.json());

/** 登录/注册：独立挂载，不受 users/shops/analytics 等模块 require 失败影响 */
try {
  const { router: authRouter } = require('./modules/auth/routes');
  app.use('/api/auth', authRouter);
  console.log('[routes] /api/auth mounted (login, register, logout, me)');
} catch (e) {
  const msg = e && e.message ? e.message : String(e);
  console.error('[routes] /api/auth mount failed:', msg);
  app.post('/api/auth/login', (_req, res) => {
    res.status(503).json({ error: 'auth_module_unavailable', message: msg });
  });
  app.post('/api/auth/register', (_req, res) => {
    res.status(503).json({ error: 'auth_module_unavailable', message: msg });
  });
}

try {
  const { isMysqlConfigured } = require('./config/database');
  const { getMysqlPool } = require('./db/mysqlPool');
  if (isMysqlConfigured()) {
    getMysqlPool();
  } else {
    console.warn('[mysql] DB_* 未配置：业务 API 未挂载；/api/auth 仍可用（login 返回 database_not_configured）');
  }
} catch (e) {
  console.error('[mysql] pool init error:', e && e.message ? e.message : e);
}

function mountApiRouter(label, mountPath, modulePath) {
  try {
    const mod = require(modulePath);
    const router = mod.router || mod;
    if (!router) throw new Error('module has no router export');
    app.use(mountPath, router);
    console.log(`[routes] ${mountPath} mounted (${label})`);
    return true;
  } catch (e) {
    console.error(`[routes] ${mountPath} mount failed (${label}):`, e && e.message ? e.message : e);
    return false;
  }
}

const { registerApiRoutes } = require('./routes/registerApiRoutes');
registerApiRoutes(app, mountApiRouter);
try {
  const { SAAS_DATA_SOURCE_LABEL } = require('./lib/saasMysqlOnly');
  console.log(`[saas-mysql-only] SaaS API locked: ${SAAS_DATA_SOURCE_LABEL} (legacy cache/json blocked on /api/dashboard|analytics|orders|shops|tenants|users)`);
} catch (_) {
  /* ignore */
}

function readJsonSafe(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function safeNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function readOrdersAggregateFromStorage(limit = 50) {
  let files = [];
  try {
    files = fs
      .readdirSync(STORAGE_DIR)
      .filter((name) => /^tiktokOrders_[a-z0-9_-]+\.json$/i.test(name))
      .map((name) => path.join(STORAGE_DIR, name));
  } catch {
    files = [];
  }
  const all = [];
  for (const filePath of files) {
    const data = readJsonSafe(filePath);
    if (!data || typeof data !== 'object') continue;
    const shopId = String(data.shopId || path.basename(filePath).replace(/^tiktokOrders_/i, '').replace(/\.json$/i, ''));
    const region = String(data.region || shopId || '').toUpperCase();
    const shopName = String(data.shopName || `TikTok ${region}`);
    const rawOrders =
      (Array.isArray(data.orders) && data.orders) ||
      (Array.isArray(data.items) && data.items) ||
      (Array.isArray(data?.data?.orders) && data.data.orders) ||
      (Array.isArray(data.ordersList) && data.ordersList) ||
      [];
    for (const row of rawOrders) {
      const one = row && typeof row === 'object' ? row : {};
      const orderId = String(one.id ?? one.order_id ?? one.orderId ?? '');
      if (!orderId) continue;
      const amountBase = safeNum(one?.payment?.total_amount ?? one.total_amount ?? one.sale_price ?? 0);
      const customerName = String(
        one?.recipient_address?.name ?? one.customer_name ?? one.customerName ?? one.buyer_name ?? one.buyerName ?? '***',
      );
      const rawStatus = String(one.status ?? one.display_status ?? '').trim();
      const zhStatus = orderStatusToZh(rawStatus || 'unknown');
      all.push({
        id: orderId,
        orderId,
        status: zhStatus,
        orderStatus: zhStatus,
        shopId,
        shopName,
        region,
        customerName,
        orderAmountBase: Number(amountBase.toFixed(2)),
        orderAmountTarget: Number(amountBase.toFixed(2)),
        orderTime: String(one.create_time ?? one.paid_time ?? one.update_time ?? ''),
      });
    }
  }
  const dedup = new Map();
  for (const o of all) {
    if (!dedup.has(o.orderId)) dedup.set(o.orderId, o);
  }
  const aggregatedOrders = [...dedup.values()].slice(0, Math.max(1, limit));
  console.log('[gmv] aggregated orders length:', aggregatedOrders.length);
  return {
    filesCount: files.length,
    orders: aggregatedOrders,
  };
}

function buildRangeByOffsetHours(offsetHours) {
  const nowUtcMs = Date.now();
  const shifted = new Date(nowUtcMs + offsetHours * 3600 * 1000);
  const y = shifted.getUTCFullYear();
  const m = shifted.getUTCMonth();
  const d = shifted.getUTCDate();
  const startUtcMs = Date.UTC(y, m, d, 0, 0, 0) - offsetHours * 3600 * 1000;
  const endUtcMs = nowUtcMs;
  return {
    startEpochSec: Math.floor(startUtcMs / 1000),
    endEpochSec: Math.floor(endUtcMs / 1000),
    localStart: new Date(startUtcMs + offsetHours * 3600 * 1000).toISOString().replace('T', ' ').replace('Z', ''),
    localNow: new Date(endUtcMs + offsetHours * 3600 * 1000).toISOString().replace('T', ' ').replace('Z', ''),
  };
}

app.get('/api/exchange-rate', async (req, res) => {
  const base = normalizeBaseCurrency(req.query.base);
  const target = normalizeTargetCurrency(req.query.target);
  const forceValue = String(req.query.force || '').toLowerCase();
  const forceRefresh = forceValue === 'true' || forceValue === '1';
  const ratePayload = await getConversionRate(base, target, forceRefresh);
  res.json({
    baseCurrency: ratePayload.baseCurrency,
    targetCurrency: ratePayload.targetCurrency,
    rate: ratePayload.rate,
    updatedAt: ratePayload.updatedAt,
    source: ratePayload.source,
    status: ratePayload.status,
  });
});

app.get('/api/tiktok/auth-url', (req, res) => {
  try {
    const q = req.query.region;
    const region = typeof q === 'string' ? q : Array.isArray(q) ? String(q[0] || '') : '';
    res.json(getAuthUrl(region || undefined));
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

/** 浏览器跳转 TikTok 授权（302），query: region=TH|MY|SG|PH|VN&token=JWT */
app.get(
  '/api/tiktok/auth/start',
  authRequiredAllowQueryToken,
  requireFullAccess,
  requireRole('admin', 'super_admin'),
  async (req, res) => {
    try {
      const { getMysqlPool } = require('./db/mysqlPool');
      const { assertTenantActive, planErrorToHttp } = require('./modules/tenants/planService');
      const pool = getMysqlPool();
      if (pool && req.auth?.tenant_id) {
        try {
          await assertTenantActive(pool, Number(req.auth.tenant_id));
        } catch (e) {
          const mapped = planErrorToHttp(e);
          if (mapped) {
            return res.status(mapped.status).json(mapped.body);
          }
          throw e;
        }
      }
      const q = req.query.region;
      const raw = typeof q === 'string' ? q : Array.isArray(q) ? String(q[0] || '') : '';
      const region = normalizeOAuthRegion(raw);
      if (!region) {
        return res.status(400).json({
          error: 'invalid_region',
          allowed: ['TH', 'MY', 'SG', 'PH', 'VN'],
        });
      }
      const url = buildPartnerAuthorizeUrl(region, req.auth);
      return res.redirect(302, url);
    } catch (e) {
      return res.status(500).json({ error: String(e?.message || e) });
    }
  },
);

/**
 * OAuth 回调（需在 TikTok 控制台配置为 TIKTOK_REDIRECT_URI；推荐使用 /api/tiktok/auth/callback）
 * 校验 state 后落库并回到大屏
 */
app.get('/api/tiktok/auth/callback', async (req, res) => {
  try {
    const code = String(req.query.code || '');
    const state = String(req.query.state || '');
    const meta = consumeOAuthState(state);
    if (!meta) {
      return res.redirect(302, '/?shop_auth=error&reason=invalid_state');
    }
    if (!meta.tenantId) {
      return res.redirect(302, '/?shop_auth=error&reason=oauth_missing_tenant');
    }
    if (!code) {
      return res.redirect(302, '/?shop_auth=error&reason=missing_code');
    }
    const result = await handleCallbackByCode(code, {
      oauthRegion: meta.region,
      tenantId: meta.tenantId,
      userId: meta.userId,
    });
    if (!result?.ok) {
      return res.redirect(302, '/?shop_auth=error&reason=no_shops_saved');
    }
    const q = new URLSearchParams({
      shop_auth: 'ok',
      imported: String(result.imported_count ?? 0),
      updated: String(result.updated_count ?? 0),
      skipped: String(result.skipped_count ?? 0),
    });
    return res.redirect(302, `/?${q.toString()}`);
  } catch (e) {
    const code = e && e.code ? String(e.code) : '';
    const msg = encodeURIComponent(code || String(e?.message || e).slice(0, 240));
    return res.redirect(302, `/?shop_auth=error&reason=${msg}`);
  }
});

/** JSON 回调（与 auth/callback 相同校验；redirect_uri 若仍指向此路径则继续可用） */
app.get('/api/tiktok/callback', async (req, res) => {
  try {
    const code = String(req.query.code || '');
    const state = String(req.query.state || '');
    const meta = consumeOAuthState(state);
    if (!meta) {
      return res.status(400).json({
        ok: false,
        error: 'invalid_or_expired_state',
        message: '请从大屏「添加店铺授权」或连接店铺入口重新发起授权',
      });
    }
    if (!meta.tenantId) {
      return res.status(400).json({ ok: false, error: 'oauth_missing_tenant' });
    }
    if (!code) {
      return res.status(400).json({ ok: false, error: 'missing_code' });
    }
    const result = await handleCallbackByCode(code, {
      oauthRegion: meta.region,
      tenantId: meta.tenantId,
      userId: meta.userId,
    });
    res.json({
      ok: Boolean(result?.ok),
      imported_count: result.imported_count ?? 0,
      updated_count: result.updated_count ?? 0,
      skipped_count: result.skipped_count ?? 0,
      skipped: result.skipped ?? [],
      authorizedShopsDebug: result?.authorizedShopsDebug || null,
      shops: Array.isArray(result?.shops) ? result.shops.map((s) => sanitizeShop(s)) : [],
    });
  } catch (e) {
    res.status(500).json({
      ok: false,
      authorizedShopsDebug: e?.debug || null,
      shops: [],
      error: String(e?.message || e),
    });
  }
});

app.get(
  '/api/tiktok/shops',
  authRequired,
  requireFullAccess,
  requireRole('viewer', 'admin', 'super_admin'),
  (_req, res) => {
    res.json({ shops: readShops().map((s) => sanitizeShop(s)) });
  },
);

app.get('/debug/tiktok-shop', (req, res) => {
  const shops = readShops();
  res.json({
    ok: true,
    total: shops.length,
    shops: shops.map((s) => ({
      shop_name: s.shopName || '',
      shop_id: s.shopId || '',
      shop_cipher_empty: !String(s.shopCipher || '').trim(),
      region: s.region || '',
      seller_base_region: s.sellerBaseRegion || '',
      currency: s.currency || '',
      granted_scopes: s.grantedScopes || s.scope || '',
    })),
  });
});

app.get('/api/tiktok/debug-shop-list', async (req, res) => {
  const shopId = String(req.query.shopId || '');
  const shops = readShops().filter((s) => s && s.enabled);
  const chosen =
    (shopId ? shops.find((s) => String(s.shopId) === shopId) : null) || shops[0] || null;
  if (!chosen || !chosen.accessToken) {
    return res.status(400).json({
      ok: false,
      error: 'no_authorized_shop',
      message: 'No enabled shop with accessToken in storage/shops.json',
    });
  }
  const results = await debugShopList(chosen.accessToken);
  res.json({ ok: true, shopId: chosen.shopId, results });
});

app.get('/debug/tiktok-sign-test', async (req, res) => {
  const shops = readShops().filter((s) => s && s.accessToken);
  if (shops.length === 0) {
    return res.status(400).json({
      ok: false,
      error: 'no_access_token',
      message: 'No accessToken found in storage/shops.json',
    });
  }
  const chosen = shops.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))[0];
  const accessToken = String(chosen.accessToken || '');
  const tokenEdges = accessToken
    ? { prefix: accessToken.slice(0, 8), suffix: accessToken.slice(-8) }
    : { prefix: '', suffix: '' };
  const out = await runAuthorizedShopsSignTest(accessToken);
  res.json({
    ...out,
    apiBaseUrl: process.env.TIKTOK_API_BASE_URL || 'https://open-api.tiktokglobalshop.com',
    method: 'GET',
    path: '/authorization/202309/shops',
    hasAccessTokenHeader: Boolean(accessToken),
    accessTokenPrefix: tokenEdges.prefix,
    accessTokenSuffix: tokenEdges.suffix,
  });
});

app.get('/debug/tiktok-order-test', async (req, res) => {
  const shops = readShops().filter((s) => s && s.accessToken);
  if (shops.length === 0) {
    return res.status(400).json({ ok: false, error: 'no_access_token', message: 'No accessToken found in shops.json' });
  }
  const latest = shops.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))[0];
  const shopCipher = String(latest.shopCipher || latest.shop_cipher || '').trim();
  if (!shopCipher) {
    return res.status(400).json({
      ok: false,
      error: 'shop_cipher_missing',
      shopId: latest.shopId || '',
      shopName: latest.shopName || '',
      region: latest.region || '',
    });
  }

  const rangeUtc8 = buildRangeByOffsetHours(8);
  const rangeTh = buildRangeByOffsetHours(7);
  const endpoint = '/order/202309/orders/search';
  const requestBody = {
    create_time_ge: rangeUtc8.startEpochSec,
    create_time_lt: rangeUtc8.endEpochSec,
  };
  const apiRet = await requestShopApi(latest, {
    method: 'POST',
    pathname: endpoint,
    query: { shop_cipher: shopCipher, page_size: 20 },
    body: requestBody,
    includeDebug: true,
  });
  const dbg = apiRet.debug || {};
  const data = apiRet.data || dbg.responseData || {};
  const list = Array.isArray(data.orders) ? data.orders : Array.isArray(data.order_list) ? data.order_list : [];
  const top3 = list.slice(0, 3).map((o) => ({
    order_id: o.order_id || o.id || '',
    status: o.order_status || o.status || '',
    create_time: o.create_time || o.create_at || '',
    payment_amount: o.payment_amount || o.total_amount || 0,
    currency: o.currency || latest.currency || '',
  }));
  res.json({
    ok: Number(dbg.responseCode ?? apiRet.error?.code ?? -1) === 0 || list.length > 0,
    shop: {
      shopId: latest.shopId || '',
      shopName: latest.shopName || '',
      region: latest.region || '',
      shopCipher,
    },
    timeRange: {
      utcPlus8: rangeUtc8,
      thailandUtcPlus7: rangeTh,
      usedForRequest: 'utcPlus8',
    },
    endpoint,
    body: dbg.requestBody || requestBody,
    bodyForSign: dbg.requestBodyStringSent || dbg.bodyForSign || '',
    response_code: dbg.responseCode ?? apiRet.error?.code ?? null,
    response_message: dbg.responseMessage ?? apiRet.error?.message ?? '',
    raw_body: dbg.rawBody || dbg.body || '',
    orders_count: list.length,
    orders_preview: top3,
    payment_debug: list.slice(0, 20).map((o) => {
      const parsed = pickAmountAndCurrency(o);
      const lineItems = Array.isArray(o?.line_items)
        ? o.line_items
        : Array.isArray(o?.order_line_list)
          ? o.order_line_list
          : [];
      return {
        order_id: o.order_id || o.id || '',
        status: o.order_status || o.status || '',
        payment: parsed.payment || o?.payment || o?.payment_info || null,
        line_items_0: parsed.firstLineItem || lineItems[0] || null,
        parsed_amount: parsed.amount,
        parsed_currency: parsed.currency,
      };
    }),
  });
});

app.get('/debug/tiktok-orders-raw', async (req, res) => {
  const shops = readShops().filter((s) => s && s.accessToken);
  if (shops.length === 0) {
    return res.status(400).json({
      request: null,
      response: { code: null, message: 'no_access_token', data: null },
      rawOrdersCount: 0,
      firstOrder: null,
      pagesFetched: 0,
      pageSize: 100,
      totalRawOrders: 0,
      uniqueOrders: 0,
      nextPageTokensSeen: [],
      firstOrderCreateTime: null,
      lastOrderCreateTime: null,
      requestPages: [],
    });
  }

  const latest = shops.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))[0];
  const shopCipher = String(latest.shopCipher || latest.shop_cipher || '').trim();
  const rangeBangkok = buildRangeByOffsetHours(7);
  const nowUtc = new Date();
  const nowBangkok = new Date(nowUtc.getTime() + 7 * 3600 * 1000);
  const endpoint = '/order/202309/orders/search';
  const body = {
    create_time_ge: rangeBangkok.startEpochSec,
    create_time_lt: rangeBangkok.endEpochSec,
  };
  const maxPages = 20;
  let pageSize = 100;
  let pageToken = '';
  const allOrders = [];
  const uniqueMap = new Map();
  const nextPageTokensSeen = [];
  const requestPages = [];
  let lastRequest = null;
  let lastResponse = null;

  for (let page = 1; page <= maxPages; page += 1) {
    const query = {
      shop_cipher: shopCipher,
      page_size: pageSize,
      ...(pageToken ? { page_token: pageToken } : {}),
    };
    const apiRet = await requestShopApi(latest, {
      method: 'POST',
      pathname: endpoint,
      query,
      body,
      includeDebug: true,
    });
    const dbg = apiRet.debug || {};
    const rawPayload = dbg.rawBody
      ? (() => {
          try {
            return JSON.parse(dbg.rawBody);
          } catch {
            return {};
          }
        })()
      : {};
    const responseData = rawPayload?.data || dbg.responseData || apiRet.data || {};
    const responseCode = rawPayload?.code ?? dbg.responseCode ?? apiRet.error?.code ?? null;
    const responseMessage = rawPayload?.message ?? rawPayload?.msg ?? dbg.responseMessage ?? apiRet.error?.message ?? '';
    const orders = Array.isArray(responseData?.orders)
      ? responseData.orders
      : Array.isArray(responseData?.order_list)
        ? responseData.order_list
        : [];
    const nextToken = String(responseData?.next_page_token || responseData?.page_token || '');

    requestPages.push({
      page,
      page_token_used: pageToken || '',
      response_code: responseCode,
      response_message: responseMessage,
      orders_count: orders.length,
      next_page_token: nextToken,
    });
    if (nextToken) nextPageTokensSeen.push(nextToken);

    lastRequest = {
      method: 'POST',
      endpoint,
      finalUrl: dbg.finalUrl || dbg.orderUrl || '',
      create_time_ge: body.create_time_ge,
      create_time_lt: body.create_time_lt,
      page_size: query.page_size,
      shop_cipher: query.shop_cipher,
      page_token: pageToken || '',
      todayStartEpoch: body.create_time_ge,
      nowEpoch: body.create_time_lt,
      asiaBangkokTime: nowBangkok.toISOString().replace('T', ' ').replace('Z', ''),
      utcTime: nowUtc.toISOString().replace('T', ' ').replace('Z', ''),
    };
    lastResponse = { code: responseCode, message: responseMessage, data: responseData };

    if (!apiRet.ok) {
      const errMsg = String(responseMessage || '').toLowerCase();
      if (pageSize === 100 && (errMsg.includes('page_size') || errMsg.includes('page size'))) {
        pageSize = 50;
        pageToken = '';
        continue;
      }
      break;
    }

    allOrders.push(...orders);
    for (const o of orders) {
      const id = String(o?.order_id || o?.id || '');
      if (!id) continue;
      if (!uniqueMap.has(id)) uniqueMap.set(id, o);
    }

    pageToken = nextToken;
    if (!pageToken || orders.length === 0) break;
  }

  const uniqueOrders = [...uniqueMap.values()];
  const createEpochs = uniqueOrders
    .map((o) => Number(o?.create_time || o?.create_at || 0))
    .filter((n) => Number.isFinite(n) && n > 0);
  const firstOrderCreateTime = createEpochs.length ? Math.min(...createEpochs) : null;
  const lastOrderCreateTime = createEpochs.length ? Math.max(...createEpochs) : null;

  return res.json({
    request: lastRequest,
    response: lastResponse,
    rawOrdersCount: allOrders.length,
    firstOrder: allOrders[0] || null,
    pagesFetched: requestPages.length,
    pageSize,
    totalRawOrders: allOrders.length,
    uniqueOrders: uniqueOrders.length,
    nextPageTokensSeen,
    firstOrderCreateTime,
    lastOrderCreateTime,
    requestPages,
  });
});

function parsePaymentAmountCurrency(order) {
  const payment = order?.payment || order?.payment_info || {};
  const line0 = Array.isArray(order?.line_items)
    ? order.line_items[0]
    : Array.isArray(order?.order_line_list)
      ? order.order_line_list[0]
      : null;
  const amount =
    Number(payment?.total_amount ?? NaN) ||
    Number(payment?.sub_total ?? NaN) ||
    Number(payment?.original_total_product_price ?? NaN) ||
    Number(order?.totalAmount ?? NaN) ||
    0;
  const currency = String(
    payment?.currency || line0?.currency || line0?.currency_code || order?.currency || 'THB',
  ).toUpperCase();
  return { amount: Number.isFinite(amount) ? amount : 0, currency };
}

function toThbCny(amount, currency, thbToCny = 0.2093) {
  const cur = String(currency || 'THB').toUpperCase();
  if (cur === 'THB') return { amount_thb: amount, amount_cny: amount * thbToCny };
  if (cur === 'CNY') return { amount_thb: amount / thbToCny, amount_cny: amount };
  return { amount_thb: amount, amount_cny: amount * thbToCny };
}

function getTodayRangeByOffsetHours(offsetHours = 8) {
  const nowUtcMs = Date.now();
  const shiftedNow = new Date(nowUtcMs + offsetHours * 3600 * 1000);
  const y = shiftedNow.getUTCFullYear();
  const m = shiftedNow.getUTCMonth();
  const d = shiftedNow.getUTCDate();
  const startUtcMs = Date.UTC(y, m, d, 0, 0, 0) - offsetHours * 3600 * 1000;
  return {
    offsetHours,
    todayStartEpoch: Math.floor(startUtcMs / 1000),
    nowEpoch: Math.floor(nowUtcMs / 1000),
  };
}

function parseOrderCreateTimeEpoch(value) {
  if (value == null || value === '') return 0;
  const n = Number(value);
  if (Number.isFinite(n) && n > 0) {
    if (n > 1e12) return Math.floor(n / 1000);
    return Math.floor(n);
  }
  const ts = dayjs(String(value)).valueOf();
  if (!Number.isFinite(ts) || ts <= 0) return 0;
  return Math.floor(ts / 1000);
}

function getOrderCreateTime(order) {
  return Number(
    order?.create_time ??
      order?.createTime ??
      order?.create_time_sec ??
      order?.createTimeSec ??
      order?._raw?.createTime ??
      order?._raw?.create_time ??
      0,
  );
}

function getOrderId(order) {
  return String(order?.order_id ?? order?.orderId ?? order?.id ?? order?.order_sn ?? '');
}

function mapDashboardOrders(rawOrders) {
  return rawOrders.map((o) => {
    const { amount, currency } = parsePaymentAmountCurrency(o);
    const fx = toThbCny(amount, currency, 0.2093);
    const createRaw = o?.create_time || o?.createTime || o?.create_at || '';
    const createEpoch = parseOrderCreateTimeEpoch(getOrderCreateTime(o) || createRaw);
    return {
      order_id: String(o?.order_id || o?.orderId || o?.id || ''),
      status: String(o?.order_status || o?.orderStatus || o?.status || ''),
      shopName: String(o?.shopName || o?.shop_name || ''),
      region: String(o?.region || ''),
      create_time: createRaw,
      create_time_epoch: createEpoch,
      payment_amount: amount,
      currency,
      amount_thb: Number((fx.amount_thb || 0).toFixed(2)),
      amount_cny: Number((fx.amount_cny || 0).toFixed(2)),
      _raw: o,
    };
  });
}

async function getTodayOrdersForDashboard() {
  const range = getTodayRangeByOffsetHours(8);
  const fileInfo = readShopsFileInfo();
  const shopsFileExists = fileInfo.shopsFileExists;
  const shopsFilePath = fileInfo.shopsFilePath;
  const shopsRawType = fileInfo.shopsRawType;
  const shopsRawCount = fileInfo.shopsRawCount;
  const allShopsFromFile = fileInfo.shops;
  const eligibleShops = listEligibleDashboardShops(allShopsFromFile);
  const selectedShop = pickDashboardShop(allShopsFromFile);
  const selectedCipher = selectedShop ? shopCipherString(selectedShop) : '';
  const selectedAccessToken = selectedShop ? String(selectedShop.accessToken || '').trim() : '';
  const selectedScopes = selectedShop ? grantedScopesString(selectedShop) : '';
  const expireAtMs = dayjs(selectedShop?.accessTokenExpiresAt || '').valueOf();
  const accessTokenExpireIn =
    Number.isFinite(expireAtMs) && expireAtMs > 0 ? Math.floor((expireAtMs - Date.now()) / 1000) : null;
  const tokenExpired = typeof accessTokenExpireIn === 'number' ? accessTokenExpireIn <= 0 : false;
  const scopeOk = selectedScopes.includes('seller.order.info');

  let precheck = { ok: true, reason: '' };
  if (!shopsFileExists) precheck = { ok: false, reason: 'shops_json_missing' };
  else if (shopsRawCount === 0) precheck = { ok: false, reason: 'shops_file_empty' };
  else if (eligibleShops.length === 0) precheck = { ok: false, reason: 'no_eligible_shop' };
  else if (!selectedShop) precheck = { ok: false, reason: 'no_eligible_shop' };
  else if (!selectedAccessToken) precheck = { ok: false, reason: 'access_token_missing' };
  else if (!selectedCipher) precheck = { ok: false, reason: 'shop_cipher_missing' };
  else if (tokenExpired) precheck = { ok: false, reason: 'access_token_expired' };
  else if (!scopeOk) precheck = { ok: false, reason: 'scope_missing_seller_order_info' };

  const allOrders = [];
  const requestPages = [];
  let pagesFetched = 0;
  let requestAttempted = false;
  let response = null;

  if (precheck.ok && selectedShop) {
    requestAttempted = true;
    const shop = selectedShop;
    const ret = await fetchTodayOrders(shop);
    if (!ret?.ok) {
      const pageInfo = {
        shopId: shop.shopId,
        page: 1,
        page_token_used: '',
        response_code: ret?.error?.code ?? null,
        response_message: ret?.error?.message || ret?.error?.type || 'fetch_failed',
        orders_count: 0,
        next_page_token: '',
      };
      requestPages.push(pageInfo);
      response = {
        code: ret?.error?.code ?? null,
        message: ret?.error?.message || ret?.error?.type || 'fetch_failed',
        data: ret?.debug?.responseData ?? null,
      };
    } else {
      pagesFetched += Number(ret.pagesFetched || 0);
      allOrders.push(...(Array.isArray(ret.data) ? ret.data : []));
      if (Array.isArray(ret.requestPages)) {
        requestPages.push(...ret.requestPages.map((p) => ({ shopId: shop.shopId, ...p })));
      }
      const lastPage = Array.isArray(ret.requestPages) && ret.requestPages.length > 0 ? ret.requestPages[ret.requestPages.length - 1] : null;
      response = {
        code: lastPage?.response_code ?? 0,
        message: lastPage?.response_message ?? 'ok',
        data: null,
      };
      if (ret?.requestBody && typeof ret.requestBody === 'object') {
        response.requestBody = ret.requestBody;
      }
    }
  }

  let missingOrderIdCount = Number(
    requestPages.reduce((sum, p) => sum + Number(p?.missing_order_id_count || 0), 0),
  );
  const dedup = new Map();
  for (const o of allOrders) {
    const id = getOrderId(o);
    if (!id) {
      missingOrderIdCount += 1;
      continue;
    }
    if (!dedup.has(id)) dedup.set(id, o);
  }
  const uniqueOrders = [...dedup.values()];
  const uniqueBeforeDateFilter = uniqueOrders.length;
  const allExtractedOrdersCount = Array.isArray(requestPages)
    ? requestPages.reduce((sum, p) => sum + Number(p?.orders_extracted_count || 0), 0)
    : uniqueOrders.length;

  const debug_sample_orders = allOrders.slice(0, 5).map((order) => {
    const raw = order?._raw && typeof order._raw === 'object' ? order._raw : null;
    return {
      id: String(raw?.id ?? order?.id ?? ''),
      order_id: String(raw?.order_id ?? order?.order_id ?? order?.orderId ?? ''),
      create_time: raw?.create_time ?? order?.create_time ?? order?.createTime ?? null,
      payment_total_amount: raw?.payment?.total_amount ?? order?.payment?.total_amount ?? null,
    };
  });

  const extractedEpochs = uniqueOrders
    .map((o) => parseOrderCreateTimeEpoch(getOrderCreateTime(o)))
    .filter((n) => Number.isFinite(n) && n > 0);
  const minExtractedCreateTime = extractedEpochs.length > 0 ? Math.min(...extractedEpochs) : null;
  const maxExtractedCreateTime = extractedEpochs.length > 0 ? Math.max(...extractedEpochs) : null;
  const minExtractedReadable = minExtractedCreateTime ? dayjs.unix(minExtractedCreateTime).format('YYYY-MM-DD HH:mm:ss') : null;
  const maxExtractedReadable = maxExtractedCreateTime ? dayjs.unix(maxExtractedCreateTime).format('YYYY-MM-DD HH:mm:ss') : null;

  const filteredOutReasonSample = [];
  const todayOrders = [];
  for (const order of uniqueOrders) {
    const createTime = parseOrderCreateTimeEpoch(getOrderCreateTime(order));
    if (createTime >= range.todayStartEpoch && createTime <= range.nowEpoch) {
      todayOrders.push(order);
      continue;
    }
    if (filteredOutReasonSample.length < 10) {
      let reason = 'out_of_range';
      if (!Number.isFinite(createTime) || createTime <= 0) reason = 'invalid_create_time';
      else if (createTime < range.todayStartEpoch) reason = 'before_today';
      else if (createTime > range.nowEpoch) reason = 'after_now';
      filteredOutReasonSample.push({
        order_id: String(order?.orderId || order?.order_id || order?.id || ''),
        reason,
        createTimeEpoch: createTime || 0,
        createTimeReadable:
          Number.isFinite(createTime) && createTime > 0
            ? dayjs.unix(createTime).format('YYYY-MM-DD HH:mm:ss')
            : null,
      });
    }
  }

  const orderEpochs = todayOrders
    .map((o) => parseOrderCreateTimeEpoch(getOrderCreateTime(o)))
    .filter((n) => Number.isFinite(n) && n > 0);
  const firstOrderCreateTime = orderEpochs.length > 0 ? Math.min(...orderEpochs) : null;
  const lastOrderCreateTime = orderEpochs.length > 0 ? Math.max(...orderEpochs) : null;

  return {
    source: 'tiktok_open_api_live',
    usingCache: false,
    shopsFilePath,
    shopsFileExists,
    shopsRawType,
    shopsRawCount,
    shopsCount: eligibleShops.length,
    selectedShop: selectedShop
      ? {
          shopName: selectedShop.shopName || '',
          shopId: selectedShop.shopId || '',
          region: selectedShop.region || '',
          hasAccessToken: Boolean(selectedAccessToken),
          accessTokenPrefix: selectedAccessToken ? selectedAccessToken.slice(0, 8) : '',
          accessTokenExpireIn,
          hasRefreshToken: Boolean(String(selectedShop?.refreshToken || '').trim()),
          hasShopCipher: Boolean(selectedCipher),
          shopCipherPrefix: selectedCipher ? selectedCipher.slice(0, 8) : '',
          grantedScopes: selectedScopes,
        }
      : {
          shopName: '',
          shopId: '',
          region: '',
          hasAccessToken: false,
          accessTokenPrefix: '',
          accessTokenExpireIn: null,
          hasRefreshToken: false,
          hasShopCipher: false,
          shopCipherPrefix: '',
          grantedScopes: '',
        },
    precheck,
    requestAttempted,
    response,
    requestBody:
      (response && typeof response.requestBody === 'object' && response.requestBody) || null,
    todayStartEpoch: range.todayStartEpoch,
    nowEpoch: range.nowEpoch,
    pagesFetched,
    allExtractedOrdersCount,
    missingOrderIdCount,
    uniqueBeforeDateFilter,
    todayFilteredOrdersCount: todayOrders.length,
    uniqueOrders: todayOrders.length,
    requestPages,
    filteredOutReasonSample,
    debug_sample_orders,
    minExtractedCreateTime,
    maxExtractedCreateTime,
    minExtractedReadable,
    maxExtractedReadable,
    firstOrderCreateTime,
    lastOrderCreateTime,
    orders: todayOrders,
  };
}

app.get('/api/dashboard/ping', (req, res) => {
  res.set({
    'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
    Pragma: 'no-cache',
    Expires: '0',
  });
  res.json({ ok: true, route: 'dashboard' });
});

app.get('/debug/current-orders-source', async (req, res) => {
  const live = await getTodayOrdersForDashboard();
  res.json({
    source: 'tiktok_open_api_live',
    usingCache: false,
    shopsFilePath: live.shopsFilePath,
    shopsFileExists: live.shopsFileExists,
    shopsRawType: live.shopsRawType,
    shopsRawCount: live.shopsRawCount,
    shopsCount: live.shopsCount,
    selectedShop: live.selectedShop,
    precheck: live.precheck,
    requestAttempted: live.requestAttempted,
    requestPages: live.requestPages,
    response: live.response,
    requestBody: live.requestBody,
    pagesFetched: live.pagesFetched,
    allExtractedOrdersCount: live.allExtractedOrdersCount,
    missingOrderIdCount: live.missingOrderIdCount,
    uniqueBeforeDateFilter: live.uniqueBeforeDateFilter,
    todayFilteredOrdersCount: live.todayFilteredOrdersCount,
    uniqueOrders: live.uniqueOrders,
    todayStartEpoch: live.todayStartEpoch,
    nowEpoch: live.nowEpoch,
    filteredOutReasonSample: live.filteredOutReasonSample,
    debug_sample_orders: live.debug_sample_orders,
    minExtractedCreateTime: live.minExtractedCreateTime,
    maxExtractedCreateTime: live.maxExtractedCreateTime,
    minExtractedReadable: live.minExtractedReadable,
    maxExtractedReadable: live.maxExtractedReadable,
    firstOrderCreateTime: live.firstOrderCreateTime,
    lastOrderCreateTime: live.lastOrderCreateTime,
  });
});

app.get('/debug/tiktok-token-shop-status', (req, res) => {
  const shops = readShops();
  const enabled = shops.filter((s) => s && s.enabled !== false);
  const selected =
    enabled
      .slice()
      .sort((a, b) => String(b?.updatedAt || '').localeCompare(String(a?.updatedAt || '')))[0] || null;
  const cipher = String(selected?.shopCipher || selected?.shop_cipher || selected?.rawTokenPayload?.shop_cipher || '').trim();
  const accessToken = String(selected?.accessToken || '').trim();
  const expireAtMs = dayjs(selected?.accessTokenExpiresAt || '').valueOf();
  const accessTokenExpireIn =
    Number.isFinite(expireAtMs) && expireAtMs > 0 ? Math.floor((expireAtMs - Date.now()) / 1000) : null;
  const scopesRaw = selected?.grantedScopes || selected?.scope || '';
  const grantedScopes = Array.isArray(scopesRaw) ? scopesRaw.join(',') : String(scopesRaw || '');
  res.json({
    shopsCount: shops.length,
    shopName: selected?.shopName || '',
    shopId: selected?.shopId || '',
    hasShopCipher: Boolean(cipher),
    hasAccessToken: Boolean(accessToken),
    accessTokenExpireIn,
    grantedScopes,
    updatedAt: selected?.updatedAt || '',
  });
});

app.post(
  '/api/tiktok/shops/:shopId/disable',
  authRequired,
  requireFullAccess,
  requireRole('admin', 'super_admin'),
  (req, res) => {
    const shop = patchShopEnabled(req.params.shopId, false);
    if (!shop) return res.status(404).json({ ok: false, error: 'shop_not_found' });
    res.json({ ok: true, shop: sanitizeShop(shop) });
  },
);

app.post(
  '/api/tiktok/shops/:shopId/enable',
  authRequired,
  requireFullAccess,
  requireRole('admin', 'super_admin'),
  (req, res) => {
    const shop = patchShopEnabled(req.params.shopId, true);
    if (!shop) return res.status(404).json({ ok: false, error: 'shop_not_found' });
    res.json({ ok: true, shop: sanitizeShop(shop) });
  },
);

app.post(
  '/api/tiktok/collect-now',
  authRequired,
  requireFullAccess,
  requireRole('admin', 'super_admin'),
  collectNowLimiter,
  async (req, res) => {
    try {
      const baseCurrency = normalizeBaseCurrency(req.body?.baseCurrency);
      const targetCurrency = normalizeTargetCurrency(req.body?.targetCurrency);
      const payload = await collectOnce({ baseCurrency, targetCurrency });
      res.json({ ok: true, meta: payload?.meta || null, summary: payload?.summary || null });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  },
);

const { registerLegacyRoutes } = require('./routes/legacyRoutes');
registerLegacyRoutes(app, { storageDir: STORAGE_DIR });

app.get('/api/debug/tiktok-snapshot', (req, res) => {
  const file = path.join(STORAGE_DIR, 'tiktokSnapshot.json');
  res.json(readJsonSafe(file) || { error: 'file_missing_or_invalid', path: file });
});

app.get('/api/health', async (req, res) => {
  try {
    const body = await runHealthCheck(STORAGE_DIR);
    res.status(body.status === 'unhealthy' ? 503 : 200).json({
      ...body,
      service: 'gmv-dashboard-api',
      version: SERVICE_VERSION,
      startedAt: SERVICE_STARTED_AT,
    });
  } catch (e) {
    res.status(503).json({
      status: 'unhealthy',
      error: String(e?.message || e),
      service: 'gmv-dashboard-api',
      version: SERVICE_VERSION,
    });
  }
});

app.get('/api/metrics', optionalAuth, (req, res) => {
  res.set({
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    Pragma: 'no-cache',
  });
  const metrics = getMetricsSnapshot();
  res.json({
    ok: true,
    version: SERVICE_VERSION,
    dataSourcePrimary: isMysqlPrimaryDashboard() ? 'mysql' : 'orders-cache.json',
    ...metrics,
  });
});


const frontendDist = path.join(__dirname, '../frontend/dist');

app.use(express.static(frontendDist));

/** SPA：/login、/shops 等前端路由刷新时返回 index.html（不吞 /api、/debug） */
app.use((req, res, next) => {
  if (req.method !== 'GET') return next();
  if (req.path.startsWith('/api') || req.path.startsWith('/debug')) return next();
  return res.sendFile(path.join(frontendDist, 'index.html'));
});

console.log(
  'routes: SaaS /api/dashboard/* | legacy /api/dashboard (war-room) | ops /api/ops/* | health /api/health | primary:',
  isMysqlPrimaryDashboard() ? 'mysql' : 'orders-cache.json',
);

app.listen(PORT, () => {
  console.log(`GMV API running on http://localhost:${PORT}`);
  console.log(
    `[gmv] ${SERVICE_VERSION} | dashboard primary=${isMysqlPrimaryDashboard() ? 'mysql' : 'orders-cache'} | sync: PM2 tiktok-openapi-sync`,
  );
});


