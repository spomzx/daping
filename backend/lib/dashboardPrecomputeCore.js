'use strict';

/**
 * Dashboard 后台预计算：唯一允许在请求外执行 MySQL 聚合的入口
 */

const { buildDashboardCacheKey, persistDashboardCaches } = require('./dashboardCache');
const { parseDashboardFilterQuery } = require('../modules/dashboard/filterContract');
const { precomputeTtlMs } = require('./dashboardPrecomputeTtl');
const {
  readDashboardTableCache,
  isTableCacheEnabled,
} = require('./dashboardTableCache');
const { snapshotWarmSkipReason } = require('./dashboardSnapshotCache');

const ENDPOINTS = ['gmv-compare', 'order-volume', 'summary', 'ranking', 'product-ranking'];
const TIME_RANGES_TODAY = ['today'];
const TIME_RANGES_HISTORY = ['yesterday', 'last7', 'last30'];
const ORDER_FILTERS = ['paid', 'all', 'valid', 'cancelled', 'sample'];
const MARKETS = ['ALL', 'TH', 'MY', 'PH', 'VN', 'SG'];
const SHOP_ID = 'all';

/** @type {Map<string, Promise<unknown>>} */
const jobInflight = new Map();

function trendGroupBy(timeRange) {
  const tr = String(timeRange || 'today').toLowerCase();
  return tr === 'last7' || tr === 'last30' || tr === 'custom' ? 'day' : 'hour';
}

/**
 * @param {string} scope
 * @param {number} tenantId
 */
function buildPrecomputeJobs(scope, tenantId) {
  const timeRanges = scope === 'today' ? TIME_RANGES_TODAY : TIME_RANGES_HISTORY;
  const endpointOrder =
    scope === 'today'
      ? ['gmv-compare', 'order-volume', 'summary', 'ranking', 'product-ranking']
      : ['gmv-compare', 'order-volume', 'summary', 'ranking', 'product-ranking'];
  const jobs = [];
  for (const endpoint of endpointOrder) {
    for (const timeRange of timeRanges) {
      for (const orderFilter of ORDER_FILTERS) {
        for (const market of MARKETS) {
          const extra =
            endpoint === 'gmv-compare' || endpoint === 'order-volume'
              ? { groupBy: trendGroupBy(timeRange) }
              : {};
          jobs.push({
            tenantId,
            endpoint,
            timeRange,
            orderFilter,
            market,
            shopId: SHOP_ID,
            extra,
          });
        }
      }
    }
  }
  return jobs;
}

/**
 * @param {ReturnType<typeof buildPrecomputeJobs>[number]} job
 */
function buildPrecomputeQuery(job) {
  const market = String(job.market || 'ALL').trim().toUpperCase() || 'ALL';
  return {
    shopId: SHOP_ID,
    shop_id: SHOP_ID,
    market,
    region: market === 'ALL' ? 'all' : market.toLowerCase(),
    timeRange: job.timeRange,
    range: job.timeRange,
    orderFilter: job.orderFilter,
    precompute: '1',
    refreshSource: 'precompute',
    scheduler: '1',
    groupBy: job.extra?.groupBy,
    group_by: job.extra?.groupBy,
  };
}

/**
 * @param {string} endpoint
 * @param {unknown} val
 */
function rowsPickForEndpoint(endpoint, val) {
  if (endpoint === 'gmv-compare' && val && typeof val === 'object') {
    const o = /** @type {{ today?: unknown[], yesterday?: unknown[] }} */ (val);
    return (o.today?.length || 0) + (o.yesterday?.length || 0);
  }
  if (Array.isArray(val)) return val.length;
  if (val && typeof val === 'object' && Array.isArray(/** @type {{ rows?: unknown[] }} */ (val).rows)) {
    return /** @type {{ rows: unknown[] }} */ (val).rows.length;
  }
  if (val && typeof val === 'object' && Array.isArray(/** @type {{ items?: unknown[] }} */ (val).items)) {
    return /** @type {{ items: unknown[] }} */ (val).items.length;
  }
  return 0;
}

/**
 * @param {ReturnType<typeof buildPrecomputeJobs>[number]} job
 */
async function loadPrecomputePayload(job) {
  const q = buildPrecomputeQuery(job);
  const tenantId = job.tenantId;
  switch (job.endpoint) {
    case 'summary': {
      const { getTodayOrderSummary } = require('../services/orderMetricsService');
      return getTodayOrderSummary(tenantId, q, null);
    }
    case 'ranking': {
      const { queryDashboardRanking } = require('../modules/dashboard/rankingQuery');
      return queryDashboardRanking(tenantId, { ...q, limit: 30, sort: 'gmv' });
    }
    case 'product-ranking': {
      const { getProductRanking } = require('../services/orderMetricsService');
      const out = await getProductRanking(tenantId, { ...q, limit: 20 });
      return out?.items ?? out;
    }
    case 'gmv-compare': {
      const { getGmvCompare } = require('../services/orderMetricsService');
      return getGmvCompare(tenantId, q);
    }
    case 'order-volume': {
      const { getOrderTrend } = require('../services/orderMetricsService');
      const out = await getOrderTrend(tenantId, q, null, 'order-volume');
      return out?.rows ?? out;
    }
    default:
      throw new Error(`precompute_unknown_endpoint:${job.endpoint}`);
  }
}

/**
 * @param {ReturnType<typeof buildPrecomputeJobs>[number]} job
 */
async function isPrecomputeJobFresh(job) {
  const q = buildPrecomputeQuery(job);
  const contract = parseDashboardFilterQuery(q, job.tenantId);
  const cacheKey = buildDashboardCacheKey(job.endpoint, job.tenantId, contract, job.extra);
  if (isTableCacheEnabled()) {
    const hit = await readDashboardTableCache(
      { endpoint: job.endpoint, tenantId: job.tenantId, contract, extra: job.extra, cacheKey },
      { allowStale: false },
    );
    if (hit.hit && hit.val != null) return true;
  }
  const snap = await snapshotWarmSkipReason({
    endpoint: job.endpoint,
    tenantId: job.tenantId,
    contract,
    extra: job.extra,
    cacheKey,
  });
  return snap === 'fresh' || snap === 'fresh-stale';
}

/**
 * @param {ReturnType<typeof buildPrecomputeJobs>[number]} job
 */
async function runPrecomputeJob(job) {
  const q = buildPrecomputeQuery(job);
  const contract = parseDashboardFilterQuery(q, job.tenantId);
  const cacheKey = buildDashboardCacheKey(job.endpoint, job.tenantId, contract, job.extra);
  const inflightKey = cacheKey;

  const existing = jobInflight.get(inflightKey);
  if (existing) return existing;

  const p = (async () => {
    const t0 = Date.now();
    try {
      if (await isPrecomputeJobFresh(job)) {
        return {
          status: 'skipped',
          reason: 'fresh',
          durationMs: Date.now() - t0,
          rows: 0,
          written: '',
        };
      }

      const val = await loadPrecomputePayload(job);
      const durationMs = Date.now() - t0;
      const rows = rowsPickForEndpoint(job.endpoint, val);
      const ttlMs = precomputeTtlMs(job.endpoint, contract);

      persistDashboardCaches({
        cacheKey,
        val,
        ttlMs,
        endpoint: job.endpoint,
        tenantId: job.tenantId,
        contract,
        extra: job.extra,
        refreshSource: 'precompute',
        rowsPick: (v) => rowsPickForEndpoint(job.endpoint, v),
      });

      return {
        status: 'done',
        durationMs,
        rows,
        written: 'table,snapshot,memory',
      };
    } catch (e) {
      return {
        status: 'failed',
        reason: String(e?.message || e).slice(0, 200),
        durationMs: Date.now() - t0,
      };
    }
  })();

  jobInflight.set(inflightKey, p);
  try {
    return await p;
  } finally {
    jobInflight.delete(inflightKey);
  }
}

function logPrecompute(parts) {
  console.log(`[dashboard-precompute] ${parts.join(' ')}`);
}

module.exports = {
  ENDPOINTS,
  ORDER_FILTERS,
  MARKETS,
  SHOP_ID,
  buildPrecomputeJobs,
  runPrecomputeJob,
  logPrecompute,
};
