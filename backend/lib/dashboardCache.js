'use strict';

const { recordDashboardRequest } = require('./dashboardSlowCollector');
const { logDashboardPerfProbe } = require('./dashboardPerfProbe');
const {
  readDashboardTableCache,
  readTrendTableStaleByDimensions,
  writeDashboardTableCache,
  isTableCacheEnabled,
  tableTtlMs,
} = require('./dashboardTableCache');
const { isTrendCacheEndpoint, trendCacheTtlMs } = require('./dashboardTrendTtl');
const {
  stampTrendCacheMeta,
  buildTrendPendingPlaceholder,
  trendPayloadIsEmpty,
} = require('./dashboardTrendCacheMeta');
const {
  isSnapshotCacheEnabled,
  readDashboardSnapshotCache,
  writeDashboardSnapshotCache,
  snapshotTtlMs,
  snapshotNearExpiryRemainingMs,
  shouldPersistSnapshot,
  isSnapshotEndpoint,
} = require('./dashboardSnapshotCache');
const {
  isDashboardApiReadonly,
  isPrecomputePipelineRequest,
  hintDashboardPrecompute,
} = require('./dashboardReadonly');
const {
  contractForTrendKpiCache,
  buildTrendDashboardCacheKey,
  purgeMemCacheLegacyPaidTrend,
} = require('./dashboardTrendCache');

/** @type {Map<string, { exp: number, val: unknown, ttlMs: number }>} */
const memCache = new Map();

/** 趋势端点后台回填（cache miss 时不阻塞 HTTP） */
/** @type {Map<string, Promise<unknown>>} */
const trendRefreshInflight = new Map();

/** pending 占位最长 5s（refresh 完成后清除） */
/** @type {Map<string, number>} */
const trendPendingUntil = new Map();

const TREND_PENDING_MAX_MS = Math.min(
  10_000,
  Math.max(3000, Number(process.env.DASHBOARD_TREND_PENDING_MAX_MS) || 5000),
);

function clearPendingDashboardCache(cacheKey) {
  if (cacheKey) trendPendingUntil.delete(String(cacheKey));
}

function markTrendPending(cacheKey) {
  trendPendingUntil.set(String(cacheKey), Date.now() + TREND_PENDING_MAX_MS);
}

function isTrendPendingExpired(cacheKey) {
  const exp = trendPendingUntil.get(String(cacheKey));
  if (exp == null) return true;
  if (Date.now() > exp) {
    trendPendingUntil.delete(String(cacheKey));
    return true;
  }
  return false;
}

/**
 * 不阻塞 HTTP：仅探测内存是否已有后台 refresh 写入结果
 * @param {string} cacheKey
 */
function peekTrendRefreshMem(cacheKey) {
  const mem = cacheGet(cacheKey);
  if (mem.hit && mem.val != null) return mem;
  return { hit: false, val: undefined, ttlMs: 0 };
}

/**
 * @param {number} remainingMs
 * @param {import('../modules/dashboard/filterContract').DashboardFilterContract} contract
 */
function isNearExpiryRemaining(remainingMs, contract) {
  const rem = Number(remainingMs);
  if (!Number.isFinite(rem) || rem <= 0) return true;
  return rem <= snapshotNearExpiryRemainingMs(contract);
}

const TTL_BOUNDS = {
  summary: { min: 20000, max: 30000, env: 'DASHBOARD_CACHE_TTL_SUMMARY_MS', fallback: 25000 },
  ranking: { min: 30000, max: 45000, env: 'DASHBOARD_CACHE_TTL_RANKING_MS', fallback: 30000 },
  'product-ranking': { min: 45000, max: 60000, env: 'DASHBOARD_CACHE_TTL_PRODUCT_RANKING_MS', fallback: 60000 },
  'gmv-compare': { min: 60000, max: 120000, env: 'DASHBOARD_GMV_COMPARE_TTL_MS', fallback: 90000 },
  'order-volume': { min: 60000, max: 120000, env: 'DASHBOARD_TREND_CACHE_TTL_MS', fallback: 90000 },
  trend: { min: 60000, max: 120000, env: 'DASHBOARD_TREND_CACHE_TTL_MS', fallback: 90000 },
};

/** timeRange=today 时各端点 TTL 上限（与前端轮询错峰对齐，禁止 5s 短 TTL 引发 miss 风暴） */
const TODAY_ENDPOINT_TTL_MS = {
  summary: 25000,
  ranking: 30000,
  'product-ranking': 60000,
  'gmv-compare': 90000,
  'order-volume': 90000,
  trend: 90000,
};

function isTodayLiveContract(contract) {
  return String(contract?.timeRange || 'today').trim().toLowerCase() === 'today';
}

/**
 * @param {string} endpoint
 * @param {import('../modules/dashboard/filterContract').DashboardFilterContract} [contract]
 */
function clampTtlMs(endpoint, contract) {
  if (isTrendCacheEndpoint(endpoint)) {
    return trendCacheTtlMs(contract);
  }
  const b = TTL_BOUNDS[endpoint] || { min: 15000, max: 120000, env: '', fallback: 30000 };
  const raw = b.env ? Number(process.env[b.env]) : NaN;
  let n = Number.isFinite(raw) && raw > 0 ? raw : b.fallback;
  n = Math.min(b.max, Math.max(b.min, Math.floor(n)));
  if (contract && isTodayLiveContract(contract)) {
    const todayCap = TODAY_ENDPOINT_TTL_MS[endpoint];
    if (todayCap != null) n = Math.min(n, todayCap);
  }
  return n;
}

/**
 * @param {{
 *   cacheKey: string,
 *   endpoint: string,
 *   tenantId: number,
 *   contract: import('../modules/dashboard/filterContract').DashboardFilterContract,
 *   extra?: Record<string, string|number|boolean|undefined>,
 *   ttlMs: number,
 *   refreshSource: string,
 *   loader: () => Promise<unknown>,
 *   rowsPick?: (val: unknown) => number|undefined,
 *   pointsPick?: (val: unknown) => number|undefined,
 * }} opts
 */
/**
 * @param {{
 *   cacheKey: string,
 *   endpoint: string,
 *   tenantId: number,
 *   contract: import('../modules/dashboard/filterContract').DashboardFilterContract,
 *   extra?: Record<string, string|number|boolean|undefined>,
 *   ttlMs: number,
 *   refreshSource: string,
 *   loader: () => Promise<unknown>,
 *   rowsPick?: (val: unknown) => number|undefined,
 *   pointsPick?: (val: unknown) => number|undefined,
 * }} opts
 */
function persistDashboardCaches(opts) {
  const { cacheKey, val, ttlMs, endpoint, tenantId, contract, extra, refreshSource, rowsPick } = opts;
  cacheSet(cacheKey, val, ttlMs);
  void writeDashboardTableCache({
    endpoint,
    tenantId,
    contract,
    extra,
    cacheKey,
    val,
    refreshSource,
  });
  syncDashboardSnapshotWrite({
    endpoint,
    tenantId,
    contract,
    extra,
    cacheKey,
    val,
    rowsPick,
  });
}

/**
 * memory/table/db 任意命中后同步回写 snapshot（有数据才写）
 */
function syncDashboardSnapshotWrite(opts) {
  const { endpoint, tenantId, contract, extra, cacheKey, val, rowsPick } = opts;
  if (!isSnapshotCacheEnabled() || !isSnapshotEndpoint(endpoint)) return;
  if (val == null) return;
  if (!shouldPersistSnapshot(endpoint, val, rowsPick)) return;
  void writeDashboardSnapshotCache(
    { endpoint, tenantId, contract, extra, cacheKey },
    val,
    snapshotTtlMs(contract),
  );
}

/** @alias syncDashboardSnapshotWrite */
function warmDashboardSnapshot(opts) {
  syncDashboardSnapshotWrite(opts);
}

function scheduleDashboardBackgroundRefresh(opts) {
  if (isDashboardApiReadonly()) {
    hintDashboardPrecompute(opts);
    return Promise.resolve();
  }
  const { cacheKey, endpoint, tenantId, contract, extra, ttlMs, refreshSource, loader, rowsPick, pointsPick } =
    opts;
  const existing = trendRefreshInflight.get(cacheKey);
  if (existing) return existing;

  const p = Promise.resolve()
    .then(() => loader())
    .then((val) => {
      persistDashboardCaches({
        cacheKey,
        val,
        ttlMs,
        endpoint,
        tenantId,
        contract,
        extra,
        refreshSource,
        rowsPick,
      });
      const empty = trendPayloadIsEmpty(endpoint, val, rowsPick, pointsPick);
      const cacheSource = empty ? 'db-empty' : 'db';
      const reason = empty ? 'no_trend_data' : '';
      clearPendingDashboardCache(cacheKey);
      console.log(
        `[dashboard-contract] endpoint=${endpoint} cache=refresh-done cacheSource=${cacheSource}${reason ? ` reason=${reason}` : ''} timeRange=${contract?.timeRange} orderFilter=${contract?.orderFilter} market=${contract?.market}`,
      );
      return val;
    })
    .catch((e) => {
      console.warn('[dashboard-cache] background refresh fail', endpoint, e?.message || e);
    })
    .finally(() => {
      trendRefreshInflight.delete(cacheKey);
      clearPendingDashboardCache(cacheKey);
    });

  trendRefreshInflight.set(cacheKey, p);
  return p;
}

/** @deprecated 别名 */
const scheduleTrendBackgroundRefresh = scheduleDashboardBackgroundRefresh;

/**
 * @param {{
 *   endpoint: string,
 *   tenantId: number,
 *   contract: import('../modules/dashboard/filterContract').DashboardFilterContract,
 *   extra?: Record<string, string|number|boolean|undefined>,
 *   cacheKey: string,
 * }} ctx
 */
async function readSnapshotLayers(ctx) {
  if (!isSnapshotCacheEnabled()) {
    return { fresh: { hit: false, logSource: 'snapshot-miss' }, stale: { hit: false, logSource: 'snapshot-miss' } };
  }
  const q = {
    endpoint: ctx.endpoint,
    tenantId: ctx.tenantId,
    contract: ctx.contract,
    extra: ctx.extra,
    cacheKey: ctx.cacheKey,
  };
  const fresh = await readDashboardSnapshotCache(q, { allowStale: false });
  if (fresh.hit) return { fresh, stale: { hit: false, logSource: 'snapshot-miss' } };
  const stale = await readDashboardSnapshotCache(q, { allowStale: true });
  return { fresh, stale };
}

/**
 * dashboard:{endpoint}:{tenant}:{shop}:{market}:{orderFilter}:{timeRange}:{start}:{end}[:extra]
 * @param {string} endpoint
 * @param {number|null|undefined} tenantId
 * @param {import('../modules/dashboard/filterContract').DashboardFilterContract} contract
 * @param {Record<string, string|number|boolean|undefined>} [extra]
 */
function buildDashboardCacheKey(endpoint, tenantId, contract, extra = {}) {
  const tenant = tenantId != null && Number.isFinite(Number(tenantId)) ? String(Math.floor(Number(tenantId))) : 'none';
  const shop = String(contract?.shopId ?? 'all');
  const market = String(contract?.market ?? 'ALL');
  const orderFilter = String(contract?.orderFilter ?? 'all');
  const timeRange = String(contract?.timeRange ?? 'today');
  const start = String(contract?.startDate ?? '');
  const end = String(contract?.endDate ?? '');
  const extraParts = Object.keys(extra)
    .sort()
    .map((k) => `${k}=${String(extra[k] ?? '')}`)
    .join('|');
  const base = `dashboard:${endpoint}:${tenant}:${shop}:${market}:${orderFilter}:${timeRange}:${start}:${end}`;
  return extraParts ? `${base}:${extraParts}` : base;
}

/**
 * @param {Record<string, unknown>} [q]
 */
function isDashboardCacheBypass(q) {
  if (!q || typeof q !== 'object') return false;
  if (isPrecomputePipelineRequest(q)) return true;
  if (isDashboardApiReadonly()) return false;
  const raw = q.cacheBypass ?? q.cache_bypass ?? q.bypassCache;
  if (raw === '1' || raw === true || raw === 'true') return true;
  const force = q.forceRefresh ?? q.force_refresh;
  if (force === '1' || force === true || force === 'true') return true;
  const dbg = q.debug;
  return dbg === '1' || dbg === 'true';
}

/**
 * @param {Record<string, unknown>} [q]
 * @returns {'polling'|'manual'|'ordersChanged'|'scheduler'|'unknown'}
 */
function resolveRefreshSource(q) {
  if (!q || typeof q !== 'object') return 'polling';
  const explicit = q.refreshSource ?? q.refresh_source;
  if (explicit != null && String(explicit).trim()) return String(explicit).trim();
  if (q.scheduler === '1' || q.scheduler === true) return 'scheduler';
  if (q.ordersChanged === '1' || q.orders_changed === '1') return 'ordersChanged';
  const force = q.forceRefresh ?? q.force_refresh;
  if (force === '1' || force === true || force === 'true') return 'manual';
  return 'polling';
}

function cacheGet(key) {
  const e = memCache.get(key);
  if (!e) return { hit: false, val: undefined, ttlMs: 0 };
  if (Date.now() > e.exp) {
    memCache.delete(key);
    return { hit: false, val: undefined, ttlMs: e.ttlMs };
  }
  return { hit: true, val: e.val, ttlMs: e.ttlMs };
}

function cacheSet(key, val, ttlMs) {
  memCache.set(key, { val, exp: Date.now() + ttlMs, ttlMs });
}

/**
 * @param {import('../modules/dashboard/filterContract').DashboardFilterContract} contract
 * @param {Record<string, unknown>} meta
 */
function logDashboardCacheLine(contract, meta) {
  const parts = ['[dashboard-contract]'];
  const push = (k, v) => {
    if (v != null && String(v) !== '') parts.push(`${k}=${v}`);
  };
  push('endpoint', meta.endpoint || '');
  push('sqlTag', meta.sqlTag || 'cache');
  push('durationMs', Math.max(0, Math.floor(Number(meta.durationMs) || 0)));
  push(
    'cache',
    meta.cacheHit === true ? 'hit' : meta.cacheHit === false ? 'miss' : meta.cache ?? '',
  );
  push('cacheSource', meta.cacheSource ?? '');
  push('refreshSource', meta.refreshSource ?? '');
  push('ttlMs', meta.ttlMs);
  push('tenant', contract?.tenantId);
  push('market', contract?.market ?? '');
  push('orderFilter', contract?.orderFilter ?? '');
  push('timeRange', contract?.timeRange ?? '');
  push('shopId', contract?.shopId ?? '');
  push('rows', meta.rows);
  push('points', meta.points);
  push('refreshPending', meta.refreshPending === true ? 'true' : meta.refreshPending === false ? 'false' : '');
  console.log(parts.join(' '));
}

/**
 * @param {Record<string, unknown>} probeBase
 * @param {Record<string, unknown>} meta
 */
function emitPerfProbe(probeBase, meta) {
  logDashboardPerfProbe({
    ...probeBase,
    cache: meta.cache,
    cacheSource: meta.cacheSource,
    refreshSource: meta.refreshSource,
    durationMs: meta.durationMs,
    sqlMs: meta.sqlMs,
    rows: meta.rows,
    points: meta.points,
    usedStatusField: meta.usedStatusField,
  });
}

/**
 * @template T
 * @param {{
 *   endpoint: string,
 *   tenantId: number,
 *   contract: import('../modules/dashboard/filterContract').DashboardFilterContract,
 *   q?: Record<string, unknown>,
 *   extra?: Record<string, string|number|boolean|undefined>,
 *   sqlTag: string,
 *   rowsPick?: (val: T) => number,
 *   pointsPick?: (val: T) => number,
 *   usedStatusField?: string,
 *   loader: () => Promise<T>,
 * }} opts
 * @returns {Promise<T>}
 */
async function withDashboardCache(opts) {
  const { endpoint, tenantId, contract: uiContract, q, extra, sqlTag, loader, rowsPick, pointsPick, usedStatusField } =
    opts;
  /** 缓存键 orderFilter 与 SQL 一致（normalizeOrderFilter；paid→valid） */
  const contract = contractForTrendKpiCache(uiContract);
  const bypass = isDashboardCacheBypass(q);
  const ttlMs = clampTtlMs(endpoint, contract);
  const cacheKey = isTrendCacheEndpoint(endpoint)
    ? buildTrendDashboardCacheKey(endpoint, tenantId, uiContract, extra)
    : buildDashboardCacheKey(endpoint, tenantId, contract, extra);
  const refreshSource = resolveRefreshSource(q);

  const probeBase = {
    endpoint,
    filterHash: cacheKey,
    tenantId,
    shopId: contract.shopId,
    market: contract.market,
    orderFilter: contract.orderFilter,
    timeRange: contract.timeRange,
    sqlTag,
    usedStatusField,
  };

  if (isDashboardApiReadonly() && !bypass) {
    const { serveDashboardReadonly } = require('./dashboardReadonlyCache');
    return serveDashboardReadonly({
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
    });
  }

  if (bypass) {
    const t0 = Date.now();
    const val = await loader();
    const durationMs = Date.now() - t0;
    const rows = rowsPick ? rowsPick(val) : undefined;
    const points = pointsPick ? pointsPick(val) : undefined;
    persistDashboardCaches({
      cacheKey,
      val,
      ttlMs,
      endpoint,
      tenantId,
      contract,
      extra,
      refreshSource,
      rowsPick,
    });
    logDashboardCacheLine(contract, {
      endpoint,
      sqlTag,
      durationMs,
      cacheHit: false,
      cache: 'bypass',
      cacheSource: 'db',
      refreshSource,
      ttlMs,
      rows,
      points,
      cacheKey,
    });
    recordDashboardRequest({
      endpoint,
      sqlTag,
      durationMs,
      cacheHit: false,
      tenant: tenantId,
      market: contract.market,
      orderFilter: contract.orderFilter,
      timeRange: contract.timeRange,
      shopId: contract.shopId,
      rows,
    });
    emitPerfProbe(probeBase, {
      cache: 'bypass',
      cacheSource: 'db',
      refreshSource,
      durationMs,
      sqlMs: durationMs,
      rows,
      points,
    });
    if (isTrendCacheEndpoint(endpoint)) {
      const empty = trendPayloadIsEmpty(endpoint, val, rowsPick, pointsPick);
      return /** @type {T} */ (
        stampTrendCacheMeta(endpoint, val, {
          cacheSource: empty ? 'db-empty' : 'db',
          stale: false,
          refreshPending: false,
          ...(empty ? { reason: 'no_trend_data' } : {}),
        })
      );
    }
    return val;
  }

  const emitHit = (
    cacheSource,
    val,
    hitTtlMs,
    cacheLabel = 'hit',
    /** @type {{ refreshPending?: boolean }} */ hitOpts = {},
  ) => {
    const rows = rowsPick && val != null ? rowsPick(/** @type {T} */ (val)) : undefined;
    const points = pointsPick && val != null ? pointsPick(/** @type {T} */ (val)) : undefined;
    logDashboardCacheLine(contract, {
      endpoint,
      sqlTag,
      durationMs: 0,
      cacheHit: true,
      cache: cacheLabel,
      cacheSource,
      refreshSource,
      ttlMs: hitTtlMs,
      rows,
      points,
      cacheKey,
      refreshPending: hitOpts.refreshPending,
    });
    recordDashboardRequest({
      endpoint,
      sqlTag,
      durationMs: 0,
      cacheHit: true,
      tenant: tenantId,
      market: contract.market,
      orderFilter: contract.orderFilter,
      timeRange: contract.timeRange,
      shopId: contract.shopId,
      rows,
    });
    emitPerfProbe(probeBase, {
      cache: cacheLabel,
      cacheSource,
      refreshSource,
      durationMs: 0,
      sqlMs: 0,
      rows,
      points,
      refreshPending: hitOpts.refreshPending,
    });
    return /** @type {T} */ (val);
  };

  const snapshotCtx = { endpoint, tenantId, contract, extra, cacheKey };

  /**
   * @param {'fresh'|'stale'|'both'} [mode]
   */
  const snapshotQuery = {
    endpoint: snapshotCtx.endpoint,
    tenantId: snapshotCtx.tenantId,
    contract: snapshotCtx.contract,
    extra: snapshotCtx.extra,
    cacheKey: snapshotCtx.cacheKey,
  };

  const returnSnapshotTrendHit = (snap, /** @type {boolean} */ scheduleRefresh) => {
    const fileStale = snap.logSource === 'snapshot-stale' || snap.stale === true;
    const nearExpiry = isNearExpiryRemaining(snap.ttlMs ?? 0, contract);
    const isStale = fileStale || nearExpiry || scheduleRefresh;
    const src = isStale ? 'snapshot-stale' : 'snapshot';
    const memTtl =
      snap.ttlMs != null && snap.ttlMs > 0
        ? Math.max(snapshotNearExpiryRemainingMs(contract), snap.ttlMs)
        : ttlMs;
    cacheSet(cacheKey, snap.val, memTtl);
    if (isStale) {
      scheduleDashboardBackgroundRefresh({
        cacheKey,
        endpoint,
        tenantId,
        contract,
        extra,
        ttlMs,
        refreshSource,
        loader,
        rowsPick,
        pointsPick,
      });
    }
    return emitTrendResult(src, snap.val, memTtl, {
      stale: isStale,
      refreshPending: isStale,
      cacheLabel: isStale ? 'hit-snapshot-stale' : 'hit-snapshot',
    });
  };

  /** memory → table → snapshot(fresh) → snapshot-stale */
  const tryReturnSnapshotTrend = async () => {
    if (!isSnapshotCacheEnabled()) return null;

    const fresh = await readDashboardSnapshotCache(snapshotQuery, { allowStale: false });
    if (
      fresh.hit &&
      fresh.val != null &&
      !trendPayloadIsEmpty(endpoint, fresh.val, rowsPick, pointsPick)
    ) {
      const near = isNearExpiryRemaining(fresh.ttlMs ?? 0, contract);
      return returnSnapshotTrendHit(fresh, near);
    }

    const stale = await readDashboardSnapshotCache(snapshotQuery, { allowStale: true });
    if (stale.hit && stale.val != null) {
      return returnSnapshotTrendHit(stale, true);
    }

    logDashboardCacheLine(contract, {
      endpoint,
      sqlTag,
      durationMs: 0,
      cacheHit: false,
      cache: 'miss',
      cacheSource: 'snapshot-miss',
      refreshSource,
      ttlMs,
      cacheKey,
    });
    return null;
  };

  const tryReturnSnapshotSync = async () => {
    const { fresh, stale } = await readSnapshotLayers(snapshotCtx);
    if (fresh.hit && fresh.val != null) {
      const near = isNearExpiryRemaining(fresh.ttlMs ?? 0, contract);
      const memTtl =
        fresh.ttlMs != null && fresh.ttlMs > 0
          ? Math.max(snapshotNearExpiryRemainingMs(contract), fresh.ttlMs)
          : ttlMs;
      cacheSet(cacheKey, fresh.val, memTtl);
      if (near) {
        scheduleDashboardBackgroundRefresh({
          cacheKey,
          endpoint,
          tenantId,
          contract,
          extra,
          ttlMs,
          refreshSource,
          loader,
          rowsPick,
          pointsPick,
        });
        return emitHit('snapshot-stale', fresh.val, memTtl, 'hit-snapshot-near-expiry', {
          refreshPending: true,
        });
      }
      return emitHit('snapshot', fresh.val, memTtl, 'hit-snapshot');
    }
    if (stale.hit && stale.val != null) {
      const memTtl =
        stale.ttlMs != null && stale.ttlMs > 0
          ? Math.max(snapshotNearExpiryRemainingMs(contract), stale.ttlMs)
          : ttlMs;
      cacheSet(cacheKey, stale.val, memTtl);
      scheduleDashboardBackgroundRefresh({
        cacheKey,
        endpoint,
        tenantId,
        contract,
        extra,
        ttlMs,
        refreshSource,
        loader,
        rowsPick,
        pointsPick,
      });
      return emitHit('snapshot-stale', stale.val, memTtl, 'hit-snapshot-stale', { refreshPending: true });
    }
    if (!fresh.hit && !stale.hit) {
      logDashboardCacheLine(contract, {
        endpoint,
        sqlTag,
        durationMs: 0,
        cacheHit: false,
        cache: 'miss',
        cacheSource: 'snapshot-miss',
        refreshSource,
        ttlMs,
        cacheKey,
      });
    }
    return null;
  };

  const emitTrendResult = (
    cacheSource,
    val,
    hitTtlMs,
    /** @type {{ cacheLabel?: string, stale?: boolean, refreshPending?: boolean, reason?: string }} */ trendOpts = {},
  ) => {
    const empty = trendPayloadIsEmpty(endpoint, val, rowsPick, pointsPick);
    let src = cacheSource;
    let reason = trendOpts.reason;
    if (empty && !trendOpts.refreshPending && src !== 'pending') {
      src = 'db-empty';
      reason = reason || 'no_trend_data';
    }
    const cacheLabel = trendOpts.cacheLabel || 'hit';
    emitHit(src, val, hitTtlMs, cacheLabel);
    return /** @type {T} */ (
      stampTrendCacheMeta(endpoint, val, {
        cacheSource: src,
        stale: Boolean(trendOpts.stale),
        refreshPending: Boolean(trendOpts.refreshPending),
        ...(reason ? { reason } : {}),
      })
    );
  };

  const emitTrendPending = () => {
    const memPeek = peekTrendRefreshMem(cacheKey);
    if (
      memPeek.hit &&
      memPeek.val != null &&
      !trendPayloadIsEmpty(endpoint, memPeek.val, rowsPick, pointsPick)
    ) {
      warmDashboardSnapshot({
        endpoint,
        tenantId,
        contract,
        extra,
        cacheKey,
        val: memPeek.val,
        rowsPick,
      });
      const near = isNearExpiryRemaining(memPeek.ttlMs, contract);
      if (near) {
        scheduleDashboardBackgroundRefresh({
          cacheKey,
          endpoint,
          tenantId,
          contract,
          extra,
          ttlMs,
          refreshSource,
          loader,
          rowsPick,
          pointsPick,
        });
      }
      return emitTrendResult('memory', memPeek.val, memPeek.ttlMs, {
        cacheLabel: near ? 'hit-memory-near-expiry' : 'hit-memory-peek',
        stale: near,
        refreshPending: near,
      });
    }

    markTrendPending(cacheKey);
    const placeholder = buildTrendPendingPlaceholder(endpoint, contract, extra);
    const rows = rowsPick ? rowsPick(placeholder) : undefined;
    const points = pointsPick ? pointsPick(placeholder) : undefined;
    logDashboardCacheLine(contract, {
      endpoint,
      sqlTag,
      durationMs: 0,
      cacheHit: false,
      cache: 'miss-async',
      cacheSource: 'pending',
      refreshSource,
      ttlMs,
      rows,
      points,
      cacheKey,
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
      cache: 'miss-async',
      cacheSource: 'pending',
      refreshSource,
      durationMs: 0,
      sqlMs: 0,
      rows,
      points,
    });
    return emitTrendResult('pending', placeholder, ttlMs, {
      cacheLabel: 'miss-async',
      refreshPending: true,
    });
  };

  if (isTrendCacheEndpoint(endpoint)) {
    const memHit = cacheGet(cacheKey);
    if (memHit.hit && memHit.val != null) {
      warmDashboardSnapshot({
        endpoint,
        tenantId,
        contract,
        extra,
        cacheKey,
        val: memHit.val,
        rowsPick,
      });
      const near = isNearExpiryRemaining(memHit.ttlMs, contract);
      if (near) {
        scheduleDashboardBackgroundRefresh({
          cacheKey,
          endpoint,
          tenantId,
          contract,
          extra,
          ttlMs,
          refreshSource,
          loader,
          rowsPick,
          pointsPick,
        });
        return emitTrendResult('memory', memHit.val, memHit.ttlMs, {
          stale: true,
          refreshPending: true,
          cacheLabel: 'hit-memory-near-expiry',
        });
      }
      return emitTrendResult('memory', memHit.val, memHit.ttlMs);
    }

    if (isTableCacheEnabled()) {
      const tableFresh = await readDashboardTableCache(
        { endpoint, tenantId, contract, extra, cacheKey },
        { allowStale: false },
      );
      if (tableFresh.hit && tableFresh.val != null) {
        const memTtl =
          tableFresh.ttlMs != null && tableFresh.ttlMs > 0 ? tableFresh.ttlMs : tableTtlMs(endpoint, contract);
        cacheSet(cacheKey, tableFresh.val, memTtl);
        warmDashboardSnapshot({
          endpoint,
          tenantId,
          contract,
          extra,
          cacheKey,
          val: tableFresh.val,
          rowsPick,
        });
        return emitTrendResult('table', tableFresh.val, memTtl);
      }
    }

    const snapTrend = await tryReturnSnapshotTrend();
    if (snapTrend != null) return snapTrend;

    if (isTableCacheEnabled()) {
      const tableStale = await readDashboardTableCache(
        { endpoint, tenantId, contract, extra, cacheKey },
        { allowStale: true, maxStaleSec: Math.max(600, Math.ceil(trendCacheTtlMs(contract) / 1000) * 2) },
      );
      if (tableStale.hit && tableStale.val != null) {
        const memTtl =
          tableStale.ttlMs != null && tableStale.ttlMs > 0 ? tableStale.ttlMs : tableTtlMs(endpoint, contract);
        cacheSet(cacheKey, tableStale.val, memTtl);
        warmDashboardSnapshot({
          endpoint,
          tenantId,
          contract,
          extra,
          cacheKey,
          val: tableStale.val,
          rowsPick,
        });
        scheduleDashboardBackgroundRefresh({
          cacheKey,
          endpoint,
          tenantId,
          contract,
          extra,
          ttlMs,
          refreshSource,
          loader,
          rowsPick,
          pointsPick,
        });
        return emitTrendResult('table-stale', tableStale.val, memTtl, {
          stale: true,
          refreshPending: true,
          cacheLabel: 'hit-stale',
        });
      }

      const maxStaleSec = Math.max(600, Math.ceil(trendCacheTtlMs(contract) / 1000) * 2);
      const dimStale = await readTrendTableStaleByDimensions(
        { endpoint, tenantId, contract, extra, cacheKey },
        { maxStaleSec },
      );
      if (dimStale.hit && dimStale.val != null) {
        const memTtl =
          dimStale.ttlMs != null && dimStale.ttlMs > 0 ? dimStale.ttlMs : tableTtlMs(endpoint, contract);
        cacheSet(cacheKey, dimStale.val, memTtl);
        warmDashboardSnapshot({
          endpoint,
          tenantId,
          contract,
          extra,
          cacheKey,
          val: dimStale.val,
          rowsPick,
        });
        scheduleDashboardBackgroundRefresh({
          cacheKey,
          endpoint,
          tenantId,
          contract,
          extra,
          ttlMs,
          refreshSource,
          loader,
          rowsPick,
          pointsPick,
        });
        return emitTrendResult('table-stale', dimStale.val, memTtl, {
          stale: true,
          refreshPending: true,
          cacheLabel: 'hit-stale-dim',
        });
      }
    }

    if (!trendRefreshInflight.has(cacheKey)) {
      scheduleDashboardBackgroundRefresh({
        cacheKey,
        endpoint,
        tenantId,
        contract,
        extra,
        ttlMs,
        refreshSource,
        loader,
        rowsPick,
        pointsPick,
      });
    }
    return emitTrendPending();
  }

  const cached = cacheGet(cacheKey);
  if (cached.hit && cached.val != null) {
    warmDashboardSnapshot({
      endpoint,
      tenantId,
      contract,
      extra,
      cacheKey,
      val: cached.val,
      rowsPick,
    });
    const near = isNearExpiryRemaining(cached.ttlMs, contract);
    if (near) {
      scheduleDashboardBackgroundRefresh({
        cacheKey,
        endpoint,
        tenantId,
        contract,
        extra,
        ttlMs,
        refreshSource,
        loader,
        rowsPick,
        pointsPick,
      });
      return emitHit('memory', cached.val, cached.ttlMs, 'hit-memory-near-expiry', {
        refreshPending: true,
      });
    }
    return emitHit('memory', cached.val, cached.ttlMs);
  }

  if (isTableCacheEnabled()) {
    const tableHit = await readDashboardTableCache(
      { endpoint, tenantId, contract, extra, cacheKey },
      { allowStale: false },
    );
    if (tableHit.hit && tableHit.val != null) {
      const val = /** @type {T} */ (tableHit.val);
      const memTtl = tableHit.ttlMs != null && tableHit.ttlMs > 0 ? tableHit.ttlMs : ttlMs;
      cacheSet(cacheKey, val, memTtl);
      warmDashboardSnapshot({
        endpoint,
        tenantId,
        contract,
        extra,
        cacheKey,
        val,
        rowsPick,
      });
      return emitHit('table', val, memTtl);
    }
  }

  const snapSync = await tryReturnSnapshotSync();
  if (snapSync != null) return snapSync;

  const t0 = Date.now();
  const val = await loader();
  const durationMs = Date.now() - t0;
  persistDashboardCaches({
    cacheKey,
    val,
    ttlMs,
    endpoint,
    tenantId,
    contract,
    extra,
    refreshSource,
    rowsPick,
  });
  const rows = rowsPick ? rowsPick(val) : undefined;
  const points = pointsPick ? pointsPick(val) : undefined;
  logDashboardCacheLine(contract, {
    endpoint,
    sqlTag,
    durationMs,
    cacheHit: false,
    cache: 'miss',
    cacheSource: 'db',
    refreshSource,
    ttlMs,
    rows,
    points,
    cacheKey,
  });
  recordDashboardRequest({
    endpoint,
    sqlTag,
    durationMs,
    cacheHit: false,
    tenant: tenantId,
    market: contract.market,
    orderFilter: contract.orderFilter,
    timeRange: contract.timeRange,
    shopId: contract.shopId,
    rows,
  });
  emitPerfProbe(probeBase, {
    cache: 'miss',
    cacheSource: 'db',
    refreshSource,
    durationMs,
    sqlMs: durationMs,
    rows,
    points,
  });
  return val;
}

function clearDashboardCache() {
  memCache.clear();
}

module.exports = {
  buildDashboardCacheKey,
  clampTtlMs,
  isTodayLiveContract,
  TODAY_ENDPOINT_TTL_MS,
  isDashboardCacheBypass,
  resolveRefreshSource,
  withDashboardCache,
  clearDashboardCache,
  logDashboardCacheLine,
  TTL_BOUNDS,
  isTrendCacheEndpoint,
  trendCacheTtlMs,
  cacheGet,
  cacheSet,
  persistDashboardCaches,
  warmDashboardSnapshot,
  isDashboardApiReadonly,
  memCache,
  purgeMemCacheLegacyPaidTrend,
};
