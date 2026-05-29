'use strict';

/**
 * P1-C.3 统一 Dashboard 缓存入口
 * 读顺序（固定）：memory → dashboard_*_cache MySQL 表 → MySQL fact loader
 * snapshot 不参与主读取链路。
 */

const {
  readDashboardTableCache,
  readTrendTableStaleByDimensions,
  writeDashboardTableCache,
  isTableCacheEnabled,
  tableTtlMs,
} = require('../../../lib/dashboardTableCache');
const { isTrendCacheEndpoint, trendCacheTtlMs } = require('../../../lib/dashboardTrendTtl');

/** @type {Map<string, { exp: number, val: unknown, ttlMs: number }>} */
const memCache = new Map();

/**
 * @param {'CACHE_HIT_MEMORY'|'CACHE_HIT_TABLE'|'CACHE_MISS'|'CACHE_REFRESH'|'CACHE_STALE'} event
 * @param {Record<string, unknown>} meta
 */
function logCacheEvent(event, meta) {
  const parts = [`[dashboard-cache-unified] ${event}`];
  const push = (k, v) => {
    if (v != null && String(v) !== '') parts.push(`${k}=${v}`);
  };
  push('endpoint', meta.endpoint);
  push('market', meta.market);
  push('range', meta.range ?? meta.timeRange);
  push('orderFilter', meta.orderFilter);
  push('shopId', meta.shopId);
  push('cacheKey', meta.cacheKey);
  if (meta.source) push('source', meta.source);
  if (meta.durationMs != null) push('durationMs', meta.durationMs);
  console.log(parts.join(' '));
}

/**
 * @param {import('../filterContract').DashboardFilterContract} [contract]
 */
function metaFromContract(contract, cacheKey, endpoint) {
  return {
    endpoint: endpoint || '',
    market: contract?.market ?? '',
    range: contract?.timeRange ?? '',
    timeRange: contract?.timeRange ?? '',
    orderFilter: contract?.orderFilter ?? '',
    shopId: contract?.shopId ?? '',
    cacheKey: cacheKey || '',
  };
}

function memoryGet(key) {
  const e = memCache.get(key);
  if (!e) return { hit: false, val: undefined, ttlMs: 0 };
  if (Date.now() > e.exp) {
    memCache.delete(key);
    return { hit: false, val: undefined, ttlMs: e.ttlMs };
  }
  return { hit: true, val: e.val, ttlMs: e.ttlMs };
}

function memorySet(key, val, ttlMs) {
  memCache.set(key, { val, exp: Date.now() + ttlMs, ttlMs });
}

function memoryDelete(key) {
  memCache.delete(key);
}

function clearMemoryCache() {
  memCache.clear();
}

/**
 * @param {string} cacheKey
 * @param {unknown} value
 * @param {{
 *   endpoint: string,
 *   tenantId: number,
 *   contract: import('../filterContract').DashboardFilterContract,
 *   extra?: Record<string, string|number|boolean|undefined>,
 *   ttlMs: number,
 *   refreshSource?: string,
 * }} options
 */
async function setDashboardCache(cacheKey, value, options) {
  const { endpoint, tenantId, contract, extra, ttlMs, refreshSource = 'polling' } = options;
  memorySet(cacheKey, value, ttlMs);
  if (isTableCacheEnabled()) {
    await writeDashboardTableCache({
      endpoint,
      tenantId,
      contract,
      extra,
      cacheKey,
      val: value,
      refreshSource,
    });
  }
}

/**
 * @param {string} cacheKey
 * @param {{ contract?: import('../filterContract').DashboardFilterContract, endpoint?: string }} [options]
 */
function invalidateDashboardCache(cacheKey, options = {}) {
  memoryDelete(cacheKey);
  const meta = metaFromContract(options.contract, cacheKey, options.endpoint);
  logCacheEvent('CACHE_MISS', { ...meta, source: 'invalidate' });
}

/**
 * @param {string} cacheKey
 * @param {() => Promise<unknown>} loader
 * @param {{
 *   endpoint: string,
 *   tenantId: number,
 *   contract: import('../filterContract').DashboardFilterContract,
 *   extra?: Record<string, string|number|boolean|undefined>,
 *   ttlMs: number,
 *   refreshSource?: string,
 * }} options
 */
async function refreshDashboardCache(cacheKey, loader, options) {
  const meta = metaFromContract(options.contract, cacheKey, options.endpoint);
  logCacheEvent('CACHE_MISS', meta);
  const t0 = Date.now();
  const val = await loader();
  await setDashboardCache(cacheKey, val, options);
  logCacheEvent('CACHE_REFRESH', { ...meta, durationMs: Date.now() - t0 });
  return val;
}

/**
 * @param {{
 *   endpoint: string,
 *   tenantId: number,
 *   contract: import('../filterContract').DashboardFilterContract,
 *   extra?: Record<string, string|number|boolean|undefined>,
 *   cacheKey: string,
 * }} ctx
 * @param {{ allowStale?: boolean, maxStaleSec?: number }} [readOpts]
 */
async function readTableLayer(ctx, readOpts = {}) {
  if (!isTableCacheEnabled()) return { hit: false, val: undefined, ttlMs: 0, stale: false };
  const tableHit = await readDashboardTableCache(ctx, {
    allowStale: Boolean(readOpts.allowStale),
    maxStaleSec: readOpts.maxStaleSec,
  });
  if (tableHit.hit && tableHit.val != null) {
    return {
      hit: true,
      val: tableHit.val,
      ttlMs: tableHit.ttlMs != null && tableHit.ttlMs > 0 ? tableHit.ttlMs : 0,
      stale: Boolean(readOpts.allowStale),
    };
  }
  return { hit: false, val: undefined, ttlMs: 0, stale: false };
}

/**
 * @param {{
 *   endpoint: string,
 *   tenantId: number,
 *   contract: import('../filterContract').DashboardFilterContract,
 *   extra?: Record<string, string|number|boolean|undefined>,
 *   cacheKey: string,
 * }} ctx
 * @param {number} maxStaleSec
 */
async function readTrendDimStale(ctx, maxStaleSec) {
  if (!isTableCacheEnabled() || !isTrendCacheEndpoint(ctx.endpoint)) {
    return { hit: false, val: undefined, ttlMs: 0, stale: false };
  }
  const dimStale = await readTrendTableStaleByDimensions(ctx, { maxStaleSec });
  if (dimStale.hit && dimStale.val != null) {
    return {
      hit: true,
      val: dimStale.val,
      ttlMs: dimStale.ttlMs != null && dimStale.ttlMs > 0 ? dimStale.ttlMs : 0,
      stale: true,
    };
  }
  return { hit: false, val: undefined, ttlMs: 0, stale: false };
}

/**
 * 统一读：memory → table(fresh) → [table stale / dim stale] → loader
 * @param {string} cacheKey
 * @param {() => Promise<unknown>} loader
 * @param {{
 *   endpoint: string,
 *   tenantId: number,
 *   contract: import('../filterContract').DashboardFilterContract,
 *   extra?: Record<string, string|number|boolean|undefined>,
 *   ttlMs: number,
 *   refreshSource?: string,
 *   allowStale?: boolean,
 *   maxStaleSec?: number,
 *   skipLoader?: boolean,
 *   skipMemory?: boolean,
 * }} options
 * @returns {Promise<{ value: unknown, source: string, ttlMs: number, stale: boolean, cacheMiss: boolean }>}
 */
async function getDashboardCache(cacheKey, loader, options) {
  const {
    endpoint,
    tenantId,
    contract,
    extra,
    ttlMs,
    refreshSource = 'polling',
    allowStale = false,
    maxStaleSec,
    skipLoader = false,
    skipMemory = false,
  } = options;
  const meta = metaFromContract(contract, cacheKey, endpoint);
  const ctx = { endpoint, tenantId, contract, extra, cacheKey };

  if (!skipMemory) {
  const mem = memoryGet(cacheKey);
  if (mem.hit && mem.val != null) {
    logCacheEvent('CACHE_HIT_MEMORY', meta);
    return { value: mem.val, source: 'memory', ttlMs: mem.ttlMs, stale: false, cacheMiss: false };
  }
  }

  const tableFresh = await readTableLayer(ctx, { allowStale: false });
  if (tableFresh.hit) {
    const memTtl =
      tableFresh.ttlMs > 0
        ? tableFresh.ttlMs
        : isTrendCacheEndpoint(endpoint)
          ? tableTtlMs(endpoint, contract)
          : ttlMs;
    memorySet(cacheKey, tableFresh.val, memTtl);
    logCacheEvent('CACHE_HIT_TABLE', meta);
    return { value: tableFresh.val, source: 'table', ttlMs: memTtl, stale: false, cacheMiss: false };
  }

  if (allowStale) {
    const staleSec =
      maxStaleSec ??
      (isTrendCacheEndpoint(endpoint)
        ? Math.max(600, Math.ceil(trendCacheTtlMs(contract) / 1000) * 2)
        : 7200);
    const tableStale = await readTableLayer(ctx, { allowStale: true, maxStaleSec: staleSec });
    if (tableStale.hit) {
      const memTtl = tableStale.ttlMs > 0 ? tableStale.ttlMs : tableTtlMs(endpoint, contract);
      memorySet(cacheKey, tableStale.val, memTtl);
      logCacheEvent('CACHE_STALE', meta);
      return { value: tableStale.val, source: 'table-stale', ttlMs: memTtl, stale: true, cacheMiss: false };
    }
    const dimStale = await readTrendDimStale(ctx, staleSec);
    if (dimStale.hit) {
      const memTtl = dimStale.ttlMs > 0 ? dimStale.ttlMs : tableTtlMs(endpoint, contract);
      memorySet(cacheKey, dimStale.val, memTtl);
      logCacheEvent('CACHE_STALE', { ...meta, source: 'table-stale-dim' });
      return {
        value: dimStale.val,
        source: 'table-stale-dim',
        ttlMs: memTtl,
        stale: true,
        cacheMiss: false,
      };
    }
  }

  if (skipLoader) {
    logCacheEvent('CACHE_MISS', meta);
    return { value: null, source: 'cache-miss', ttlMs: 0, stale: false, cacheMiss: true };
  }

  logCacheEvent('CACHE_MISS', meta);
  const t0 = Date.now();
  const val = await loader();
  await setDashboardCache(cacheKey, val, { endpoint, tenantId, contract, extra, ttlMs, refreshSource });
  logCacheEvent('CACHE_REFRESH', { ...meta, durationMs: Date.now() - t0 });
  return { value: val, source: 'db', ttlMs, stale: false, cacheMiss: false };
}

module.exports = {
  getDashboardCache,
  setDashboardCache,
  invalidateDashboardCache,
  refreshDashboardCache,
  logCacheEvent,
  metaFromContract,
  memoryGet,
  memorySet,
  memoryDelete,
  clearMemoryCache,
  readTableLayer,
  readTrendDimStale,
  memCache,
};
