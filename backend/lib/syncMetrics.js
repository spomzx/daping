'use strict';

const fs = require('fs');
const path = require('path');
const dayjs = require('dayjs');

const METRICS_PATH =
  process.env.SYNC_METRICS_PATH || path.join(__dirname, '..', 'storage', 'sync-metrics.json');

const MAX_SHOP_SAMPLES = 500;
const startedAt = Date.now();

/** @type {Array<Record<string, unknown>>} */
let shopSyncSamples = [];

/** @type {{ runs: number, shopsOk: number, shopsFail: number, ordersCollected: number, lastRunAt: string|null }} */
let runTotals = {
  runs: 0,
  shopsOk: 0,
  shopsFail: 0,
  ordersCollected: 0,
  lastRunAt: null,
};

/** @type {{ token: number, permission: number, region: number, timeout: number, other: number }} */
let apiErrors = { token: 0, permission: 0, region: 0, timeout: 0, other: 0 };

let tokenExpiredShops = 0;
let shopsSyncedTotal = 0;

function hydrateFromDisk() {
  try {
    if (!fs.existsSync(METRICS_PATH)) return;
    const raw = JSON.parse(fs.readFileSync(METRICS_PATH, 'utf8'));
    if (Array.isArray(raw.shopSyncSamples)) shopSyncSamples = raw.shopSyncSamples;
    if (raw.runTotals && typeof raw.runTotals === 'object') runTotals = { ...runTotals, ...raw.runTotals };
    if (raw.apiErrors && typeof raw.apiErrors === 'object') apiErrors = { ...apiErrors, ...raw.apiErrors };
    tokenExpiredShops = Number(raw.tokenExpiredShops) || 0;
    shopsSyncedTotal = Number(raw.shopsSyncedTotal) || 0;
  } catch {
    /* ignore corrupt metrics file */
  }
}

function flushToDisk() {
  try {
    fs.mkdirSync(path.dirname(METRICS_PATH), { recursive: true });
    fs.writeFileSync(
      METRICS_PATH,
      JSON.stringify(
        {
          shopSyncSamples,
          runTotals,
          apiErrors,
          tokenExpiredShops,
          shopsSyncedTotal,
          savedAt: dayjs().format('YYYY-MM-DD HH:mm:ss'),
        },
        null,
        2,
      ),
    );
  } catch (e) {
    console.warn('[sync-metrics] flush failed:', e?.message || e);
  }
}

hydrateFromDisk();

function classifyApiError(errMsg) {
  const e = String(errMsg || '').toLowerCase();
  if (!e) return 'other';
  if (e.includes('token') || e.includes('expired') || e.includes('unauthorized') || e.includes('refresh')) {
    return 'token';
  }
  if (e.includes('permission') || e.includes('scope') || e.includes('forbidden')) return 'permission';
  if (e.includes('region')) return 'region';
  if (e.includes('timeout') || e.includes('timed out') || e.includes('etimedout')) return 'timeout';
  return 'other';
}

/**
 * 单店铺 OpenAPI 采集结果
 * @param {{ shopId: string, shopName?: string, durationMs: number, orderCount: number, ok: boolean, error?: string, tokenExpired?: boolean }} sample
 */
function recordShopSync(sample) {
  const entry = {
    at: dayjs().format('YYYY-MM-DD HH:mm:ss'),
    shopId: String(sample.shopId || ''),
    shopName: String(sample.shopName || ''),
    durationMs: Math.max(0, Number(sample.durationMs) || 0),
    orderCount: Math.max(0, Number(sample.orderCount) || 0),
    ok: Boolean(sample.ok),
    error: sample.error ? String(sample.error).slice(0, 240) : null,
  };
  shopSyncSamples.push(entry);
  if (shopSyncSamples.length > MAX_SHOP_SAMPLES) {
    shopSyncSamples = shopSyncSamples.slice(-MAX_SHOP_SAMPLES);
  }
  if (shopSyncSamples.length % 10 === 0) flushToDisk();

  shopsSyncedTotal += 1;
  if (sample.ok) runTotals.shopsOk += 1;
  else {
    runTotals.shopsFail += 1;
    const kind = classifyApiError(sample.error);
    apiErrors[kind] = (apiErrors[kind] || 0) + 1;
  }
  if (sample.tokenExpired) tokenExpiredShops += 1;
}

/**
 * 每轮 collectOnce 结束
 * @param {{ ordersTotal: number, shopsFailed: number, shopsOk: number }} summary
 */
function recordSyncRun(summary) {
  runTotals.runs += 1;
  runTotals.ordersCollected += Number(summary.ordersTotal) || 0;
  runTotals.lastRunAt = dayjs().format('YYYY-MM-DD HH:mm:ss');
  flushToDisk();
}

function getMetricsSnapshot() {
  hydrateFromDisk();
  const recent = shopSyncSamples.slice(-120);
  const okSamples = recent.filter((s) => s.ok);
  const failSamples = recent.filter((s) => !s.ok);
  const avgDurationMs =
    okSamples.length > 0
      ? Math.round(okSamples.reduce((a, s) => a + Number(s.durationMs || 0), 0) / okSamples.length)
      : 0;
  const totalRecent = recent.length || 1;
  const apiErrorRate = Number(((failSamples.length / totalRecent) * 100).toFixed(2));
  const tokenExpireRate =
    shopsSyncedTotal > 0
      ? Number(((tokenExpiredShops / shopsSyncedTotal) * 100).toFixed(2))
      : 0;

  return {
    service: 'gmv-dashboard-api',
    uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
    sync: {
      ...runTotals,
      avgShopDurationMs: avgDurationMs,
      apiErrorRatePercent: apiErrorRate,
      tokenExpireRatePercent: tokenExpireRate,
      apiErrorsByType: { ...apiErrors },
    },
    recentShopSyncs: recent,
    perShopLast: buildPerShopLastMap(recent),
  };
}

function buildPerShopLastMap(samples) {
  const map = {};
  for (let i = samples.length - 1; i >= 0; i -= 1) {
    const s = samples[i];
    const id = String(s.shopId || '');
    if (!id || map[id]) continue;
    map[id] = s;
  }
  return map;
}

function resetMetricsForTests() {
  shopSyncSamples = [];
  runTotals = { runs: 0, shopsOk: 0, shopsFail: 0, ordersCollected: 0, lastRunAt: null };
  apiErrors = { token: 0, permission: 0, region: 0, timeout: 0, other: 0 };
  tokenExpiredShops = 0;
  shopsSyncedTotal = 0;
}

module.exports = {
  recordShopSync,
  recordSyncRun,
  getMetricsSnapshot,
  resetMetricsForTests,
};
