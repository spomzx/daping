'use strict';

/**
 * Dashboard JSON snapshot 预热调度器（全量矩阵滚动执行）
 * 5 endpoints × 4 timeRange × 5 orderFilter × 6 market = 600 jobs / tenant
 */

const { buildDashboardCacheKey } = require('./dashboardCache');
const {
  isSnapshotCacheEnabled,
  isProdDeploy,
  writeDashboardSnapshotCache,
  snapshotTtlMs,
  snapshotWarmSkipReason,
  shouldPersistSnapshot,
} = require('./dashboardSnapshotCache');
const { parseDashboardFilterQuery } = require('../modules/dashboard/filterContract');

const TIME_RANGES = ['today', 'yesterday', 'last7', 'last30'];

/** 列表/筛选视图 */
const ORDER_FILTERS = ['paid', 'all', 'valid', 'cancelled', 'sample'];
/** 趋势 KPI：仅 valid（禁止预热 paid snapshot） */
const TREND_KPI_ORDER_FILTERS = ['valid'];

const MARKETS = ['ALL', 'TH', 'MY', 'PH', 'VN', 'SG'];

/** 趋势图优先，其次 summary / ranking / product-ranking */
const ENDPOINT_PRIORITY = ['gmv-compare', 'order-volume', 'summary', 'ranking', 'product-ranking'];

const SHOP_ID = 'all';

const TOTAL_JOBS_PER_TENANT =
  ENDPOINT_PRIORITY.length * TIME_RANGES.length * ORDER_FILTERS.length * MARKETS.length;

/** @type {Map<string, Promise<{ status: string }>>} */
const warmInflight = new Map();

/** @type {Map<number, number>} */
const tenantCursor = new Map();

let warmSchedulerStarted = false;
/** @type {ReturnType<typeof setInterval> | null} */
let warmInterval = null;
let warmRoundRunning = false;

function isTruthyEnvFlag(value) {
  const s = String(value ?? '')
    .trim()
    .toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}

function parseWarmupTenants() {
  const raw =
    process.env.DASHBOARD_SNAPSHOT_WARMUP_TENANTS ||
    process.env.DASHBOARD_REFRESH_SCHEDULER_TENANTS ||
    '';
  const out = [];
  for (const part of String(raw).split(',')) {
    const n = Number(String(part).trim());
    if (Number.isFinite(n) && n > 0) out.push(Math.floor(n));
  }
  return [...new Set(out)];
}

function isSnapshotWarmupEnabled() {
  try {
    const { isPrecomputeSchedulerEnabled } = require('./dashboardReadonly');
    if (isPrecomputeSchedulerEnabled()) return false;
  } catch {
    /* ignore */
  }
  const raw = process.env.DASHBOARD_SNAPSHOT_WARMUP_ENABLED;
  if (raw != null && String(raw).trim() !== '') {
    return isTruthyEnvFlag(raw) && isSnapshotCacheEnabled() && parseWarmupTenants().length > 0;
  }
  if (isProdDeploy()) return false;
  return isSnapshotCacheEnabled() && parseWarmupTenants().length > 0;
}

function warmupIntervalMs() {
  const n = Number(process.env.DASHBOARD_SNAPSHOT_WARMUP_INTERVAL_MS);
  return Number.isFinite(n) && n >= 15_000 ? Math.floor(n) : 60_000;
}

function warmupConcurrency() {
  const n = Number(process.env.DASHBOARD_SNAPSHOT_WARMUP_CONCURRENCY);
  return Number.isFinite(n) && n >= 1 ? Math.min(4, Math.floor(n)) : 2;
}

function warmupMaxPerRound() {
  const n = Number(process.env.DASHBOARD_SNAPSHOT_WARMUP_MAX_PER_ROUND);
  if (Number.isFinite(n) && n >= 10) return Math.min(TOTAL_JOBS_PER_TENANT, Math.floor(n));
  return Math.min(TOTAL_JOBS_PER_TENANT, 120);
}

function trendGroupBy(timeRange) {
  const tr = String(timeRange || 'today').toLowerCase();
  return tr === 'last7' || tr === 'last30' || tr === 'custom' ? 'day' : 'hour';
}

/**
 * @param {string} status
 * @param {ReturnType<typeof buildAllWarmJobs>[number]} job
 * @param {Record<string, string|number>} [extra]
 */
function logWarmJob(status, job, extra = {}) {
  const parts = [
    `endpoint=${job.endpoint}`,
    `timeRange=${job.timeRange}`,
    `orderFilter=${job.orderFilter}`,
    `market=${job.market}`,
    `status=${status}`,
    `tenant=${job.tenantId}`,
  ];
  for (const [k, v] of Object.entries(extra)) {
    if (v != null && String(v) !== '') parts.push(`${k}=${v}`);
  }
  console.log(`[dashboard-snapshot-warmup] ${parts.join(' ')}`);
}

/**
 * @param {number} tenantId
 */
function buildAllWarmJobs(tenantId) {
  /** @type {Record<string, Array<{
   *   tenantId: number,
   *   endpoint: string,
   *   timeRange: string,
   *   orderFilter: string,
   *   market: string,
   *   shopId: string,
   *   extra: Record<string, string>,
   * }>>} */
  const buckets = {};
  for (const endpoint of ENDPOINT_PRIORITY) {
    buckets[endpoint] = [];
  }

  for (const endpoint of ENDPOINT_PRIORITY) {
    const filtersForEndpoint =
      endpoint === 'gmv-compare' || endpoint === 'order-volume'
        ? TREND_KPI_ORDER_FILTERS
        : ORDER_FILTERS;
    for (const timeRange of TIME_RANGES) {
      for (const orderFilter of filtersForEndpoint) {
        for (const market of MARKETS) {
          const extra =
            endpoint === 'gmv-compare' || endpoint === 'order-volume'
              ? { groupBy: trendGroupBy(timeRange) }
              : {};
          buckets[endpoint].push({
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

  return ENDPOINT_PRIORITY.flatMap((ep) => buckets[ep] || []);
}

/**
 * @param {ReturnType<typeof buildAllWarmJobs>} allJobs
 * @param {number} cursor
 * @param {number} batchSize
 */
function sliceWarmBatch(allJobs, cursor, batchSize) {
  const total = allJobs.length;
  const n = Math.min(batchSize, total);
  const batch = [];
  for (let i = 0; i < n; i++) {
    batch.push(allJobs[(cursor + i) % total]);
  }
  const batchStart = cursor % total;
  const batchEnd = (cursor + n - 1) % total;
  const nextCursor = (cursor + n) % total;
  return { batch, batchStart, batchEnd, nextCursor, batchSize: n };
}

/**
 * @param {ReturnType<typeof buildAllWarmJobs>[number]} job
 */
function buildWarmupQuery(job) {
  const market = String(job.market || 'ALL').trim().toUpperCase() || 'ALL';
  return {
    shopId: SHOP_ID,
    shop_id: SHOP_ID,
    market,
    region: market === 'ALL' ? 'all' : market.toLowerCase(),
    timeRange: job.timeRange,
    range: job.timeRange,
    orderFilter: job.orderFilter,
    cacheBypass: '1',
    forceRefresh: '1',
    refreshSource: 'warmup',
    scheduler: '1',
    warmup: '1',
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
  return undefined;
}

/**
 * @param {ReturnType<typeof buildAllWarmJobs>[number]} job
 */
async function loadWarmupPayload(job) {
  const q = buildWarmupQuery(job);
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
      throw new Error(`warmup_unknown_endpoint:${job.endpoint}`);
  }
}

/**
 * @param {ReturnType<typeof buildAllWarmJobs>[number]} job
 * @returns {Promise<{ status: 'written'|'skipped'|'failed', reason?: string, durationMs?: number, rows?: number }>}
 */
async function runSingleWarmJob(job) {
  const q = buildWarmupQuery(job);
  const contract = parseDashboardFilterQuery(q, job.tenantId);
  const cacheKey = buildDashboardCacheKey(job.endpoint, job.tenantId, contract, job.extra);
  const snapQuery = {
    endpoint: job.endpoint,
    tenantId: job.tenantId,
    contract,
    extra: job.extra,
    cacheKey,
  };

  const existing = warmInflight.get(cacheKey);
  if (existing) {
    try {
      return await existing;
    } catch {
      logWarmJob('skip-inflight', job, { reason: 'inflight-fail' });
      return { status: 'skipped', reason: 'inflight' };
    }
  }

  const skipReason = await snapshotWarmSkipReason(snapQuery);
  if (skipReason) {
    logWarmJob('skip-existing', job, { reason: skipReason });
    return { status: 'skipped', reason: skipReason };
  }

  const runPromise = (async () => {
    const t0 = Date.now();
    try {
      const val = await loadWarmupPayload(job);
      const durationMs = Date.now() - t0;
      const rows = rowsPickForEndpoint(job.endpoint, val);

      if (!shouldPersistSnapshot(job.endpoint, val, (v) => rowsPickForEndpoint(job.endpoint, v))) {
        logWarmJob('skip-empty', job, { durationMs, rows: rows ?? 0, reason: 'no_data' });
        return { status: 'skipped', reason: 'empty-payload', durationMs, rows: rows ?? 0 };
      }

      await writeDashboardSnapshotCache(snapQuery, val, snapshotTtlMs(contract));
      logWarmJob('write-ok', job, { rows: rows ?? 0, durationMs });
      return { status: 'written', durationMs, rows: rows ?? 0 };
    } catch (e) {
      logWarmJob('write-fail', job, { error: String(e?.message || e).slice(0, 160) });
      return { status: 'failed', reason: String(e?.message || e) };
    }
  })();

  warmInflight.set(cacheKey, runPromise);
  try {
    return await runPromise;
  } finally {
    warmInflight.delete(cacheKey);
  }
}

/**
 * 并发池：固定 worker 数，每个 worker 循环 claim 下一任务，直到 batch 全部消费完。
 * 禁止 Promise.all(jobs.slice(0, concurrency)) 只跑前 N 个。
 *
 * @param {ReturnType<typeof buildAllWarmJobs>} jobs
 * @param {number} concurrency
 * @param {(job: ReturnType<typeof buildAllWarmJobs>[number], indexInBatch: number) => Promise<unknown>} handler
 * @returns {Promise<number>} 实际 handler 调用次数
 */
async function runJobQueue(jobs, concurrency, handler) {
  const total = jobs.length;
  if (total === 0) return 0;

  let claimIndex = 0;
  let handled = 0;

  async function drainWorker(workerId) {
    for (;;) {
      const i = claimIndex;
      claimIndex += 1;
      if (i >= total) return;

      try {
        await handler(jobs[i], i);
      } catch (e) {
        console.warn(
          '[dashboard-snapshot-warmup] handler error',
          `worker=${workerId}`,
          `index=${i}`,
          e?.message || e,
        );
      } finally {
        handled += 1;
      }
    }
  }

  const workerCount = Math.min(Math.max(1, concurrency), total);
  await Promise.all(
    Array.from({ length: workerCount }, (_, workerId) => drainWorker(workerId)),
  );

  if (handled !== total || claimIndex < total) {
    console.warn(
      '[dashboard-snapshot-warmup] queue-incomplete',
      `handled=${handled}`,
      `claimed=${claimIndex}`,
      `expected=${total}`,
      `workers=${workerCount}`,
    );
  }
  return handled;
}

/**
 * @param {number} tenantId
 * @param {ReturnType<typeof buildAllWarmJobs>} allJobs
 */
async function runWarmupRoundForTenant(tenantId, allJobs) {
  const total = allJobs.length;
  const maxPerRound = warmupMaxPerRound();
  const cursor = tenantCursor.get(tenantId) ?? 0;
  const { batch, batchStart, batchEnd, nextCursor, batchSize } = sliceWarmBatch(
    allJobs,
    cursor,
    maxPerRound,
  );

  tenantCursor.set(tenantId, nextCursor);

  const t0 = Date.now();
  let written = 0;
  let skipped = 0;
  let failed = 0;
  let processed = 0;

  console.log(
    `[dashboard-snapshot-warmup] start tenant=${tenantId} batchStart=${batchStart} batchEnd=${batchEnd} batchSize=${batchSize} total=${total} cursor=${cursor} nextCursor=${nextCursor}`,
  );

  const handled = await runJobQueue(batch, warmupConcurrency(), async (job) => {
    const res = await runSingleWarmJob(job);
    if (res.status === 'written') written += 1;
    else if (res.status === 'skipped') skipped += 1;
    else if (res.status === 'failed') failed += 1;
    return res;
  });
  processed = handled;

  if (processed !== batchSize) {
    console.warn(
      '[dashboard-snapshot-warmup] batch-incomplete',
      `tenant=${tenantId}`,
      `processed=${processed}`,
      `batchSize=${batchSize}`,
    );
  }

  console.log(
    `[dashboard-snapshot-warmup] finish tenant=${tenantId} batchStart=${batchStart} batchEnd=${batchEnd} total=${total} nextCursor=${nextCursor} batchSize=${batchSize} processed=${processed} written=${written} skipped=${skipped} failed=${failed} durationMs=${Date.now() - t0}`,
  );
}

async function runWarmupRound() {
  if (warmRoundRunning) return;
  if (!isSnapshotWarmupEnabled()) return;

  warmRoundRunning = true;
  try {
    const tenants = parseWarmupTenants();
    for (const tenantId of tenants) {
      const jobs = buildAllWarmJobs(tenantId);
      await runWarmupRoundForTenant(tenantId, jobs);
    }
  } catch (e) {
    console.warn('[dashboard-snapshot-warmup] round fail', e?.message || e);
  } finally {
    warmRoundRunning = false;
  }
}

function startDashboardSnapshotWarmScheduler() {
  if (warmSchedulerStarted) return;
  if (!isSnapshotWarmupEnabled()) {
    console.log('[dashboard-snapshot-warmup] skipped reason=disabled');
    return;
  }
  warmSchedulerStarted = true;
  const tenants = parseWarmupTenants();
  for (const tid of tenants) {
    if (!tenantCursor.has(tid)) tenantCursor.set(tid, 0);
  }
  console.log(
    `[dashboard-snapshot-warmup] scheduler-started tenants=${tenants.join(',')} jobsPerTenant=${TOTAL_JOBS_PER_TENANT} intervalMs=${warmupIntervalMs()} concurrency=${warmupConcurrency()} maxPerRound=${warmupMaxPerRound()}`,
  );

  setTimeout(() => {
    void runWarmupRound();
  }, 3000);

  warmInterval = setInterval(() => {
    void runWarmupRound();
  }, warmupIntervalMs());
}

function stopDashboardSnapshotWarmScheduler() {
  if (warmInterval) clearInterval(warmInterval);
  warmInterval = null;
  warmSchedulerStarted = false;
}

module.exports = {
  TIME_RANGES,
  ORDER_FILTERS,
  MARKETS,
  ENDPOINTS: ENDPOINT_PRIORITY,
  ENDPOINT_PRIORITY,
  SHOP_ID,
  TOTAL_JOBS_PER_TENANT,
  WARM_ENDPOINTS: ENDPOINT_PRIORITY,
  WARM_TIME_RANGES: TIME_RANGES,
  WARM_ORDER_FILTERS: ORDER_FILTERS,
  WARM_MARKETS: MARKETS,
  isSnapshotWarmupEnabled,
  parseWarmupTenants,
  buildAllWarmJobs,
  sliceWarmBatch,
  runJobQueue,
  runWarmupRound,
  startDashboardSnapshotWarmScheduler,
  stopDashboardSnapshotWarmScheduler,
};
