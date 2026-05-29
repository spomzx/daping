'use strict';

/**
 * Dashboard 后台预计算调度器（today 高频 / history 低频 / 凌晨全量）
 */

const {
  isPrecomputeSchedulerEnabled,
  parsePrecomputeTenants,
  consumePrecomputeHints,
} = require('./dashboardReadonly');
const {
  buildPrecomputeJobs,
  runPrecomputeJob,
  logPrecompute,
} = require('./dashboardPrecomputeCore');
const { buildDashboardCacheKey } = require('./dashboardCache');
const { parseDashboardFilterQuery } = require('../modules/dashboard/filterContract');

/** @type {Map<string, number>} scope:tenantId → cursor */
const scopeCursor = new Map();

let started = false;
/** @type {ReturnType<typeof setInterval> | null} */
let todayTimer = null;
/** @type {ReturnType<typeof setInterval> | null} */
let historyTimer = null;
let todayRoundRunning = false;
let historyRoundRunning = false;

function todayIntervalMs() {
  const n = Number(process.env.DASHBOARD_PRECOMPUTE_TODAY_INTERVAL_MS);
  return Number.isFinite(n) && n >= 10_000 ? Math.floor(n) : 30_000;
}

function historyIntervalMs() {
  const n = Number(process.env.DASHBOARD_PRECOMPUTE_HISTORY_INTERVAL_MS);
  return Number.isFinite(n) && n >= 60_000 ? Math.floor(n) : 300_000;
}

function precomputeConcurrency() {
  const n = Number(process.env.DASHBOARD_PRECOMPUTE_CONCURRENCY);
  return Number.isFinite(n) && n >= 1 ? Math.min(4, Math.floor(n)) : 2;
}

function maxJobsPerRound(scope) {
  const n = Number(process.env.DASHBOARD_PRECOMPUTE_MAX_PER_ROUND);
  const cap = scope === 'today' ? 80 : 40;
  if (Number.isFinite(n) && n >= 5) return Math.min(cap, Math.floor(n));
  return cap;
}

function dailyFullHour() {
  const n = Number(process.env.DASHBOARD_PRECOMPUTE_DAILY_FULL_HOUR);
  return Number.isFinite(n) && n >= 0 && n <= 23 ? Math.floor(n) : 2;
}

function dailyFullMinute() {
  const n = Number(process.env.DASHBOARD_PRECOMPUTE_DAILY_FULL_MINUTE);
  return Number.isFinite(n) && n >= 0 && n <= 59 ? Math.floor(n) : 0;
}

/**
 * @param {ReturnType<typeof buildPrecomputeJobs>} jobs
 * @param {string[]} priorityCacheKeys
 */
function prioritizeJobs(jobs, priorityCacheKeys) {
  if (!priorityCacheKeys.length) return jobs;
  const set = new Set(priorityCacheKeys);
  const front = [];
  const rest = [];
  for (const job of jobs) {
    const q = {
      shopId: 'all',
      market: job.market,
      timeRange: job.timeRange,
      orderFilter: job.orderFilter,
      groupBy: job.extra?.groupBy,
    };
    const contract = parseDashboardFilterQuery(q, job.tenantId);
    const cacheKey = buildDashboardCacheKey(job.endpoint, job.tenantId, contract, job.extra);
    if (set.has(cacheKey)) front.push(job);
    else rest.push(job);
  }
  return [...front, ...rest];
}

/**
 * @param {ReturnType<typeof buildPrecomputeJobs>} allJobs
 * @param {number} cursor
 * @param {number} batchSize
 */
function sliceBatch(allJobs, cursor, batchSize) {
  const total = allJobs.length;
  const n = Math.min(batchSize, total);
  const batch = [];
  for (let i = 0; i < n; i++) batch.push(allJobs[(cursor + i) % total]);
  return {
    batch,
    nextCursor: (cursor + n) % total,
    batchStart: cursor % total,
    batchEnd: (cursor + n - 1) % total,
  };
}

/**
 * @param {string} scope
 * @param {number} tenantId
 * @param {{ forceAll?: boolean }} [opts]
 */
async function runPrecomputeRoundForTenant(scope, tenantId, opts = {}) {
  let allJobs = buildPrecomputeJobs(scope, tenantId);
  const hints = consumePrecomputeHints(48);
  allJobs = prioritizeJobs(allJobs, hints);

  const key = `${scope}:${tenantId}`;
  let cursor = scopeCursor.get(key) ?? 0;
  if (opts.forceAll) cursor = 0;

  const batchSize = opts.forceAll ? allJobs.length : maxJobsPerRound(scope);
  const { batch, nextCursor, batchStart, batchEnd } = sliceBatch(allJobs, cursor, batchSize);
  scopeCursor.set(key, nextCursor);

  const t0 = Date.now();
  let processed = 0;
  let written = 0;
  let skipped = 0;
  let failed = 0;

  let nextIdx = 0;
  const concurrency = precomputeConcurrency();

  async function worker() {
    for (;;) {
      const i = nextIdx;
      nextIdx += 1;
      if (i >= batch.length) return;
      const job = batch[i];
      logPrecompute([
        'job-start',
        `endpoint=${job.endpoint}`,
        `timeRange=${job.timeRange}`,
        `orderFilter=${job.orderFilter}`,
        `market=${job.market}`,
        `tenant=${tenantId}`,
      ]);
      const res = await runPrecomputeJob(job);
      processed += 1;
      if (res.status === 'done') {
        written += 1;
        logPrecompute([
          'job-done',
          `endpoint=${job.endpoint}`,
          `timeRange=${job.timeRange}`,
          `orderFilter=${job.orderFilter}`,
          `market=${job.market}`,
          `tenant=${tenantId}`,
          `durationMs=${res.durationMs}`,
          `rows=${res.rows}`,
          `written=${res.written}`,
        ]);
      } else if (res.status === 'skipped') {
        skipped += 1;
        logPrecompute([
          'job-skip-fresh',
          `endpoint=${job.endpoint}`,
          `timeRange=${job.timeRange}`,
          `orderFilter=${job.orderFilter}`,
          `market=${job.market}`,
          `tenant=${tenantId}`,
          `reason=${res.reason || 'fresh'}`,
        ]);
      } else {
        failed += 1;
        logPrecompute([
          'job-fail',
          `endpoint=${job.endpoint}`,
          `timeRange=${job.timeRange}`,
          `tenant=${tenantId}`,
          `reason=${res.reason || 'error'}`,
        ]);
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, batch.length) }, () => worker()),
  );

  logPrecompute([
    'round-finish',
    `scope=${scope}`,
    `tenant=${tenantId}`,
    `batchStart=${batchStart}`,
    `batchEnd=${batchEnd}`,
    `processed=${processed}`,
    `written=${written}`,
    `skipped=${skipped}`,
    `failed=${failed}`,
    `durationMs=${Date.now() - t0}`,
  ]);
}

async function runTodayRound() {
  if (todayRoundRunning) return;
  todayRoundRunning = true;
  try {
    for (const tenantId of parsePrecomputeTenants()) {
      await runPrecomputeRoundForTenant('today', tenantId);
    }
  } finally {
    todayRoundRunning = false;
  }
}

async function runHistoryRound() {
  if (historyRoundRunning) return;
  historyRoundRunning = true;
  try {
    for (const tenantId of parsePrecomputeTenants()) {
      await runPrecomputeRoundForTenant('history', tenantId);
    }
  } finally {
    historyRoundRunning = false;
  }
}

async function runDailyFullMatrix() {
  logPrecompute(['daily-full-start']);
  for (const tenantId of parsePrecomputeTenants()) {
    await runPrecomputeRoundForTenant('today', tenantId, { forceAll: true });
    await runPrecomputeRoundForTenant('history', tenantId, { forceAll: true });
  }
  logPrecompute(['daily-full-done']);
}

let lastDailyFullYmd = '';

function maybeRunDailyFull() {
  const now = new Date();
  const ymd = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;
  if (ymd === lastDailyFullYmd) return;
  if (now.getHours() !== dailyFullHour() || now.getMinutes() !== dailyFullMinute()) return;
  lastDailyFullYmd = ymd;
  void runDailyFullMatrix();
}

function startDashboardPrecomputeScheduler() {
  if (started) return;
  if (!isPrecomputeSchedulerEnabled()) {
    console.log('[dashboard-precompute] skipped reason=disabled');
    return;
  }
  started = true;
  const tenants = parsePrecomputeTenants();
  for (const tid of tenants) {
    scopeCursor.set(`today:${tid}`, 0);
    scopeCursor.set(`history:${tid}`, 0);
  }
  logPrecompute([
    'started',
    `tenants=${tenants.join(',')}`,
    `todayIntervalMs=${todayIntervalMs()}`,
    `historyIntervalMs=${historyIntervalMs()}`,
    `concurrency=${precomputeConcurrency()}`,
  ]);

  setTimeout(() => void runTodayRound(), 5000);
  setTimeout(() => void runHistoryRound(), 15_000);

  todayTimer = setInterval(() => {
    maybeRunDailyFull();
    void runTodayRound();
  }, todayIntervalMs());

  historyTimer = setInterval(() => {
    void runHistoryRound();
  }, historyIntervalMs());
}

function stopDashboardPrecomputeScheduler() {
  if (todayTimer) clearInterval(todayTimer);
  if (historyTimer) clearInterval(historyTimer);
  todayTimer = null;
  historyTimer = null;
  started = false;
}

module.exports = {
  startDashboardPrecomputeScheduler,
  stopDashboardPrecomputeScheduler,
  runTodayRound,
  runHistoryRound,
  runDailyFullMatrix,
};
