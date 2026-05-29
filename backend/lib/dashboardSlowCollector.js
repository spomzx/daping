'use strict';

/**
 * 进程内 dashboard 请求耗时聚合（可观测性，不改业务结果）。
 * @type {Map<string, {
 *   count: number,
 *   totalMs: number,
 *   maxMs: number,
 *   cacheHits: number,
 *   cacheMisses: number,
 *   lastAt: number,
 * }>}
 */
const buckets = new Map();

/** @type {number[]} */
const recentActivityTs = [];

function pruneActivity(windowMs) {
  const cutoff = Date.now() - windowMs;
  while (recentActivityTs.length && recentActivityTs[0] < cutoff) {
    recentActivityTs.shift();
  }
}

/**
 * 近期 dashboard 请求是否繁忙（warmup 让路）。
 * @param {{ minRequests?: number, windowMs?: number }} [opts]
 */
function isDashboardRequestBusy(opts = {}) {
  const minRequests = Number.isFinite(Number(opts.minRequests)) ? Number(opts.minRequests) : 4;
  const windowMs = Number.isFinite(Number(opts.windowMs)) ? Number(opts.windowMs) : 5000;
  pruneActivity(windowMs);
  return recentActivityTs.length >= minRequests;
}

function noteDashboardRequestActivity() {
  recentActivityTs.push(Date.now());
  if (recentActivityTs.length > 200) pruneActivity(60000);
}

function bucketKey(endpoint, sqlTag) {
  return `${String(endpoint || 'unknown')}|${String(sqlTag || 'main')}`;
}

/**
 * @param {{
 *   endpoint: string,
 *   sqlTag?: string,
 *   durationMs: number,
 *   cacheHit?: boolean,
 *   tenant?: number|null,
 *   market?: string,
 *   orderFilter?: string,
 *   timeRange?: string,
 *   shopId?: string,
 *   rows?: number,
 *   points?: number,
 * }} meta
 */
function recordDashboardRequest(meta) {
  const key = bucketKey(meta.endpoint, meta.sqlTag);
  const prev = buckets.get(key) || {
    count: 0,
    totalMs: 0,
    maxMs: 0,
    cacheHits: 0,
    cacheMisses: 0,
    lastAt: 0,
  };
  const ms = Math.max(0, Math.floor(Number(meta.durationMs) || 0));
  prev.count += 1;
  prev.totalMs += ms;
  if (ms > prev.maxMs) prev.maxMs = ms;
  if (meta.cacheHit === true) prev.cacheHits += 1;
  else if (meta.cacheHit === false) prev.cacheMisses += 1;
  prev.lastAt = Date.now();
  buckets.set(key, prev);
  noteDashboardRequestActivity();

  if (process.env.DASHBOARD_SLOW_AGGREGATE_LOG === '1' && prev.count % 20 === 0) {
    logDashboardAggregateSnapshot();
  }
}

function logDashboardAggregateSnapshot() {
  const lines = [];
  for (const [key, st] of [...buckets.entries()].sort((a, b) => b[1].totalMs - a[1].totalMs)) {
    const avg = st.count > 0 ? Math.round(st.totalMs / st.count) : 0;
    lines.push(
      `${key} count=${st.count} avgMs=${avg} maxMs=${st.maxMs} cacheHit=${st.cacheHits} cacheMiss=${st.cacheMisses}`,
    );
  }
  if (!lines.length) return;
  console.warn(`[dashboard-contract] aggregate\n  ${lines.join('\n  ')}`);
}

function getDashboardAggregateStats() {
  const out = {};
  for (const [key, st] of buckets.entries()) {
    out[key] = {
      ...st,
      avgMs: st.count > 0 ? Math.round(st.totalMs / st.count) : 0,
    };
  }
  return out;
}

function resetDashboardAggregateStats() {
  buckets.clear();
}

module.exports = {
  recordDashboardRequest,
  logDashboardAggregateSnapshot,
  getDashboardAggregateStats,
  resetDashboardAggregateStats,
  isDashboardRequestBusy,
  noteDashboardRequestActivity,
};
