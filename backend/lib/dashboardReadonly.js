'use strict';

const { isProdDeploy } = require('./dashboardSnapshotCache');

/** @type {Map<string, number>} cacheKey → hintedAt */
const precomputeHints = new Map();

const HINT_TTL_MS = 15 * 60 * 1000;

function isTruthyEnvFlag(value) {
  const s = String(value ?? '')
    .trim()
    .toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}

/** 页面 API 只读缓存（禁止请求链路 MySQL 聚合） */
function isDashboardApiReadonly() {
  const explicit = process.env.DASHBOARD_READONLY_CACHE;
  if (explicit != null && String(explicit).trim() !== '') {
    return isTruthyEnvFlag(explicit) && !isProdDeploy();
  }
  return isPrecomputeSchedulerEnabled();
}

function isPrecomputeSchedulerEnabled() {
  const raw = process.env.DASHBOARD_PRECOMPUTE_ENABLED;
  if (raw == null || String(raw).trim() === '') return false;
  return isTruthyEnvFlag(raw) && !isProdDeploy() && parsePrecomputeTenants().length > 0;
}

function parsePrecomputeTenants() {
  const raw =
    process.env.DASHBOARD_PRECOMPUTE_TENANTS ||
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

function isPrecomputePipelineRequest(q) {
  if (!q || typeof q !== 'object') return false;
  if (q.precompute === '1' || q.precompute === true) return true;
  if (q.warmup === '1' || q.warmup === true) return true;
  if (q.scheduler === '1' || q.scheduler === true) return true;
  return false;
}

/**
 * @param {{
 *   cacheKey: string,
 *   endpoint: string,
 *   tenantId: number,
 *   contract: import('../modules/dashboard/filterContract').DashboardFilterContract,
 * }} opts
 */
function hintDashboardPrecompute(opts) {
  if (!opts?.cacheKey) return;
  precomputeHints.set(String(opts.cacheKey), Date.now());
}

function consumePrecomputeHints(max = 32) {
  const now = Date.now();
  const keys = [];
  for (const [k, t] of precomputeHints) {
    if (now - t > HINT_TTL_MS) {
      precomputeHints.delete(k);
      continue;
    }
    keys.push(k);
  }
  keys.sort((a, b) => (precomputeHints.get(b) || 0) - (precomputeHints.get(a) || 0));
  return keys.slice(0, max);
}

/**
 * @param {string} endpoint
 * @param {'cache-hit'|'stale-hit'|'cache-miss'} event
 * @param {Record<string, unknown>} [extra]
 */
function logDashboardReadonly(endpoint, event, extra = {}) {
  if (typeof event === 'object' && event !== null && !extra.source) {
    extra = /** @type {Record<string, unknown>} */ (event);
    event = extra.stale || extra['stale-hit'] ? 'stale-hit' : extra['no-request-loader'] ? 'cache-miss' : 'cache-hit';
  }
  const parts = [event, `endpoint=${endpoint}`];
  for (const [k, v] of Object.entries(extra)) {
    if (v != null && String(v) !== '' && k !== 'stale-hit') parts.push(`${k}=${v}`);
  }
  console.log(`[dashboard-readonly] ${parts.join(' ')}`);
}

module.exports = {
  isDashboardApiReadonly,
  isPrecomputeSchedulerEnabled,
  isPrecomputePipelineRequest,
  parsePrecomputeTenants,
  hintDashboardPrecompute,
  consumePrecomputeHints,
  logDashboardReadonly,
};
