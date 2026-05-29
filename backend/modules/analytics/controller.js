'use strict';

const metricService = require('./metricService');
const { withTimeWindow } = require('./timeWindowService');
const summaryService = require('./summaryService');
const { mapSaasMysqlError } = require('../../middlewares/saasMysqlOnly');
const {
  buildAuthorityServiceQuery,
  attachDebugAuthority,
} = require('../../lib/dashboardQueryAuthority');

const SENSITIVE_QUERY_KEYS = new Set([
  'token',
  'password',
  'access_token',
  'refresh_token',
  'authorization',
  'auth',
  'secret',
]);

const WIDGET_SOURCES = {
  topProducts: 'metricService.getProductRanking',
  topShops: 'metricService.getShopRanking',
  shopTrend: 'metricService.getOrderTrend',
  recentOrders: 'realtimeService.listOrders',
  summary: 'summaryService.getUnifiedSummary',
};

function sanitizeAnalyticsQuery(q) {
  const out = {};
  for (const [k, v] of Object.entries(q || {})) {
    if (SENSITIVE_QUERY_KEYS.has(String(k).toLowerCase())) continue;
    out[k] = v;
  }
  return out;
}

/** @param {string} endpoint @param {import('express').Request} req @param {unknown} e @param {{ sqlTag?: string }} [meta] */
function logAnalyticsApiError(endpoint, req, e, meta = {}) {
  const err = /** @type {{ message?: string, sqlTag?: string }} */ (e);
  console.error('[analytics-api-error]', {
    endpoint,
    sqlTag: meta.sqlTag || err.sqlTag || null,
    params: sanitizeAnalyticsQuery(req.query),
    message: String(err?.message || e),
  });
}

function isMissingExchangeRateError(e) {
  const code = e && e.code ? String(e.code) : '';
  return code === 'MISSING_EXCHANGE_RATE' || e?.name === 'MissingExchangeRateError';
}

/**
 * @param {import('express').Response} res
 * @param {unknown} e
 * @param {{ softExchangeRate?: boolean }} [opts]
 */
function mysqlErr(res, e, opts = {}) {
  if (opts.softExchangeRate && isMissingExchangeRateError(e)) {
    console.warn('[analytics-api-warning] missing exchange rate (degraded)', {
      currency: e?.currency,
      missing: e?.missingCurrencies,
    });
    return null;
  }
  try {
    const { mapExchangeRateHttpError } = require('../../modules/exchangeRateService');
    const fx = mapExchangeRateHttpError(res, e);
    if (fx) return fx;
  } catch {
    /* ignore */
  }
  const blocked = mapSaasMysqlError(res, e);
  if (blocked) return blocked;
  const code = e && e.code ? String(e.code) : '';
  if (code === 'mysql_unavailable') {
    return res.status(503).json({ error: 'MYSQL_REQUIRED', message: 'MySQL 不可用' });
  }
  return res.status(500).json({ error: 'analytics_failed', message: String(e?.message || e) });
}

function respondWithAuthority(res, tenantId, rawQuery, source, payload) {
  const { contract, query } = buildAuthorityServiceQuery(rawQuery, tenantId);
  const body = attachDebugAuthority({ ok: true, ...payload }, contract, source);
  return res.json(withTimeWindow(body, tenantId, query));
}

async function topProducts(req, res) {
  const q = req.query || {};
  const tenantId = Number(req.tenantId);
  try {
    const out = await metricService.getAnalyticsTopProducts(tenantId, q, req.auth);
    return respondWithAuthority(res, tenantId, q, WIDGET_SOURCES.topProducts, {
      data: out,
      list: out,
      items: out,
    });
  } catch (e) {
    const blocked = mysqlErr(res, e, { softExchangeRate: true });
    if (blocked) return blocked;
    return respondWithAuthority(res, tenantId, q, WIDGET_SOURCES.topProducts, {
      data: [],
      list: [],
      items: [],
      warning: 'MISSING_EXCHANGE_RATE',
    });
  }
}

async function shopTrend(req, res) {
  const q = req.query || {};
  const tenantId = Number(req.tenantId);
  try {
    const out = await metricService.getAnalyticsShopTrend(tenantId, q, req.auth);
    return respondWithAuthority(res, tenantId, q, WIDGET_SOURCES.shopTrend, {
      data: out,
      list: out,
      series: out,
    });
  } catch (e) {
    const blocked = mysqlErr(res, e, { softExchangeRate: true });
    if (blocked) return blocked;
    return respondWithAuthority(res, tenantId, q, WIDGET_SOURCES.shopTrend, {
      data: [],
      list: [],
      series: [],
      warning: 'MISSING_EXCHANGE_RATE',
    });
  }
}

async function topShops(req, res) {
  const q = req.query || {};
  const tenantId = Number(req.tenantId);
  try {
    const out = await metricService.getAnalyticsTopShops(tenantId, q, req.auth);
    return respondWithAuthority(res, tenantId, q, WIDGET_SOURCES.topShops, {
      data: out,
      list: out,
      items: out,
    });
  } catch (e) {
    const blocked = mysqlErr(res, e, { softExchangeRate: true });
    if (blocked) return blocked;
    return respondWithAuthority(res, tenantId, q, WIDGET_SOURCES.topShops, {
      data: [],
      list: [],
      items: [],
      warning: 'MISSING_EXCHANGE_RATE',
    });
  }
}

async function recentOrders(req, res) {
  const q = req.query || {};
  const tenantId = Number(req.tenantId);
  try {
    const out = await metricService.getAnalyticsRecentOrders(tenantId, q, req.auth);
    return respondWithAuthority(res, tenantId, q, WIDGET_SOURCES.recentOrders, {
      data: out,
      list: out,
      orders: out,
    });
  } catch (e) {
    logAnalyticsApiError('recent-orders', req, e, { sqlTag: 'recent-orders-list' });
    const blocked = mysqlErr(res, e, { softExchangeRate: true });
    if (blocked) return blocked;
    return respondWithAuthority(res, tenantId, q, WIDGET_SOURCES.recentOrders, {
      data: [],
      list: [],
      orders: [],
      warning: 'MISSING_EXCHANGE_RATE',
    });
  }
}

async function searchSku(req, res) {
  const q = req.query || {};
  const tenantId = Number(req.tenantId);
  try {
    const out = await metricService.searchAnalyticsSku(tenantId, q, req.auth);
    return respondWithAuthority(res, tenantId, q, 'analyticsService.searchSku', {
      data: out,
      list: out,
      items: out,
    });
  } catch (e) {
    return mysqlErr(res, e);
  }
}

async function gmvCompare(req, res) {
  const raw = req.query || {};
  const q = {
    ...raw,
    shop_id: raw.shop_id ?? raw.shopId ?? raw.selectedShopId,
    groupBy: raw.groupBy ?? raw.group_by,
    orderFilter: raw.orderFilter ?? raw.status,
  };
  try {
    const tenantId = Number(req.tenantId);
    const out = await metricService.getAnalyticsGmvCompare(tenantId, q, {
      skipShopGate: false,
      skipTenant: false,
    });
    const { contract, query } = buildAuthorityServiceQuery(q, tenantId);
    const body = attachDebugAuthority({ ok: true, ...out }, contract, 'metricService.getGmvCompare');
    res.json(withTimeWindow(body, tenantId, query));
  } catch (e) {
    const code = e && e.code ? String(e.code) : '';
    if (code === 'mysql_unavailable') {
      return mysqlErr(res, e);
    }
    console.error('[gmv-compare] controller', e?.message || e);
    const hours = Math.min(720, Math.max(1, Number(raw.hours) || 24));
    const groupBy = String(raw.groupBy ?? raw.group_by ?? 'hour').toLowerCase() === 'day' ? 'day' : 'hour';
    const tenantId = Number(req.tenantId);
    const { contract, query } = buildAuthorityServiceQuery(q, tenantId);
    const body = attachDebugAuthority(
      {
        ok: true,
        today: [],
        yesterday: [],
        summary: { todayTotal: 0, yesterdayTotal: 0, changePercent: null },
        gmv_currency: 'USD',
        meta: {
          hours,
          groupBy,
          seriesEmpty: true,
          emptyReason: 'query_failed',
        },
      },
      contract,
      'metricService.getGmvCompare',
    );
    res.json(withTimeWindow(body, tenantId, query));
  }
}

async function statusDebug(req, res) {
  const q = req.query || {};
  const tenantId = Number(req.tenantId);
  try {
    const out = await metricService.getAnalyticsStatusDebug(tenantId, q, req.auth);
    return respondWithAuthority(res, tenantId, q, 'analyticsService.getStatusDebugCounts', { data: out });
  } catch (e) {
    return mysqlErr(res, e);
  }
}

async function summary(req, res) {
  const q = req.query || {};
  const tenantId = Number(req.tenantId);
  try {
    const out = await summaryService.getUnifiedSummary(tenantId, q, req.auth);
    return respondWithAuthority(res, tenantId, q, WIDGET_SOURCES.summary, {
      module: 'analytics',
      ...out,
    });
  } catch (e) {
    const blocked = mysqlErr(res, e, { softExchangeRate: true });
    if (blocked) return blocked;
    return respondWithAuthority(res, tenantId, q, WIDGET_SOURCES.summary, {
      module: 'analytics',
      orders: 0,
      gmv: 0,
      shops: 0,
      trends: [],
      warning: 'MISSING_EXCHANGE_RATE',
    });
  }
}

module.exports = {
  summary,
  topProducts,
  shopTrend,
  topShops,
  recentOrders,
  searchSku,
  gmvCompare,
  statusDebug,
};
