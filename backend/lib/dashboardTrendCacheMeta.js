'use strict';

const { isTrendCacheEndpoint } = require('./dashboardTrendTtl');

/**
 * 趋势端点缓存元数据（gmv-compare 写 meta；order-volume 等数组端点用 __trendRows 包装）
 * @typedef {{
 *   cacheSource: string,
 *   stale?: boolean,
 *   refreshPending?: boolean,
 *   cacheMiss?: boolean,
 *   reason?: string,
 * }} TrendCacheMeta
 */

/**
 * @param {string} endpoint
 * @param {unknown} val
 * @param {TrendCacheMeta} cacheMeta
 */
function stampTrendCacheMeta(endpoint, val, cacheMeta) {
  const meta = {
    cacheSource: String(cacheMeta.cacheSource || ''),
    stale: Boolean(cacheMeta.stale),
    refreshPending: Boolean(cacheMeta.refreshPending),
    ...(cacheMeta.cacheMiss ? { cacheMiss: true } : {}),
    ...(cacheMeta.reason ? { reason: String(cacheMeta.reason) } : {}),
  };

  if (endpoint === 'gmv-compare' && val && typeof val === 'object' && !Array.isArray(val)) {
    const o = /** @type {Record<string, unknown>} */ (val);
    const prevMeta =
      o.meta && typeof o.meta === 'object' && !Array.isArray(o.meta)
        ? /** @type {Record<string, unknown>} */ (o.meta)
        : {};
    return {
      ...o,
      meta: { ...prevMeta, ...meta },
      cache: meta,
    };
  }

  if (Array.isArray(val)) {
    return { __trendRows: val, __trendCache: meta };
  }

  if (val && typeof val === 'object' && Array.isArray(/** @type {{ rows?: unknown[] }} */ (val).rows)) {
    return { __trendRows: val, __trendCache: meta };
  }

  return val;
}

/**
 * @param {unknown} stamped
 * @returns {{ payload: unknown, cacheMeta: TrendCacheMeta|null }}
 */
function unwrapTrendCachePayload(stamped) {
  if (stamped && typeof stamped === 'object' && !Array.isArray(stamped)) {
    const o = /** @type {{ __trendRows?: unknown, __trendCache?: TrendCacheMeta }} */ (stamped);
    if (o.__trendRows != null) {
      return {
        payload: o.__trendRows,
        cacheMeta: o.__trendCache || null,
      };
    }
  }
  if (stamped && typeof stamped === 'object' && !Array.isArray(stamped)) {
    const o = /** @type {Record<string, unknown>} */ (stamped);
    const m =
      o.cache && typeof o.cache === 'object'
        ? /** @type {TrendCacheMeta} */ (o.cache)
        : o.meta && typeof o.meta === 'object'
          ? /** @type {TrendCacheMeta} */ ({
              cacheSource: /** @type {Record<string, unknown>} */ (o.meta).cacheSource,
              stale: /** @type {Record<string, unknown>} */ (o.meta).stale,
              refreshPending: /** @type {Record<string, unknown>} */ (o.meta).refreshPending,
              reason: /** @type {Record<string, unknown>} */ (o.meta).reason,
            })
          : null;
    return { payload: stamped, cacheMeta: m };
  }
  return { payload: stamped, cacheMeta: null };
}

/**
 * cache miss 且无 stale：返回 pending 结构（非“无数据”空图）
 * @param {string} endpoint
 * @param {import('../modules/dashboard/filterContract').DashboardFilterContract} contract
 * @param {Record<string, string|number|boolean|undefined>} [extra]
 */
function buildTrendPendingPlaceholder(endpoint, contract, extra = {}) {
  const groupBy = String(extra?.groupBy || 'hour').toLowerCase() === 'day' ? 'day' : 'hour';
  if (endpoint === 'gmv-compare') {
    return {
      today: [],
      yesterday: [],
      summary: { todayTotal: null, yesterdayTotal: null, changePercent: null },
      gmv_currency: 'USD',
      meta: {
        groupBy,
        orderFilter: contract?.orderFilter,
        timeRange: contract?.timeRange,
        seriesSource: 'cache-miss',
        seriesPending: true,
        refreshPending: true,
        stale: false,
        cacheSource: 'pending',
        cacheMiss: true,
      },
    };
  }
  return [];
}

/** 只读 API cache miss：空结构 + cacheMiss，禁止页面链路打 MySQL */
function buildReadonlyCacheMissShape(endpoint, contract, extra = {}) {
  const ep = String(endpoint || '').trim();
  if (ep === 'summary') {
    return {
      orders: 0,
      gmv: 0,
      shop_count: 0,
      gmv_currency: 'USD',
      ok: true,
      cacheMiss: true,
      refreshPending: true,
      cacheSource: 'cache-miss',
    };
  }
  if (ep === 'ranking') {
    return { items: [], shops: [], ok: true, cacheMiss: true, refreshPending: true, cacheSource: 'cache-miss' };
  }
  if (ep === 'product-ranking') {
    return { items: [], ok: true, cacheMiss: true, refreshPending: true, cacheSource: 'cache-miss' };
  }
  return buildTrendPendingPlaceholder(ep, contract, extra);
}

/**
 * order-volume / trend 缓存必须含 kpi_totals.gmv_usd（禁止仅 points 的旧结构）
 * @param {unknown} val
 */
function trendPayloadHasKpiTotals(val) {
  if (val == null) return false;
  if (Array.isArray(val)) return false;
  let body = val;
  if (typeof val === 'object' && /** @type {{ __trendRows?: unknown }} */ (val).__trendRows != null) {
    body = /** @type {{ __trendRows?: unknown }} */ (val).__trendRows;
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  const t = /** @type {{ gmv_usd?: unknown, gmv_usd_raw_sum?: unknown }} */ (body).kpi_totals;
  if (!t || typeof t !== 'object') return false;
  const gmv = Number(t.gmv_usd);
  return Number.isFinite(gmv);
}

/**
 * @param {string} endpoint
 * @param {unknown} val
 * @param {(v: unknown) => number|undefined} [rowsPick]
 * @param {(v: unknown) => number|undefined} [pointsPick]
 */
function trendPayloadIsEmpty(endpoint, val, rowsPick, pointsPick) {
  if (isTrendCacheEndpoint(endpoint) && val != null && !trendPayloadHasKpiTotals(val)) {
    return true;
  }
  if (endpoint === 'gmv-compare' && val && typeof val === 'object') {
    const o = /** @type {{ today?: unknown[], yesterday?: unknown[] }} */ (val);
    const n = (o.today?.length || 0) + (o.yesterday?.length || 0);
    return n === 0;
  }
  let rows = rowsPick ? rowsPick(val) : undefined;
  if (rows == null && val && typeof val === 'object' && Array.isArray(val.rows)) {
    rows = val.rows.length;
  }
  if (rows == null && Array.isArray(val)) rows = val.length;
  const points = pointsPick ? pointsPick(val) : rows;
  const n = rows != null ? rows : points != null ? points : 0;
  return Number(n) === 0;
}

module.exports = {
  stampTrendCacheMeta,
  unwrapTrendCachePayload,
  buildTrendPendingPlaceholder,
  buildReadonlyCacheMissShape,
  trendPayloadHasKpiTotals,
  trendPayloadIsEmpty,
};
