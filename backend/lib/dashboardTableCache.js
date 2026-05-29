'use strict';

/**
 * Dashboard MySQL 汇总表缓存层（Phase-1 基础架构）
 * 读路径：memory miss → table hit → MySQL loader fallback
 * 写路径：loader 成功后 upsert table + memory
 */

const { getMysqlPool } = require('../db/mysqlPool');
const { isTrendCacheEndpoint, trendCacheTtlMs } = require('./dashboardTrendTtl');
const { precomputeTtlMs } = require('./dashboardPrecomputeTtl');
const { isPrecomputeSchedulerEnabled } = require('./dashboardReadonly');

/** @type {Record<string, string>} */
const ENDPOINT_TABLE = {
  summary: 'dashboard_summary_cache',
  ranking: 'dashboard_shop_ranking_cache',
  'product-ranking': 'dashboard_product_ranking_cache',
  trend: 'dashboard_trend_cache',
  'gmv-compare': 'dashboard_trend_cache',
  'order-volume': 'dashboard_trend_cache',
};

/** 各端点 table TTL（毫秒），与 refresh scheduler 对齐 */
const TABLE_TTL_MS = {
  summary: 25_000,
  ranking: 30_000,
  'product-ranking': 60_000,
  trend: 90_000,
  'gmv-compare': 90_000,
  'order-volume': 90_000,
};

function isTableCacheEnabled() {
  const s = String(process.env.DASHBOARD_TABLE_CACHE_ENABLED ?? '1')
    .trim()
    .toLowerCase();
  return s !== '0' && s !== 'false' && s !== 'off';
}

function tableTtlMs(endpoint, contract) {
  if (isPrecomputeSchedulerEnabled()) {
    return precomputeTtlMs(endpoint, contract);
  }
  if (isTrendCacheEndpoint(endpoint)) {
    return trendCacheTtlMs(contract);
  }
  const base = TABLE_TTL_MS[endpoint] || 30_000;
  if (contract && String(contract?.timeRange || 'today').trim().toLowerCase() === 'today') {
    const todayCap = TABLE_TTL_MS[endpoint];
    if (todayCap != null) return todayCap;
  }
  return Math.max(15_000, Math.floor(base));
}

/**
 * @param {string} endpoint
 * @param {string} cacheKey
 */
function rollupCacheKey(endpoint, cacheKey) {
  const h = require('crypto').createHash('sha256').update(cacheKey).digest('hex').slice(0, 64);
  return `${endpoint}:${h}`;
}

function parseYmdOrNull(s) {
  const v = String(s || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
}

/**
 * @param {import('../modules/dashboard/filterContract').DashboardFilterContract} contract
 * @param {Record<string, string|number|boolean|undefined>} [extra]
 */
function contractDimensions(contract, extra = {}) {
  return {
    shop_id: String(contract?.shopId ?? 'all'),
    market: String(contract?.market ?? 'ALL'),
    order_filter: String(contract?.orderFilter ?? 'all'),
    time_range: String(contract?.timeRange ?? 'today'),
    start_date: parseYmdOrNull(contract?.startDate),
    end_date: parseYmdOrNull(contract?.endDate),
    extra_json: Object.keys(extra).length ? JSON.stringify(extra) : null,
  };
}

/**
 * @template T
 * @param {{
 *   endpoint: string,
 *   tenantId: number,
 *   contract: import('../modules/dashboard/filterContract').DashboardFilterContract,
 *   extra?: Record<string, string|number|boolean|undefined>,
 *   cacheKey?: string,
 * }} opts
 * @returns {Promise<{ hit: boolean, val?: T, ttlMs?: number }>}
 */
/**
 * @param {Parameters<typeof readDashboardTableCache>[0]} opts
 * @param {{ allowStale?: boolean, maxStaleSec?: number }} [readOpts]
 */
async function readDashboardTableCache(opts, readOpts = {}) {
  if (!isTableCacheEnabled()) return { hit: false, stale: false };
  const pool = getMysqlPool();
  if (!pool) return { hit: false, stale: false };

  const { endpoint, tenantId, contract, extra = {} } = opts;
  const table = ENDPOINT_TABLE[endpoint];
  if (!table) return { hit: false, stale: false };

  const memKey = opts.cacheKey;
  if (!memKey) return { hit: false, stale: false };
  const key = rollupCacheKey(endpoint, memKey);
  const maxStaleSec = Math.max(60, Math.floor(Number(readOpts.maxStaleSec) || 3600));

  try {
    const [rows] = await pool.query(
      `SELECT payload_json, expires_at, refreshed_at FROM \`${table}\`
       WHERE tenant_id = ? AND cache_key = ? AND expires_at > NOW(3) LIMIT 1`,
      [tenantId, key],
    );
    let row = Array.isArray(rows) && rows[0] ? rows[0] : null;
    let stale = false;

    if (!row && readOpts.allowStale) {
      const [staleRows] = await pool.query(
        `SELECT payload_json, expires_at, refreshed_at FROM \`${table}\`
         WHERE tenant_id = ? AND cache_key = ?
           AND refreshed_at > DATE_SUB(NOW(3), INTERVAL ? SECOND)
         LIMIT 1`,
        [tenantId, key, maxStaleSec],
      );
      row = Array.isArray(staleRows) && staleRows[0] ? staleRows[0] : null;
      stale = Boolean(row);
    }

    if (!row) return { hit: false, stale: false };
    const val = JSON.parse(String(row.payload_json || 'null'));
    const expMs = row.expires_at instanceof Date ? row.expires_at.getTime() : Date.parse(String(row.expires_at));
    const ttlMs = Number.isFinite(expMs) ? Math.max(0, expMs - Date.now()) : tableTtlMs(endpoint, contract);
    return { hit: true, val, ttlMs, stale };
  } catch (e) {
    console.warn('[dashboard-table-cache] read fail', endpoint, e?.message || e);
    return { hit: false, stale: false };
  }
}

/**
 * 精确 cache_key 未命中时，按契约维度取最近一条 trend 表缓存（避免 pending rows=0 闪白）
 * @param {Parameters<typeof readDashboardTableCache>[0]} opts
 * @param {{ maxStaleSec?: number }} [readOpts]
 */
async function readTrendTableStaleByDimensions(opts, readOpts = {}) {
  if (!isTableCacheEnabled()) return { hit: false, stale: false };
  if (!isTrendCacheEndpoint(opts.endpoint)) return { hit: false, stale: false };
  const pool = getMysqlPool();
  if (!pool) return { hit: false, stale: false };

  const table = ENDPOINT_TABLE[opts.endpoint];
  if (table !== 'dashboard_trend_cache') return { hit: false, stale: false };

  const { endpoint, tenantId, contract, extra = {} } = opts;
  const dims = contractDimensions(contract, extra);
  const maxStaleSec = Math.max(600, Math.floor(Number(readOpts.maxStaleSec) || 3600));

  try {
    const [staleRows] = await pool.query(
      `SELECT payload_json, expires_at, refreshed_at FROM \`${table}\`
       WHERE tenant_id = ? AND endpoint = ?
         AND shop_id = ? AND market = ? AND order_filter = ? AND time_range = ?
         AND refreshed_at > DATE_SUB(NOW(3), INTERVAL ? SECOND)
       ORDER BY refreshed_at DESC LIMIT 1`,
      [
        tenantId,
        endpoint,
        dims.shop_id,
        dims.market,
        dims.order_filter,
        dims.time_range,
        maxStaleSec,
      ],
    );
    const row = Array.isArray(staleRows) && staleRows[0] ? staleRows[0] : null;
    if (!row) return { hit: false, stale: false };
    const val = JSON.parse(String(row.payload_json || 'null'));
    const expMs = row.expires_at instanceof Date ? row.expires_at.getTime() : Date.parse(String(row.expires_at));
    const ttlMs = Number.isFinite(expMs) ? Math.max(0, expMs - Date.now()) : tableTtlMs(endpoint, contract);
    return { hit: true, val, ttlMs, stale: true };
  } catch (e) {
    console.warn('[dashboard-table-cache] dimension stale read fail', endpoint, e?.message || e);
    return { hit: false, stale: false };
  }
}

/**
 * @template T
 * @param {{
 *   endpoint: string,
 *   tenantId: number,
 *   contract: import('../modules/dashboard/filterContract').DashboardFilterContract,
 *   extra?: Record<string, string|number|boolean|undefined>,
 *   cacheKey?: string,
 *   val: T,
 *   refreshSource?: string,
 * }} opts
 */
async function writeDashboardTableCache(opts) {
  if (!isTableCacheEnabled()) return;
  const pool = getMysqlPool();
  if (!pool) return;

  const { endpoint, tenantId, contract, extra = {}, val } = opts;
  const table = ENDPOINT_TABLE[endpoint];
  if (!table) return;

  const memKey = opts.cacheKey;
  if (!memKey) return;
  const key = rollupCacheKey(endpoint, memKey);
  const ttlMs = tableTtlMs(endpoint, contract);
  const dims = contractDimensions(contract, extra);
  const payload = JSON.stringify(val);
  const endpointCol =
    table === 'dashboard_trend_cache'
      ? `, endpoint = VALUES(endpoint)`
      : '';
  const endpointInsert =
    table === 'dashboard_trend_cache' ? ', `endpoint`' : '';
  const endpointVal = table === 'dashboard_trend_cache' ? ', ?' : '';
  const params = [
    tenantId,
    key,
    ...(table === 'dashboard_trend_cache' ? [endpoint] : []),
    dims.shop_id,
    dims.market,
    dims.order_filter,
    dims.time_range,
    dims.start_date,
    dims.end_date,
    payload,
    ttlMs / 1000,
  ];

  try {
    await pool.query(
      `INSERT INTO \`${table}\` (
        tenant_id, cache_key${endpointInsert}, shop_id, market, order_filter, time_range,
        start_date, end_date, payload_json, refreshed_at, expires_at
      ) VALUES (
        ?, ?${endpointVal}, ?, ?, ?, ?, ?, ?, ?, NOW(3), DATE_ADD(NOW(3), INTERVAL ? SECOND)
      )
      ON DUPLICATE KEY UPDATE
        payload_json = VALUES(payload_json),
        refreshed_at = NOW(3),
        expires_at = DATE_ADD(NOW(3), INTERVAL ? SECOND)
        ${endpointCol}`,
      [...params, ttlMs / 1000],
    );
  } catch (e) {
    console.warn('[dashboard-table-cache] write fail', endpoint, e?.message || e);
  }
}

/** 删除过期行（scheduler 周期调用） */
async function purgeExpiredDashboardTableCache() {
  if (!isTableCacheEnabled()) return;
  const pool = getMysqlPool();
  if (!pool) return;
  for (const table of new Set(Object.values(ENDPOINT_TABLE))) {
    try {
      await pool.query(`DELETE FROM \`${table}\` WHERE expires_at < DATE_SUB(NOW(3), INTERVAL 1 HOUR) LIMIT 500`);
    } catch {
      /* ignore */
    }
  }
}

module.exports = {
  ENDPOINT_TABLE,
  TABLE_TTL_MS,
  isTableCacheEnabled,
  tableTtlMs,
  rollupCacheKey,
  readDashboardTableCache,
  readTrendTableStaleByDimensions,
  writeDashboardTableCache,
  purgeExpiredDashboardTableCache,
};
