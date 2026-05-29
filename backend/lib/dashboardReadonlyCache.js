'use strict';

/**
 * Dashboard 页面 API 只读缓存路径（memory → table → stale → miss）
 * 禁止 loader / MySQL / await 后台 refresh；snapshot 不参与主链路（P1-C.3）
 */

const { recordDashboardRequest } = require('./dashboardSlowCollector');
const { logDashboardPerfProbe } = require('./dashboardPerfProbe');
const {
  readDashboardTableCache,
  readTrendTableStaleByDimensions,
  isTableCacheEnabled,
  tableTtlMs,
} = require('./dashboardTableCache');
const { isTrendCacheEndpoint } = require('./dashboardTrendTtl');
const {
  stampTrendCacheMeta,
  buildReadonlyCacheMissShape,
  trendPayloadIsEmpty,
} = require('./dashboardTrendCacheMeta');
const dashboardCacheService = require('../modules/dashboard/cache/dashboardCacheService');
const { precomputeTtlMs } = require('./dashboardPrecomputeTtl');
const { hintDashboardPrecompute, logDashboardReadonly } = require('./dashboardReadonly');

/**
 * @template T
 * @param {import('./dashboardCache').DashboardCacheServeOpts<T>} opts
 */
async function serveDashboardReadonly(opts) {
  const {
    endpoint,
    tenantId,
    contract,
    q,
    extra,
    sqlTag,
    rowsPick,
    pointsPick,
    usedStatusField,
    cacheKey,
    refreshSource,
    probeBase,
    cacheGet,
    cacheSet,
    logDashboardCacheLine,
  } = opts;

  const ttlMs = precomputeTtlMs(endpoint, contract);

  const emitHit = (source, val, hitTtlMs, hitOpts = {}) => {
    const rows = rowsPick && val != null ? rowsPick(/** @type {T} */ (val)) : undefined;
    const points = pointsPick && val != null ? pointsPick(/** @type {T} */ (val)) : undefined;
    const stale = Boolean(hitOpts.stale);
    const refreshPending = Boolean(hitOpts.refreshPending);
    logDashboardReadonly(endpoint, stale || hitOpts.refreshHint ? 'stale-hit' : 'cache-hit', {
      source,
      durationMs: hitOpts.durationMs ?? 0,
      refreshHint: hitOpts.refreshHint ? '1' : '0',
      rows,
      points,
    });
    logDashboardCacheLine(contract, {
      endpoint,
      sqlTag,
      durationMs: hitOpts.durationMs ?? 0,
      cacheHit: true,
      cache: hitOpts.cacheLabel || 'hit-readonly',
      cacheSource: source,
      refreshSource,
      ttlMs: hitTtlMs,
      rows,
      points,
      cacheKey,
      refreshPending,
    });
    recordDashboardRequest({
      endpoint,
      sqlTag,
      durationMs: hitOpts.durationMs ?? 0,
      cacheHit: true,
      tenant: tenantId,
      market: contract.market,
      orderFilter: contract.orderFilter,
      timeRange: contract.timeRange,
      shopId: contract.shopId,
      rows,
    });
    emitPerfProbe(probeBase, {
      cache: hitOpts.cacheLabel || 'hit-readonly',
      cacheSource: source,
      refreshSource,
      durationMs: hitOpts.durationMs ?? 0,
      sqlMs: 0,
      rows,
      points,
      refreshPending,
    });
    if (isTrendCacheEndpoint(endpoint)) {
      return /** @type {T} */ (
        stampTrendCacheMeta(endpoint, val, {
          cacheSource: source,
          stale,
          refreshPending,
          cacheMiss: false,
          ...(hitOpts.reason ? { reason: hitOpts.reason } : {}),
        })
      );
    }
    if (val && typeof val === 'object') {
      return /** @type {T} */ ({
        .../** @type {object} */ (val),
        cacheMiss: false,
        refreshPending,
        stale,
        cacheSource: source,
      });
    }
    return /** @type {T} */ (val);
  };

  const emitMiss = (lastSource = 'miss') => {
    hintDashboardPrecompute({ cacheKey, endpoint, tenantId, contract });
    logDashboardReadonly(endpoint, 'cache-miss', {
      refreshHint: '1',
      'no-request-loader': '1',
    });
    const empty = buildReadonlyCacheMissShape(endpoint, contract, extra);
    const rows = rowsPick ? rowsPick(empty) : undefined;
    const points = pointsPick ? pointsPick(empty) : undefined;
    logDashboardCacheLine(contract, {
      endpoint,
      sqlTag,
      durationMs: 0,
      cacheHit: false,
      cache: 'miss-readonly',
      cacheSource: 'cache-miss',
      refreshSource,
      ttlMs,
      rows,
      points,
      cacheKey,
      refreshPending: true,
    });
    recordDashboardRequest({
      endpoint,
      sqlTag,
      durationMs: 0,
      cacheHit: false,
      tenant: tenantId,
      market: contract.market,
      orderFilter: contract.orderFilter,
      timeRange: contract.timeRange,
      shopId: contract.shopId,
      rows,
    });
    emitPerfProbe(probeBase, {
      cache: 'miss-readonly',
      cacheSource: 'cache-miss',
      refreshSource,
      durationMs: 0,
      sqlMs: 0,
      rows,
      points,
      refreshPending: true,
    });
    if (isTrendCacheEndpoint(endpoint)) {
      return /** @type {T} */ (
        stampTrendCacheMeta(endpoint, empty, {
          cacheSource: 'cache-miss',
          stale: false,
          refreshPending: true,
          cacheMiss: true,
          reason: 'awaiting_precompute',
        })
      );
    }
    return /** @type {T} */ ({
      ...empty,
      ok: true,
      cacheMiss: true,
      refreshPending: true,
      cacheSource: 'cache-miss',
    });
  };

  const tableCtx = { endpoint, tenantId, contract, extra, cacheKey };

  if (isTrendCacheEndpoint(endpoint)) {
    const memHit = cacheGet(cacheKey);
    if (memHit.hit && memHit.val != null && !trendPayloadIsEmpty(endpoint, memHit.val, rowsPick, pointsPick)) {
      dashboardCacheService.logCacheEvent(
        'CACHE_HIT_MEMORY',
        dashboardCacheService.metaFromContract(contract, cacheKey, endpoint),
      );
      return emitHit('memory', memHit.val, memHit.ttlMs, { cacheLabel: 'hit-memory', durationMs: 0 });
    }

    const t0Table = Date.now();
    const tableFresh = await dashboardCacheService.readTableLayer(tableCtx, { allowStale: false });
    if (
      tableFresh.hit &&
      tableFresh.val != null &&
      !trendPayloadIsEmpty(endpoint, tableFresh.val, rowsPick, pointsPick)
    ) {
      const memTtl = tableFresh.ttlMs > 0 ? tableFresh.ttlMs : tableTtlMs(endpoint, contract);
      cacheSet(cacheKey, tableFresh.val, memTtl);
      dashboardCacheService.logCacheEvent(
        'CACHE_HIT_TABLE',
        dashboardCacheService.metaFromContract(contract, cacheKey, endpoint),
      );
      return emitHit('table', tableFresh.val, memTtl, {
        cacheLabel: 'hit-table',
        durationMs: Date.now() - t0Table,
      });
    }

    if (isTableCacheEnabled()) {
      const t0 = Date.now();
      const tableStale = await readDashboardTableCache(
        { endpoint, tenantId, contract, extra, cacheKey },
        { allowStale: true, maxStaleSec: 7200 },
      );
      if (tableStale.hit && tableStale.val != null) {
        const memTtl = tableStale.ttlMs != null && tableStale.ttlMs > 0 ? tableStale.ttlMs : tableTtlMs(endpoint, contract);
        cacheSet(cacheKey, tableStale.val, memTtl);
        dashboardCacheService.logCacheEvent(
          'CACHE_STALE',
          dashboardCacheService.metaFromContract(contract, cacheKey, endpoint),
        );
        hintDashboardPrecompute({ cacheKey, endpoint, tenantId, contract });
        return emitHit('table-stale', tableStale.val, memTtl, {
          cacheLabel: 'hit-table-stale',
          stale: true,
          refreshPending: true,
          refreshHint: true,
          durationMs: Date.now() - t0,
        });
      }
      const dimStale = await readTrendTableStaleByDimensions(
        { endpoint, tenantId, contract, extra, cacheKey },
        { maxStaleSec: 7200 },
      );
      if (dimStale.hit && dimStale.val != null) {
        const memTtl = dimStale.ttlMs != null && dimStale.ttlMs > 0 ? dimStale.ttlMs : tableTtlMs(endpoint, contract);
        cacheSet(cacheKey, dimStale.val, memTtl);
        dashboardCacheService.logCacheEvent(
          'CACHE_STALE',
          dashboardCacheService.metaFromContract(contract, cacheKey, endpoint),
        );
        hintDashboardPrecompute({ cacheKey, endpoint, tenantId, contract });
        return emitHit('table-stale', dimStale.val, memTtl, {
          cacheLabel: 'hit-table-stale-dim',
          stale: true,
          refreshPending: true,
          refreshHint: true,
          durationMs: Date.now() - t0,
        });
      }
    }

    return emitMiss();
  }

  const memHit = cacheGet(cacheKey);
  if (memHit.hit && memHit.val != null) {
    dashboardCacheService.logCacheEvent(
      'CACHE_HIT_MEMORY',
      dashboardCacheService.metaFromContract(contract, cacheKey, endpoint),
    );
    return emitHit('memory', memHit.val, memHit.ttlMs, { cacheLabel: 'hit-memory', durationMs: 0 });
  }

  const cacheResult = await dashboardCacheService.getDashboardCache(cacheKey, async () => null, {
    endpoint,
    tenantId,
    contract,
    extra,
    ttlMs,
    skipMemory: true,
    skipLoader: true,
    allowStale: true,
    maxStaleSec: 7200,
  });
  if (cacheResult.source === 'table') {
    return emitHit('table', /** @type {T} */ (cacheResult.value), cacheResult.ttlMs, {
      cacheLabel: 'hit-table',
      durationMs: 0,
    });
  }
  if (cacheResult.stale && cacheResult.value != null) {
    hintDashboardPrecompute({ cacheKey, endpoint, tenantId, contract });
    return emitHit('table-stale', /** @type {T} */ (cacheResult.value), cacheResult.ttlMs, {
      stale: true,
      refreshPending: true,
      refreshHint: true,
      durationMs: 0,
    });
  }

  return emitMiss();
}

module.exports = { serveDashboardReadonly };
