'use strict';

/**
 * Dashboard 后台错峰刷新调度器（Phase-1）
 * 默认关闭：DASHBOARD_REFRESH_SCHEDULER_ENABLED=1 且 DASHBOARD_REFRESH_SCHEDULER_TENANTS=6,...
 *
 * 错峰时间表（相对每轮 cycle 起点）：
 *   0s  → summary
 *  20s  → ranking (shop)
 *  40s  → trend (gmv-compare + order-volume)
 *  60s  → product-ranking
 */

const { isDashboardRequestBusy } = require('./dashboardSlowCollector');
const { purgeExpiredDashboardTableCache } = require('./dashboardTableCache');
const { cleanupDashboardSnapshotCache, isSnapshotCleanupEnabled } = require('./dashboardSnapshotCache');

const SCHEDULE = [
  { phaseMs: 0, endpoint: 'summary', orderFilters: ['paid', 'all', 'valid'] },
  { phaseMs: 20_000, endpoint: 'ranking', orderFilters: ['paid', 'all', 'valid'] },
  { phaseMs: 40_000, endpoint: 'trend', orderFilters: ['valid'] },
  { phaseMs: 40_000, endpoint: 'gmv-compare', orderFilters: ['valid'] },
  { phaseMs: 40_000, endpoint: 'order-volume', orderFilters: ['valid'] },
  { phaseMs: 60_000, endpoint: 'product-ranking', orderFilters: ['valid'] },
];

const CYCLE_MS = 120_000;

let schedulerStarted = false;
/** @type {ReturnType<typeof setTimeout> | null} */
let cycleTimer = null;

function isTruthyEnvFlag(value) {
  const s = String(value ?? '')
    .trim()
    .toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}

function parseSchedulerTenants() {
  const raw = String(process.env.DASHBOARD_REFRESH_SCHEDULER_TENANTS || '').trim();
  if (!raw) return [];
  const out = [];
  for (const part of raw.split(',')) {
    const n = Number(String(part).trim());
    if (Number.isFinite(n) && n > 0) out.push(Math.floor(n));
  }
  return [...new Set(out)];
}

function isDashboardRefreshSchedulerEnabled() {
  try {
    const { isPrecomputeSchedulerEnabled } = require('./dashboardReadonly');
    if (isPrecomputeSchedulerEnabled()) return false;
  } catch {
    /* ignore */
  }
  return isTruthyEnvFlag(process.env.DASHBOARD_REFRESH_SCHEDULER_ENABLED) && parseSchedulerTenants().length > 0;
}

function logScheduler(parts) {
  console.log(`[dashboard-refresh-scheduler] ${parts.join(' ')}`);
}

function buildSchedulerQuery(tenantId, orderFilter) {
  return {
    shopId: 'all',
    shop_id: 'all',
    market: 'ALL',
    region: 'all',
    timeRange: 'today',
    range: 'today',
    orderFilter,
    tenantId,
    scheduler: '1',
    refreshSource: 'scheduler',
  };
}

/**
 * @param {{ tenantId: number, orderFilter: string, endpoint: string }} job
 */
async function runSchedulerJob(job) {
  const q = buildSchedulerQuery(job.tenantId, job.orderFilter);
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
    case 'product-ranking': {
      const { getProductRanking } = require('../services/orderMetricsService');
      await getProductRanking(job.tenantId, { ...q, limit: 20 });
      return;
    }
    case 'trend': {
      const { getOrderTrend } = require('../services/orderMetricsService');
      await getOrderTrend(job.tenantId, q, null, 'trend');
      return;
    }
    case 'gmv-compare': {
      const { getGmvCompare } = require('../services/orderMetricsService');
      await getGmvCompare(job.tenantId, q);
      return;
    }
    case 'order-volume': {
      const { getOrderTrend } = require('../services/orderMetricsService');
      await getOrderTrend(job.tenantId, q, null, 'order-volume');
      return;
    }
    default:
      throw new Error(`unknown_scheduler_endpoint:${job.endpoint}`);
  }
}

function listSchedulerJobsForPhase(phaseMs) {
  const tenants = parseSchedulerTenants();
  const slot = SCHEDULE.filter((s) => s.phaseMs === phaseMs);
  const jobs = [];
  for (const tenantId of tenants) {
    for (const spec of slot) {
      for (const orderFilter of spec.orderFilters) {
        jobs.push({ tenantId, orderFilter, endpoint: spec.endpoint, phaseMs });
      }
    }
  }
  return jobs;
}

async function runSchedulerPhase(phaseMs) {
  if (isDashboardRequestBusy({ minRequests: 5, windowMs: 3000 })) {
    logScheduler(['phase-skipped', `phaseMs=${phaseMs}`, 'reason=busy']);
    return;
  }
  const jobs = listSchedulerJobsForPhase(phaseMs);
  logScheduler(['phase-start', `phaseMs=${phaseMs}`, `jobs=${jobs.length}`]);
  for (const job of jobs) {
    if (isDashboardRequestBusy({ minRequests: 4, windowMs: 2000 })) {
      logScheduler(['phase-abort', `phaseMs=${phaseMs}`, 'reason=busy']);
      return;
    }
    const t0 = Date.now();
    try {
      await runSchedulerJob(job);
      logScheduler([
        `endpoint=${job.endpoint}`,
        `tenant=${job.tenantId}`,
        `orderFilter=${job.orderFilter}`,
        `phaseMs=${phaseMs}`,
        `durationMs=${Date.now() - t0}`,
        'ok',
      ]);
    } catch (e) {
      logScheduler([
        `endpoint=${job.endpoint}`,
        `tenant=${job.tenantId}`,
        `orderFilter=${job.orderFilter}`,
        `phaseMs=${phaseMs}`,
        `durationMs=${Date.now() - t0}`,
        'fail',
        `error=${String(e?.message || e).slice(0, 160)}`,
      ]);
    }
  }
}

function scheduleCyclePhases() {
  const phases = [...new Set(SCHEDULE.map((s) => s.phaseMs))].sort((a, b) => a - b);
  for (const phaseMs of phases) {
    setTimeout(() => {
      runSchedulerPhase(phaseMs).catch((e) => {
        logScheduler(['phase-error', `phaseMs=${phaseMs}`, `error=${String(e?.message || e).slice(0, 200)}`]);
      });
    }, phaseMs);
  }
  cycleTimer = setTimeout(() => {
    void purgeExpiredDashboardTableCache();
    if (isSnapshotCleanupEnabled()) void cleanupDashboardSnapshotCache();
    scheduleCyclePhases();
  }, CYCLE_MS);
}

function startDashboardRefreshScheduler() {
  if (schedulerStarted) return;
  if (!isDashboardRefreshSchedulerEnabled()) {
    logScheduler(['skipped', 'reason=disabled']);
    return;
  }
  schedulerStarted = true;
  const tenants = parseSchedulerTenants();
  logScheduler([
    'started',
    `tenants=${tenants.join(',')}`,
    `cycleMs=${CYCLE_MS}`,
    `phases=${[...new Set(SCHEDULE.map((s) => s.phaseMs))].join(',')}`,
  ]);
  scheduleCyclePhases();
}

function stopDashboardRefreshScheduler() {
  if (cycleTimer) clearTimeout(cycleTimer);
  cycleTimer = null;
  schedulerStarted = false;
}

module.exports = {
  SCHEDULE,
  CYCLE_MS,
  isDashboardRefreshSchedulerEnabled,
  parseSchedulerTenants,
  startDashboardRefreshScheduler,
  stopDashboardRefreshScheduler,
  runSchedulerPhase,
};
