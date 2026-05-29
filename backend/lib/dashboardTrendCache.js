'use strict';

/**
 * 趋势端点缓存契约：cache / snapshot 键与 SQL 一致（orderFilter 经 normalizeOrderFilter，paid→valid）。
 */

const fs = require('fs');
const path = require('path');
const { getMysqlPool } = require('../db/mysqlPool');
const {
  contractForDashboardCache,
  LOCKED_KPI_ORDER_FILTER,
} = require('../modules/dashboard/filterContract');
const { isTrendCacheEndpoint } = require('./dashboardTrendTtl');
const {
  SNAPSHOT_ROOT,
  buildSnapshotFileBase,
  buildDashboardSnapshotPath,
} = require('./dashboardSnapshotCache');

const TREND_KPI_ENDPOINTS = new Set(['trend', 'gmv-compare', 'order-volume']);

/** dashboard-snapshot 中禁止保留的 paid 文件名前缀 */
const LEGACY_PAID_SNAPSHOT_PREFIXES = [
  'gmv-compare_',
  'order-volume_',
  'trend_',
  'product-ranking_',
];

/**
 * @param {string} fileName
 */
function isLegacyPaidSnapshotFilename(fileName) {
  const name = String(fileName || '');
  if (!name.endsWith('.json')) return false;
  if (!/_paid_/i.test(name)) return false;
  return LEGACY_PAID_SNAPSHOT_PREFIXES.some((p) => name.startsWith(p));
}

/**
 * @param {import('../modules/dashboard/filterContract').DashboardFilterContract} contract
 */
function contractForTrendKpiCache(contract) {
  return contractForDashboardCache(contract);
}

/**
 * @param {string} endpoint
 * @param {number|null|undefined} tenantId
 * @param {import('../modules/dashboard/filterContract').DashboardFilterContract} contract
 * @param {Record<string, string|number|boolean|undefined>} [extra]
 */
function buildTrendDashboardCacheKey(endpoint, tenantId, contract, extra = {}) {
  const { buildDashboardCacheKey } = require('./dashboardCache');
  const locked = contractForTrendKpiCache(contract);
  return buildDashboardCacheKey(endpoint, tenantId, locked, extra);
}

/**
 * @param {{
 *   endpoint: string,
 *   tenantId: number,
 *   contract: import('../modules/dashboard/filterContract').DashboardFilterContract,
 *   extra?: Record<string, string|number|boolean|undefined>,
 *   cacheKey?: string,
 * }} query
 */
function buildTrendSnapshotFileBase(query) {
  const locked = contractForTrendKpiCache(query.contract);
  return buildSnapshotFileBase({
    ...query,
    contract: locked,
    cacheKey: query.cacheKey || buildTrendDashboardCacheKey(query.endpoint, query.tenantId, query.contract, query.extra),
  });
}

/**
 * @param {{
 *   endpoint: string,
 *   tenantId: number,
 *   contract: import('../modules/dashboard/filterContract').DashboardFilterContract,
 *   extra?: Record<string, string|number|boolean|undefined>,
 *   cacheKey?: string,
 * }} query
 */
function resolveTrendSnapshotPaths(query) {
  const locked = contractForTrendKpiCache(query.contract);
  const cacheKey = query.cacheKey || buildTrendDashboardCacheKey(query.endpoint, query.tenantId, locked, query.extra);
  const paths = buildDashboardSnapshotPath({
    endpoint: query.endpoint,
    tenantId: query.tenantId,
    contract: locked,
    extra: query.extra,
    cacheKey,
  });
  return {
    cacheKey,
    snapshotKey: paths.fileName.replace(/\.json$/, ''),
    filePath: paths.filePath,
    orderFilter: LOCKED_KPI_ORDER_FILTER,
  };
}

/**
 * 删除 KPI snapshot 中 orderFilter=paid 的历史文件（仅 paid 前缀 JSON，不删 valid）。
 * @returns {Promise<{ legacy_paid_snapshot_found: boolean, removed_files: string[], table_rows_deleted: number }>}
 */
async function invalidateLegacyTrendSnapshots() {
  const removed = [];
  let legacyFound = false;

  async function walk(dir) {
    let entries;
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch (e) {
      if (e && e.code === 'ENOENT') return;
      throw e;
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!isLegacyPaidSnapshotFilename(ent.name)) continue;
      legacyFound = true;
      try {
        await fs.promises.unlink(full);
        removed.push(full);
      } catch (e) {
        console.warn('[dashboard-trend-cache] unlink legacy snapshot fail', full, e?.message || e);
      }
    }
  }

  try {
    await fs.promises.mkdir(SNAPSHOT_ROOT, { recursive: true });
    await walk(SNAPSHOT_ROOT);
  } catch (e) {
    console.warn('[dashboard-trend-cache] snapshot walk fail', e?.message || e);
  }

  let tableRowsDeleted = 0;
  const pool = getMysqlPool();
  if (pool) {
    try {
      const [r] = await pool.query(
        `DELETE FROM dashboard_trend_cache WHERE order_filter = 'paid' OR cache_key LIKE '%:paid:%'`,
      );
      tableRowsDeleted = Number(r?.affectedRows) || 0;
      if (tableRowsDeleted > 0) legacyFound = true;
      await pool.query(
        `DELETE FROM dashboard_product_ranking_cache WHERE order_filter = 'paid' OR cache_key LIKE '%:paid:%'`,
      ).catch(() => {});
    } catch (e) {
      console.warn('[dashboard-trend-cache] table purge paid fail', e?.message || e);
    }
  }

  if (removed.length || tableRowsDeleted) {
    console.log(
      `[dashboard-trend-cache] invalidateLegacyTrendSnapshots removedFiles=${removed.length} tableRows=${tableRowsDeleted}`,
    );
  }

  return {
    legacy_paid_snapshot_found: legacyFound,
    removed_files: removed,
    table_rows_deleted: tableRowsDeleted,
  };
}

/**
 * @param {Map<string, unknown>} memCache
 */
function purgeMemCacheLegacyPaidTrend(memCache) {
  if (!memCache || typeof memCache.forEach !== 'function') return 0;
  let n = 0;
  for (const key of [...memCache.keys()]) {
    const k = String(key);
    if (!k.startsWith('dashboard:')) continue;
    if (!/:paid:/.test(k)) continue;
    const ep = k.split(':')[1] || '';
    if (
      !TREND_KPI_ENDPOINTS.has(ep) &&
      ep !== 'product-ranking' &&
      ep !== 'summary' &&
      ep !== 'ranking'
    ) {
      continue;
    }
    memCache.delete(key);
    n += 1;
  }
  return n;
}

/**
 * 只读扫描：是否仍存在 paid snapshot（purge 后应为 false）。
 */
async function scanLegacyPaidTrendSnapshots() {
  let legacyFound = false;
  async function walk(dir) {
    let entries;
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch (e) {
      if (e && e.code === 'ENOENT') return;
      throw e;
    }
    for (const ent of entries) {
      if (ent.isDirectory()) {
        await walk(path.join(dir, ent.name));
        if (legacyFound) return;
        continue;
      }
      if (isLegacyPaidSnapshotFilename(ent.name)) {
        legacyFound = true;
        return;
      }
    }
  }
  try {
    await walk(SNAPSHOT_ROOT);
  } catch {
    /* ignore */
  }
  const pool = getMysqlPool();
  if (pool && !legacyFound) {
    try {
      const [rows] = await pool.query(
        `SELECT 1 FROM dashboard_trend_cache WHERE order_filter = 'paid' OR cache_key LIKE '%:paid:%' LIMIT 1`,
      );
      if (Array.isArray(rows) && rows.length > 0) legacyFound = true;
    } catch {
      /* ignore */
    }
  }
  return { legacy_paid_snapshot_found: legacyFound };
}

/**
 * 启动时清理 paid 趋势缓存（snapshot 文件 + table + memory）。
 */
async function bootPurgeLegacyTrendPaidCache() {
  const snap = await invalidateLegacyTrendSnapshots();
  let memPurged = 0;
  try {
    const { memCache, purgeMemCacheLegacyPaidTrend: purgeMem } = require('./dashboardCache');
    memPurged = purgeMem(memCache);
  } catch (e) {
    console.warn('[dashboard-trend-cache] mem purge fail', e?.message || e);
  }
  const after = await scanLegacyPaidTrendSnapshots();
  return {
    ...snap,
    mem_keys_purged: memPurged,
    legacy_paid_remaining_after_purge: after.legacy_paid_snapshot_found,
  };
}

module.exports = {
  LOCKED_TREND_ORDER_FILTER: LOCKED_KPI_ORDER_FILTER,
  TREND_KPI_ENDPOINTS,
  LEGACY_PAID_SNAPSHOT_PREFIXES,
  isLegacyPaidSnapshotFilename,
  contractForTrendKpiCache,
  buildTrendDashboardCacheKey,
  buildTrendSnapshotFileBase,
  resolveTrendSnapshotPaths,
  invalidateLegacyTrendSnapshots,
  scanLegacyPaidTrendSnapshots,
  purgeMemCacheLegacyPaidTrend,
  bootPurgeLegacyTrendPaidCache,
  isTrendKpiEndpoint: isTrendCacheEndpoint,
};
