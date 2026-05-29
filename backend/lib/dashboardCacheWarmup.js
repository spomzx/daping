'use strict';

/**
 * Dashboard 契约缓存预热（服务启动后异步执行，不阻塞 listen）。
 * 默认关闭：需 DASHBOARD_CACHE_WARMUP_ENABLED 为真 且 DASHBOARD_CACHE_WARMUP_TENANTS 非空。
 * 仅预热首屏 summary / ranking；默认延迟 60s，避免与首屏抢库。
 */

const { buildDashboardCacheKey } = require('./dashboardCache');
const { isDashboardRequestBusy } = require('./dashboardSlowCollector');

const WARMUP_ORDER_FILTERS = ['paid', 'all', 'valid'];
/** 仅首屏 KPI + 排行；不重查询图表端点 */
const WARMUP_ENDPOINTS = ['summary', 'ranking'];

let scheduleInvoked = false;

function isTruthyEnvFlag(value) {
  const s = String(value ?? '')
    .trim()
    .toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}

function parseWarmupTenants() {
  const raw = String(process.env.DASHBOARD_CACHE_WARMUP_TENANTS || '').trim();
  if (!raw) return [];
  const out = [];
  for (const part of raw.split(',')) {
    const n = Number(String(part).trim());
    if (Number.isFinite(n) && n > 0) out.push(Math.floor(n));
  }
  return [...new Set(out)];
}

function readWarmupEnvSnapshot() {
  return {
    enabledRaw: process.env.DASHBOARD_CACHE_WARMUP_ENABLED,
    enabled: isTruthyEnvFlag(process.env.DASHBOARD_CACHE_WARMUP_ENABLED),
    tenants: parseWarmupTenants(),
    delayMs: warmupDelayMs(),
    concurrency: warmupConcurrency(),
  };
}

function isDashboardCacheWarmupEnabled() {
  const snap = readWarmupEnvSnapshot();
  return snap.enabled && snap.tenants.length > 0;
}

function warmupDelayMs() {
  const raw = Number(process.env.DASHBOARD_CACHE_WARMUP_DELAY_MS);
  if (Number.isFinite(raw) && raw >= 0) return Math.floor(raw);
  return 60_000;
}

/** Phase-5.1：固定 1，不与页面请求抢 MySQL */
function warmupConcurrency() {
  return 1;
}

function logWarmupLine(parts) {
  const msg = `[dashboard-cache-warmup] ${parts.join(' ')}`;
  console.log(msg);
}

/**
 * @param {number} tenantId
 * @param {string} orderFilter
 */
function buildWarmupQuery(tenantId, orderFilter) {
  return {
    shopId: 'all',
    shop_id: 'all',
    market: 'ALL',
    region: 'all',
    timeRange: 'today',
    range: 'today',
    orderFilter,
    tenantId,
  };
}

/**
 * @param {number} tenantId
 * @param {string} orderFilter
 * @param {string} endpoint
 */
function warmupCacheKeyFor(tenantId, orderFilter, endpoint) {
  const contract = {
    tenantId,
    shopId: 'all',
    market: 'ALL',
    orderFilter,
    timeRange: 'today',
    startDate: '',
    endDate: '',
  };
  const extra =
    endpoint === 'ranking' ? { limit: '30', sort: 'gmv' } : {};
  return buildDashboardCacheKey(endpoint, tenantId, contract, extra);
}

/**
 * @returns {{ tenantId: number, orderFilter: string, endpoint: string, cacheKey: string }[]}
 */
function listWarmupJobs() {
  const tenants = parseWarmupTenants();
  const jobs = [];
  for (const tenantId of tenants) {
    for (const orderFilter of WARMUP_ORDER_FILTERS) {
      for (const endpoint of WARMUP_ENDPOINTS) {
        jobs.push({
          tenantId,
          orderFilter,
          endpoint,
          cacheKey: warmupCacheKeyFor(tenantId, orderFilter, endpoint),
        });
      }
    }
  }
  return jobs;
}

/**
 * @param {{ tenantId: number, orderFilter: string, endpoint: string }} job
 */
async function runWarmupJob(job) {
  const q = buildWarmupQuery(job.tenantId, job.orderFilter);
  switch (job.endpoint) {
    case 'summary': {
      const { getTodayOrderSummary } = require('../services/orderMetricsService');
      await getTodayOrderSummary(job.tenantId, q, null);
      return;
    }
    case 'ranking': {
      const { queryDashboardRanking } = require('../modules/dashboard/rankingQuery');
      await queryDashboardRanking(job.tenantId, { ...q, limit: 30, sort: 'gmv' });
      return;
    }
    default:
      throw new Error(`unknown_warmup_endpoint:${job.endpoint}`);
  }
}

/**
 * 顺序执行预热；单任务失败不中断；繁忙时整轮跳过。
 */
async function runDashboardCacheWarmup() {
  if (isDashboardRequestBusy({ minRequests: 4, windowMs: 5000 })) {
    logWarmupLine(['skipped', 'reason=busy']);
    return;
  }

  const tenants = parseWarmupTenants();
  const jobs = listWarmupJobs();
  logWarmupLine([
    'start',
    `tenants=${tenants.join(',')}`,
    `jobs=${jobs.length}`,
    'concurrency=1',
  ]);

  let done = 0;
  for (const job of jobs) {
    if (isDashboardRequestBusy({ minRequests: 3, windowMs: 4000 })) {
      logWarmupLine(['skipped', 'reason=busy', `remaining=${jobs.length - done}`]);
      return;
    }
    const t0 = Date.now();
    try {
      await runWarmupJob(job);
      done += 1;
      logWarmupLine([
        `endpoint=${job.endpoint}`,
        `tenant=${job.tenantId}`,
        `orderFilter=${job.orderFilter}`,
        `durationMs=${Date.now() - t0}`,
        'success',
      ]);
    } catch (e) {
      done += 1;
      const errMsg = String(e?.message || e).slice(0, 200);
      logWarmupLine([
        `endpoint=${job.endpoint}`,
        `tenant=${job.tenantId}`,
        `orderFilter=${job.orderFilter}`,
        `durationMs=${Date.now() - t0}`,
        'fail',
        `error=${errMsg}`,
      ]);
      console.error('[dashboard-cache-warmup] job error', job, e);
    }
  }

  logWarmupLine(['done', `jobs=${done}/${jobs.length}`]);
}

/**
 * 在 HTTP server 进入 listening 后调用（可重复调用，仅首次生效）。
 */
function scheduleDashboardCacheWarmup() {
  const snap = readWarmupEnvSnapshot();

  logWarmupLine([
    'env',
    `enabled=${snap.enabledRaw ?? ''}`,
    `parsed=${snap.enabled ? 1 : 0}`,
    `tenants=${snap.tenants.join(',') || '(none)'}`,
    `delayMs=${snap.delayMs}`,
    'concurrency=1',
  ]);

  if (!snap.enabled) {
    logWarmupLine(['skipped', 'reason=disabled']);
    return;
  }
  if (!snap.tenants.length) {
    logWarmupLine(['skipped', 'reason=no_tenants']);
    return;
  }

  if (scheduleInvoked) {
    logWarmupLine(['skipped', 'reason=already_scheduled']);
    return;
  }
  scheduleInvoked = true;

  logWarmupLine([
    'scheduled',
    `delayMs=${snap.delayMs}`,
    `tenants=${snap.tenants.join(',')}`,
    `orderFilters=${WARMUP_ORDER_FILTERS.join(',')}`,
    `endpoints=${WARMUP_ENDPOINTS.join(',')}`,
  ]);

  setTimeout(() => {
    runDashboardCacheWarmup().catch((e) => {
      logWarmupLine(['fail', `error=${String(e?.message || e).slice(0, 300)}`]);
      console.error('[dashboard-cache-warmup] run failed', e);
    });
  }, snap.delayMs);
}

module.exports = {
  WARMUP_ORDER_FILTERS,
  WARMUP_ENDPOINTS,
  isDashboardCacheWarmupEnabled,
  readWarmupEnvSnapshot,
  listWarmupJobs,
  scheduleDashboardCacheWarmup,
  runDashboardCacheWarmup,
};
