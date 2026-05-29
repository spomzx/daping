#!/usr/bin/env node
'use strict';

/**
 * 趋势 KPI �?today/ranking 一致性诊断（optional-safe，禁�?throw 中断�? *
 *   node scripts/diagnose-trend-kpi-contract.js --tenant-id=6 --date=2026-05-25
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const { getMysqlPool } = require('../../db/mysqlPool');
const { parseDashboardFilterQuery, buildLockedKpiDashboardWhere } = require('../../modules/dashboard/filterContract');
const { LOCKED_KPI_ORDER_FILTER } = require('../../lib/orderFilter');
const {
  buildTrendDashboardCacheKey,
  resolveTrendSnapshotPaths,
  invalidateLegacyTrendSnapshots,
  scanLegacyPaidTrendSnapshots,
} = require('../../lib/dashboardTrendCache');
const { KPI_GMV_ROUNDING_CONTRACT, roundKpiGmvUsd } = require('../../modules/dashboard/gmvUsdConvert');
const {
  queryTodayMetricsTenantTotal,
  queryTodayMetricsRankingRows,
} = require('../../modules/dashboard/todayMetricsQuery');
const { queryDashboardTrend } = require('../../modules/dashboard/trendQuery');
const { parseYmd } = require('../../lib/dashboardTimeRange');

/** @param {unknown} value */
function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

/** @param {unknown} value */
function safeNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** @param {unknown} value */
function safeObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value)
    : {};
}

function parseArgs(argv) {
  let tenantId = null;
  let dateYmd = null;
  for (const a of safeArray(argv)) {
    const s = String(a);
    if (s.startsWith('--tenant-id=')) tenantId = Number(s.split('=')[1]);
    if (s.startsWith('--date=')) dateYmd = String(s.split('=')[1] || '').trim();
  }
  return { tenantId, dateYmd };
}

function nearEqual(a, b, eps = 0.01) {
  return Math.abs(safeNumber(a) - safeNumber(b)) <= eps;
}

/**
 * @param {unknown} payload �?trend 响应�?rows 数组
 */
function extractTrendRows(payload) {
  if (Array.isArray(payload)) return payload;
  const o = safeObject(payload);
  if (Array.isArray(o.rows)) return o.rows;
  if (Array.isArray(o.points)) return o.points;
  if (Array.isArray(o.__trendRows)) return o.__trendRows;
  const data = safeObject(o.data);
  if (Array.isArray(data.rows)) return data.rows;
  if (Array.isArray(data.points)) return data.points;
  return [];
}

/**
 * 诊断口径：仅 kpi_totals.gmv_usd（ROUND(SUM(raw),2)）；禁止 points reduce�? * @param {unknown} payload
 */
function sumTrendKpiTotals(payload) {
  const root = safeObject(payload);
  const totals = safeObject(root.kpi_totals);
  const gmvUsd = totals.gmv_usd;
  if (gmvUsd == null || !Number.isFinite(Number(gmvUsd))) {
    return {
      orders: 0,
      gmv: 0,
      gmv_usd_raw_sum: 0,
      source: 'missing_kpi_totals',
      error: 'trend_missing_kpi_totals',
    };
  }
  return {
    orders: safeNumber(totals.orders),
    gmv: safeNumber(gmvUsd),
    gmv_usd_raw_sum: safeNumber(totals.gmv_usd_raw_sum ?? totals.gmv_raw_sum),
    source: 'kpi_totals',
    error: null,
  };
}

/**
 * @param {unknown} trendResult
 */
function readTrendDiagnostics(trendResult) {
  const rows = extractTrendRows(trendResult);
  const root = safeObject(trendResult);
  const cacheMeta = safeObject(root.cacheMeta ?? root.cache ?? root.meta);
  const cache = safeObject(root.cache);

  const pointsRaw = root.points ?? cacheMeta.points ?? cache.points ?? rows;
  const points = Array.isArray(pointsRaw) ? pointsRaw : rows;

  return {
    trend_rows_count: rows.length,
    trend_points_count: points.length,
    cache_source: String(cacheMeta.cacheSource ?? cache.cacheSource ?? root.cacheSource ?? ''),
    snapshot_source: String(cacheMeta.logSource ?? cacheMeta.snapshotSource ?? ''),
    cache_meta: cacheMeta,
  };
}

function emptyPartial() {
  return {
    tenant_id: null,
    date: null,
    dashboard_today_orders: 0,
    ranking_total_orders: 0,
    trend_total_orders: 0,
    dashboard_today_gmv: 0,
    ranking_total_gmv: 0,
    trend_total_gmv: 0,
    trend_cache_key: '',
    trend_snapshot_key: '',
    trend_order_filter: LOCKED_KPI_ORDER_FILTER,
    legacy_paid_snapshot_found: false,
    trend_rows_count: 0,
    trend_points_count: 0,
    cache_source: '',
    snapshot_source: '',
    query_duration_ms: 0,
    locked_kpi_where_sql: '(none)',
    inconsistent_modules: [],
    gmv_rounding_contract: KPI_GMV_ROUNDING_CONTRACT,
    legacy_paid_files_removed: 0,
  };
}

/**
 * @param {Record<string, unknown>} partial
 * @param {string|null} error
 * @param {boolean} ok
 */
function buildOutput(partial, error, ok) {
  const base = { ...emptyPartial(), ...partial };
  const inconsistent_modules = safeArray(base.inconsistent_modules).map(String);
  const out = {
    ...base,
    inconsistent_modules,
    ok: ok === true && inconsistent_modules.length === 0 && !error,
  };
  if (error) {
    out.error = error;
    out.partial_result = { ...base, inconsistent_modules };
  }
  return out;
}

function printJson(out) {
  try {
    console.log(JSON.stringify(out, null, 2));
  } catch (e) {
    console.log(
      JSON.stringify({
        ok: false,
        error: `json_stringify_failed:${String(e?.message || e)}`,
        partial_result: emptyPartial(),
      }),
    );
  }
}

async function runDiagnosis(tenantId, dateYmd) {
  const partial = emptyPartial();
  partial.tenant_id = tenantId;

  const pool = getMysqlPool();
  if (!pool) {
    return buildOutput(partial, 'mysql_unavailable', false);
  }

  const ymd =
    dateYmd ||
    (() => {
      const d = new Date();
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    })();
  partial.date = ymd;

  const parsed = parseYmd(ymd);
  if (!parsed) {
    return buildOutput(partial, 'invalid_date', false);
  }

  const startYmd = `${parsed.y}-${String(parsed.mo).padStart(2, '0')}-${String(parsed.d).padStart(2, '0')}`;

  const dayQuery = {
    timeRange: 'custom',
    startDate: startYmd,
    endDate: startYmd,
    shopId: 'all',
    market: 'ALL',
    orderFilter: 'paid',
    cacheBypass: '1',
    forceRefresh: '1',
  };

  const kpiContract = parseDashboardFilterQuery({ ...dayQuery, orderFilter: 'valid' }, tenantId);

  let trendCacheKey = '';
  let trendSnapshotKey = '';
  try {
    trendCacheKey = buildTrendDashboardCacheKey('order-volume', tenantId, kpiContract, { groupBy: 'hour' });
    const snapPaths = resolveTrendSnapshotPaths({
      endpoint: 'order-volume',
      tenantId,
      contract: kpiContract,
      extra: { groupBy: 'hour' },
      cacheKey: trendCacheKey,
    });
    trendSnapshotKey = String(snapPaths?.snapshotKey ?? '');
  } catch (e) {
    partial.trend_cache_key = trendCacheKey;
    return buildOutput(partial, `cache_key_error:${String(e?.message || e)}`, false);
  }

  partial.trend_cache_key = trendCacheKey;
  partial.trend_snapshot_key = trendSnapshotKey;

  let legacy_paid_snapshot_found = false;
  try {
    const purge = safeObject(await invalidateLegacyTrendSnapshots());
    partial.legacy_paid_files_removed = safeArray(purge.removed_files).length;
    const legacyScan = safeObject(await scanLegacyPaidTrendSnapshots());
    legacy_paid_snapshot_found = legacyScan.legacy_paid_snapshot_found === true;
  } catch (e) {
    partial.legacy_scan_error = String(e?.message || e);
  }
  partial.legacy_paid_snapshot_found = legacy_paid_snapshot_found;
  partial.gmv_rounding_contract = KPI_GMV_ROUNDING_CONTRACT;

  let lockedSql = '(none)';
  let usesValid = false;
  try {
    const lockedWhere = safeObject(await buildLockedKpiDashboardWhere(pool, tenantId, kpiContract, {}));
    lockedSql = String(lockedWhere.orderFilterWhereSql ?? '(none)');
    usesValid =
      /analytics_status\s*=\s*['"]valid['"]/i.test(lockedSql) ||
      String(lockedWhere.orderFilter ?? '') === LOCKED_KPI_ORDER_FILTER;
    partial.locked_kpi_where_sql = lockedSql;
  } catch (e) {
    return buildOutput(partial, `locked_where_error:${String(e?.message || e)}`, false);
  }

  const t0 = Date.now();
  let dashboardTotal = safeObject(null);
  let rankingRows = [];
  let trendResult = safeObject(null);

  try {
    const results = await Promise.all([
      queryTodayMetricsTenantTotal(pool, tenantId, kpiContract, {}).catch((e) => ({
        _error: String(e?.message || e),
        orders: 0,
        gmv: 0,
      })),
      queryTodayMetricsRankingRows(pool, tenantId, kpiContract, {}).catch((e) => ({
        _error: String(e?.message || e),
        _rows: [],
      })),
      queryDashboardTrend(tenantId, dayQuery, null, 'order-volume').catch((e) => ({
        _error: String(e?.message || e),
        rows: [],
        cacheMeta: {},
      })),
    ]);

    dashboardTotal = safeObject(results[0]);
    if (dashboardTotal._error) {
      partial.dashboard_error = String(dashboardTotal._error);
    }

    const rankingRaw = results[1];
    if (rankingRaw != null && typeof rankingRaw === 'object' && '_error' in safeObject(rankingRaw)) {
      partial.ranking_error = String(safeObject(rankingRaw)._error);
      rankingRows = safeArray(safeObject(rankingRaw)._rows);
    } else {
      rankingRows = safeArray(rankingRaw);
    }

    trendResult = safeObject(results[2]);
    if (trendResult._error) {
      partial.trend_error = String(trendResult._error);
    }
  } catch (e) {
    partial.query_duration_ms = Date.now() - t0;
    return buildOutput(partial, `query_batch_error:${String(e?.message || e)}`, false);
  }

  partial.query_duration_ms = Date.now() - t0;

  const trendDiag = readTrendDiagnostics(trendResult);
  partial.trend_rows_count = trendDiag.trend_rows_count;
  partial.trend_points_count = trendDiag.trend_points_count;
  partial.cache_source = trendDiag.cache_source;
  partial.snapshot_source = trendDiag.snapshot_source;

  const trendSum = sumTrendKpiTotals(trendResult);
  partial.trend_gmv_source = trendSum.source;
  partial.trend_gmv_usd_raw_sum = safeNumber(trendSum.gmv_usd_raw_sum);

  const ranking_total_orders = rankingRows.reduce((s, r) => s + safeNumber(safeObject(r).orders), 0);
  /** 排行租户 GMV �?dashboard �?rollup（单店展示可 round，汇总禁�?SUM(ROUND(shop))�?*/
  const ranking_total_gmv = safeNumber(dashboardTotal.gmv);

  partial.dashboard_today_orders = safeNumber(dashboardTotal.orders);
  partial.dashboard_today_gmv = safeNumber(dashboardTotal.gmv);
  partial.ranking_total_orders = ranking_total_orders;
  partial.ranking_total_gmv = ranking_total_gmv;
  partial.trend_total_orders = trendSum.orders;
  partial.trend_total_gmv = safeNumber(trendSum.gmv);
  partial.trend_order_filter = LOCKED_KPI_ORDER_FILTER;

  const inconsistent_modules = [];
  if (trendSum.error) inconsistent_modules.push(String(trendSum.error));
  if (!usesValid) inconsistent_modules.push('locked_where_missing_valid');
  if (legacy_paid_snapshot_found) inconsistent_modules.push('legacy_paid_snapshot_found');
  if (!nearEqual(partial.dashboard_today_orders, partial.ranking_total_orders)) {
    inconsistent_modules.push('dashboard_vs_ranking_orders');
  }
  if (!nearEqual(partial.dashboard_today_gmv, partial.ranking_total_gmv)) {
    inconsistent_modules.push('dashboard_vs_ranking_gmv');
  }
  if (!nearEqual(partial.dashboard_today_orders, partial.trend_total_orders)) {
    inconsistent_modules.push('dashboard_vs_trend_orders');
  }
  if (!nearEqual(partial.dashboard_today_gmv, partial.trend_total_gmv)) {
    inconsistent_modules.push('dashboard_vs_trend_gmv');
  }
  if (!nearEqual(partial.ranking_total_orders, partial.trend_total_orders)) {
    inconsistent_modules.push('ranking_vs_trend_orders');
  }
  if (!nearEqual(partial.ranking_total_gmv, partial.trend_total_gmv)) {
    inconsistent_modules.push('ranking_vs_trend_gmv');
  }

  partial.inconsistent_modules = inconsistent_modules;

  return buildOutput(partial, null, inconsistent_modules.length === 0);
}

async function main() {
  const { tenantId, dateYmd } = parseArgs(process.argv.slice(2));

  if (!Number.isFinite(tenantId) || tenantId <= 0) {
    printJson(
      buildOutput(emptyPartial(), 'usage: --tenant-id=<positive-number> [--date=YYYY-MM-DD]', false),
    );
    return;
  }

  try {
    const out = await runDiagnosis(tenantId, dateYmd);
    printJson(out);
  } catch (err) {
    printJson(
      buildOutput(emptyPartial(), String(err?.message || err || 'unknown_error'), false),
    );
  }
}

void main();
