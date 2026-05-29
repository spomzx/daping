#!/usr/bin/env node
'use strict';

/**
 * analytics_status / KPI 口径诊断（valid 为唯一有效订单口径）
 *
 *   node scripts/diagnose-order-analytics-status.js --tenant-id=6 --date=2026-05-25
 */

const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const { getMysqlPool } = require('../db/mysqlPool');
const { getTimeRangeBounds, parseYmd } = require('../lib/dashboardTimeRange');
const { buildIndexFriendlyEventTimeWhere } = require('../modules/dashboard/filterContract');
const {
  queryTodayMetricsTenantTotal,
  queryTodayMetricsRankingRows,
} = require('../modules/dashboard/todayMetricsQuery');
const {
  parseDashboardFilterQuery,
  buildLockedKpiDashboardWhere,
} = require('../modules/dashboard/filterContract');
const { queryDashboardTrend } = require('../modules/dashboard/trendQuery');
const { queryDashboardProductRanking } = require('../modules/dashboard/productRankingQuery');
const {
  resolveDashboardCurrency,
  preloadRatesForCurrencyRows,
  nativeAmountToUsd,
} = require('../modules/dashboard/gmvUsdConvert');

function parseArgs(argv) {
  let tenantId = null;
  let dateYmd = null;
  for (const a of argv) {
    if (a.startsWith('--tenant-id=')) tenantId = Number(a.split('=')[1]);
    if (a.startsWith('--date=')) dateYmd = String(a.split('=')[1] || '').trim();
  }
  return { tenantId, dateYmd };
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function gmvNearEqual(a, b, eps = 0.01) {
  return Math.abs(num(a) - num(b)) <= eps;
}

async function sumGmvNativeRows(pool, rows) {
  const rates = await preloadRatesForCurrencyRows(rows, (row) =>
    resolveDashboardCurrency(row.line_currency, row.market),
  );
  let total = 0;
  for (const row of rows) {
    const cur = resolveDashboardCurrency(row.line_currency, row.market);
    total += nativeAmountToUsd(Number(row.gmv_native) || 0, cur, rates);
  }
  return Number(total.toFixed(2));
}

function scanRepoForPaidAnalyticsStatusSql() {
  const root = path.join(__dirname, '..');
  const hits = [];
  const re = /analytics_status\s*=\s*['"]paid['"]|analytics_status\s+IN\s*\([^)]*['"]paid['"]/gi;
  function walk(dir) {
    for (const name of fs.readdirSync(dir)) {
      if (name === 'node_modules' || name === '.git') continue;
      const p = path.join(dir, name);
      const st = fs.statSync(p);
      if (st.isDirectory()) {
        walk(p);
        continue;
      }
      if (!/\.(js|ts|tsx|sql)$/.test(name)) continue;
      if (name === 'diagnose-order-analytics-status.js') continue;
      const text = fs.readFileSync(p, 'utf8');
      if (re.test(text)) hits.push(path.relative(root, p));
    }
  }
  walk(root);
  return hits;
}

function sumTrendRows(payload) {
  const root = payload && typeof payload === 'object' ? payload : {};
  const totals = root.kpi_totals;
  if (totals && typeof totals === 'object' && totals.gmv_usd != null) {
    return {
      orders: num(totals.orders),
      gmv: num(totals.gmv_usd),
    };
  }
  return { orders: 0, gmv: 0, error: 'trend_missing_kpi_totals' };
}

async function main() {
  const { tenantId, dateYmd } = parseArgs(process.argv.slice(2));
  if (!Number.isFinite(tenantId) || tenantId <= 0) {
    console.error('用法: node scripts/diagnose-order-analytics-status.js --tenant-id=6 --date=2026-05-25');
    process.exit(1);
  }

  const pool = getMysqlPool();
  if (!pool) {
    console.error('[diagnose-order-analytics-status] 无 MySQL');
    process.exit(2);
  }

  const ymd =
    dateYmd ||
    (() => {
      const d = new Date();
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    })();
  const parsed = parseYmd(ymd);
  if (!parsed) {
    console.error('无效 --date，需 YYYY-MM-DD');
    process.exit(1);
  }
  const startYmd = `${parsed.y}-${String(parsed.mo).padStart(2, '0')}-${String(parsed.d).padStart(2, '0')}`;
  const bounds = getTimeRangeBounds('custom', startYmd, startYmd);
  const tw = buildIndexFriendlyEventTimeWhere('o', bounds.startSec, bounds.endSec);
  const timeSql = String(tw.sql || '').trim();
  const timeParams = Array.isArray(tw.params) ? tw.params : [];

  const baseWhere = `o.tenant_id = ? AND o.shop_id IS NOT NULL ${timeSql}`;
  const baseParams = [tenantId, ...timeParams];

  const [statusRows] = await pool.query(
    `
    SELECT
      COALESCE(NULLIF(TRIM(o.analytics_status), ''), '(null)') AS analytics_status,
      COUNT(DISTINCT o.id) AS orders_count,
      COALESCE(SUM(o.total_amount), 0) AS gmv_native_sum
    FROM orders o
    WHERE ${baseWhere}
    GROUP BY COALESCE(NULLIF(TRIM(o.analytics_status), ''), '(null)')
    ORDER BY orders_count DESC
    `,
    baseParams,
  );

  const breakdown = (Array.isArray(statusRows) ? statusRows : []).map((r) => ({
    analytics_status: String(r.analytics_status),
    orders_count: num(r.orders_count),
    gmv_native_sum: num(r.gmv_native_sum),
  }));

  const [validRow] = await pool.query(
    `SELECT COUNT(DISTINCT o.id) AS orders_count FROM orders o WHERE ${baseWhere} AND o.analytics_status = 'valid'`,
    baseParams,
  );
  const [validGmvRows] = await pool.query(
    `
    SELECT
      UPPER(COALESCE(NULLIF(TRIM(o.currency), ''), '')) AS line_currency,
      UPPER(COALESCE(NULLIF(TRIM(o.market), ''), '')) AS market,
      COALESCE(SUM(o.total_amount), 0) AS gmv_native
    FROM orders o
    WHERE ${baseWhere} AND o.analytics_status = 'valid'
    GROUP BY
      UPPER(COALESCE(NULLIF(TRIM(o.currency), ''), '')),
      UPPER(COALESCE(NULLIF(TRIM(o.market), ''), ''))
    `,
    baseParams,
  );
  const [cancelRow] = await pool.query(
    `SELECT COUNT(DISTINCT o.id) AS orders_count FROM orders o WHERE ${baseWhere} AND o.analytics_status = 'cancelled'`,
    baseParams,
  );
  const [cancelGmvRows] = await pool.query(
    `
    SELECT
      UPPER(COALESCE(NULLIF(TRIM(o.currency), ''), '')) AS line_currency,
      UPPER(COALESCE(NULLIF(TRIM(o.market), ''), '')) AS market,
      COALESCE(SUM(o.total_amount), 0) AS gmv_native
    FROM orders o
    WHERE ${baseWhere} AND o.analytics_status = 'cancelled'
    GROUP BY
      UPPER(COALESCE(NULLIF(TRIM(o.currency), ''), '')),
      UPPER(COALESCE(NULLIF(TRIM(o.market), ''), ''))
    `,
    baseParams,
  );
  const [paidColRows] = await pool.query(
    `SELECT COUNT(DISTINCT o.id) AS paid_orders_count FROM orders o WHERE ${baseWhere} AND o.analytics_status = 'paid'`,
    baseParams,
  );

  const valid_orders_count = num(validRow?.[0]?.orders_count);
  const valid_gmv = await sumGmvNativeRows(pool, Array.isArray(validGmvRows) ? validGmvRows : []);
  const cancelled_orders_count = num(cancelRow?.[0]?.orders_count);
  const cancelled_gmv = await sumGmvNativeRows(pool, Array.isArray(cancelGmvRows) ? cancelGmvRows : []);
  const paid_orders_count_db_column = num(paidColRows?.[0]?.paid_orders_count);

  /** 与 --date 日历日对齐（避免 valid 用 custom 而 trend 用 CURDATE 导致误报） */
  const dayQuery = {
    timeRange: 'custom',
    startDate: startYmd,
    endDate: startYmd,
    shopId: 'all',
    market: 'ALL',
  };
  const kpiContract = parseDashboardFilterQuery({ ...dayQuery, orderFilter: 'valid' }, tenantId);
  const uiPaidContract = parseDashboardFilterQuery({ ...dayQuery, orderFilter: 'paid' }, tenantId);

  const [dashboardTotal, rankingRows, trendResult, productRows] = await Promise.all([
    queryTodayMetricsTenantTotal(pool, tenantId, kpiContract, {}),
    queryTodayMetricsRankingRows(pool, tenantId, kpiContract, {}),
    queryDashboardTrend(tenantId, { ...dayQuery, orderFilter: 'paid' }, null, 'trend'),
    queryDashboardProductRanking(tenantId, { ...dayQuery, orderFilter: 'paid', limit: 500, sort: 'orders' }),
  ]);

  const ranking_total_orders = rankingRows.reduce((s, r) => s + num(r.orders), 0);
  const ranking_total_gmv = num(dashboardTotal.gmv);

  const trendSum = sumTrendRows(trendResult);
  const trend_total_orders = trendSum.orders;
  const trend_total_gmv = num(trendSum.gmv);

  const product_ranking_order_count = (Array.isArray(productRows) ? productRows : []).reduce(
    (s, r) => s + num(r.orders),
    0,
  );
  const product_ranking_gmv = Number(
    (Array.isArray(productRows) ? productRows : []).reduce((s, r) => s + num(r.gmv), 0).toFixed(2),
  );

  const lockedWhere = await buildLockedKpiDashboardWhere(pool, tenantId, uiPaidContract, {});
  const lockedWhereSql = String(lockedWhere.orderFilterWhereSql || '');
  const usesPaidColumn = /analytics_status\s*=\s*['"]paid['"]/i.test(lockedWhereSql);

  const inconsistent_modules = [];
  if (paid_orders_count_db_column > 0) inconsistent_modules.push('db_has_analytics_status_paid_rows');
  if (usesPaidColumn) inconsistent_modules.push('locked_kpi_where_queries_paid_column');
  if (num(dashboardTotal.orders) !== valid_orders_count) {
    inconsistent_modules.push('dashboard_today_orders_vs_valid');
  }
  if (trendSum.error) inconsistent_modules.push(String(trendSum.error));
  if (!gmvNearEqual(num(dashboardTotal.gmv), valid_gmv)) {
    inconsistent_modules.push('dashboard_today_gmv_vs_valid');
  }
  if (ranking_total_orders !== valid_orders_count) {
    inconsistent_modules.push('ranking_total_orders_vs_valid');
  }
  if (!gmvNearEqual(ranking_total_gmv, valid_gmv)) {
    inconsistent_modules.push('ranking_total_gmv_vs_valid');
  }
  if (trend_total_orders !== valid_orders_count) {
    inconsistent_modules.push('trend_total_orders_vs_valid');
  }
  if (!gmvNearEqual(trend_total_gmv, valid_gmv)) {
    inconsistent_modules.push('trend_total_gmv_vs_valid');
  }
  if (ranking_total_orders !== num(dashboardTotal.orders)) {
    inconsistent_modules.push('ranking_total_orders_vs_dashboard');
  }
  if (!gmvNearEqual(ranking_total_gmv, num(dashboardTotal.gmv))) {
    inconsistent_modules.push('ranking_total_gmv_vs_dashboard');
  }
  if (trend_total_orders !== num(dashboardTotal.orders)) {
    inconsistent_modules.push('trend_total_orders_vs_dashboard');
  }
  if (!gmvNearEqual(trend_total_gmv, num(dashboardTotal.gmv))) {
    inconsistent_modules.push('trend_total_gmv_vs_dashboard');
  }
  /** 商品排行 orders 为 SKU 维度去重之和，可与 valid 订单总数不等；GMV 子集应 ≤ valid_gmv */
  if (product_ranking_gmv > valid_gmv + 0.02) {
    inconsistent_modules.push('product_ranking_gmv_exceeds_valid');
  }

  const repoPaidHits = scanRepoForPaidAnalyticsStatusSql();
  if (repoPaidHits.length) {
    inconsistent_modules.push(`repo_sql_paid_literal:${repoPaidHits.join(',')}`);
  }

  const out = {
    tenant_id: tenantId,
    date: ymd,
    status_breakdown: breakdown,
    valid_orders_count,
    valid_gmv,
    cancelled_orders_count,
    cancelled_gmv,
    paid_orders_count_db_column,
    dashboard_today_orders: num(dashboardTotal.orders),
    dashboard_today_gmv: num(dashboardTotal.gmv),
    ranking_total_orders,
    ranking_total_gmv,
    trend_total_orders,
    trend_total_gmv,
    product_ranking_order_count,
    product_ranking_gmv,
    locked_kpi_order_filter: lockedWhere.orderFilter,
    locked_kpi_where_sql: lockedWhereSql || '(none)',
    inconsistent_modules,
    ok: inconsistent_modules.length === 0,
  };

  console.log(JSON.stringify(out, null, 2));
  process.exit(out.ok ? 0 : 1);
}

main().catch((err) => {
  console.error('[diagnose-order-analytics-status]', err?.message || err);
  process.exit(1);
});
