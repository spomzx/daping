'use strict';

/**
 * Dashboard 页面 API 只读缓存路径（memory → table → snapshot → stale → miss）
 * 禁止 loader / MySQL / await 后台 refresh
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
const {
  isSnapshotCacheEnabled,
  readDashboardSnapshotCache,
} = require('./dashboardSnapshotCache');
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
    warmDashboardSnapshot,
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

  const snapshotQuery = {
    endpoint,
    tenantId,
    contract,
    extra,
    cacheKey,
  };

  if (isTrendCacheEndpoint(endpoint)) {
    const memHit = cacheGet(cacheKey);
    if (memHit.hit && memHit.val != null && !trendPayloadIsEmpty(endpoint, memHit.val, rowsPick, pointsPick)) {
      warmDashboardSnapshot({ endpoint, tenantId, contract, extra, cacheKey, val: memHit.val, rowsPick });
      return emitHit('memory', memHit.val, memHit.ttlMs, { cacheLabel: 'hit-memory', durationMs: 0 });
    }

    if (isTableCacheEnabled()) {
      const t0 = Date.now();
      const tableFresh = await readDashboardTableCache(
        { endpoint, tenantId, contract, extra, cacheKey },
        { allowStale: false },
      );
      if (tableFresh.hit && tableFresh.val != null && !trendPayloadIsEmpty(endpoint, tableFresh.val, rowsPick, pointsPick)) {
        const memTtl = tableFresh.ttlMs != null && tableFresh.ttlMs > 0 ? tableFresh.ttlMs : tableTtlMs(endpoint, contract);
        cacheSet(cacheKey, tableFresh.val, memTtl);
        warmDashboardSnapshot({ endpoint, tenantId, contract, extra, cacheKey, val: tableFresh.val, rowsPick });
        return emitHit('table', tableFresh.val, memTtl, {
          cacheLabel: 'hit-table',
          durationMs: Date.now() - t0,
        });
      }
    }

    if (isSnapshotCacheEnabled()) {
      const t0 = Date.now();
      const snapFresh = await readDashboardSnapshotCache(snapshotQuery, { allowStale: false });
      if (
        snapFresh.hit &&
        snapFresh.val != null &&
        !trendPayloadIsEmpty(endpoint, snapFresh.val, rowsPick, pointsPick)
      ) {
        const memTtl = snapFresh.ttlMs != null && snapFresh.ttlMs > 0 ? snapFresh.ttlMs : ttlMs;
        cacheSet(cacheKey, snapFresh.val, memTtl);
        return emitHit('snapshot', snapFresh.val, memTtl, {
          cacheLabel: 'hit-snapshot',
          durationMs: Date.now() - t0,
        });
      }
      const snapStale = await readDashboardSnapshotCache(snapshotQuery, { allowStale: true });
      if (snapStale.hit && snapStale.val != null) {
        const memTtl = snapStale.ttlMs != null && snapStale.ttlMs > 0 ? snapStale.ttlMs : ttlMs;
        cacheSet(cacheKey, snapStale.val, memTtl);
        hintDashboardPrecompute({ cacheKey, endpoint, tenantId, contract });
        return emitHit('snapshot-stale', snapStale.val, memTtl, {
          cacheLabel: 'hit-snapshot-stale',
          stale: true,
          refreshPending: true,
          refreshHint: true,
          durationMs: Date.now() - t0,
        });
      }
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
    warmDashboardSnapshot({ endpoint, tenantId, contract, extra, cacheKey, val: memHit.val, rowsPick });
    return emitHit('memory', memHit.val, memHit.ttlMs, { cacheLabel: 'hit-memory', durationMs: 0 });
  }

  if (isTableCacheEnabled()) {
    const t0 = Date.now();
    const tableHit = await readDashboardTableCache(
      { endpoint, tenantId, contract, extra, cacheKey },
      { allowStale: false },
    );
    if (tableHit.hit && tableHit.val != null) {
      const memTtl = tableHit.ttlMs != null && tableHit.ttlMs > 0 ? tableHit.ttlMs : ttlMs;
      cacheSet(cacheKey, tableHit.val, memTtl);
      warmDashboardSnapshot({ endpoint, tenantId, contract, extra, cacheKey, val: tableHit.val, rowsPick });
      return emitHit('table', /** @type {T} */ (tableHit.val), memTtl, {
        cacheLabel: 'hit-table',
        durationMs: Date.now() - t0,
      });
    }
    const tableStale = await readDashboardTableCache(
      { endpoint, tenantId, contract, extra, cacheKey },
      { allowStale: true, maxStaleSec: 7200 },
    );
    if (tableStale.hit && tableStale.val != null) {
      const memTtl = tableStale.ttlMs != null && tableStale.ttlMs > 0 ? tableStale.ttlMs : ttlMs;
      cacheSet(cacheKey, tableStale.val, memTtl);
      hintDashboardPrecompute({ cacheKey, endpoint, tenantId, contract });
      return emitHit('table-stale', /** @type {T} */ (tableStale.val), memTtl, {
        stale: true,
        refreshPending: true,
        refreshHint: true,
        durationMs: Date.now() - t0,
      });
    }
  }

  if (isSnapshotCacheEnabled()) {
    const t0 = Date.now();
    const fresh = await readDashboardSnapshotCache(snapshotQuery, { allowStale: false });
    if (fresh.hit && fresh.val != null) {
      const memTtl = fresh.ttlMs != null && fresh.ttlMs > 0 ? fresh.ttlMs : ttlMs;
      cacheSet(cacheKey, fresh.val, memTtl);
      return emitHit('snapshot', fresh.val, memTtl, { durationMs: Date.now() - t0 });
    }
    const stale = await readDashboardSnapshotCache(snapshotQuery, { allowStale: true });
    if (stale.hit && stale.val != null) {
      const memTtl = stale.ttlMs != null && stale.ttlMs > 0 ? stale.ttlMs : ttlMs;
      cacheSet(cacheKey, stale.val, memTtl);
      hintDashboardPrecompute({ cacheKey, endpoint, tenantId, contract });
      return emitHit('snapshot-stale', stale.val, memTtl, {
        stale: true,
        refreshPending: true,
        refreshHint: true,
        durationMs: Date.now() - t0,
      });
    }
  }

  return emitMiss();
}

module.exports = { serveDashboardReadonly };
