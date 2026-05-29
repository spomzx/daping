'use strict';

/**
 * Dashboard summary 聚合（sqlTag: summary_orders_distinct_id）
 * 单次扫描 orders + WITH ROLLUP，避免 count 与 gmv 两次全表扫。
 */

const {
  normalizeCurrency,
  getCurrencyByMarket,
  convertToUSDSync,
  preloadUsdRates,
} = require('../../lib/currency');
const {
  buildDashboardWhere,
  dashboardWhereParams,
  dashboardOrderCountExpr,
  resolveDashboardStatsReason,
  logDashboardContract,
} = require('./filterContract');
const { logDashboardSlow, slowMetaFromContract } = require('../../lib/dashboardSlowLog');
const { normalizeRange } = require('../../lib/dashboardTimeRange');
const { queryTodayMetricsTenantTotal } = require('./todayMetricsQuery');
const { dashboardGmvNativeSumExpr } = require('./filterBuilder');

const DEFAULT_CURRENCIES = ['USD', 'THB', 'MYR', 'VND', 'PHP', 'IDR', 'SGD', 'CNY'];

function resolveDashboardCurrency(lineCurrency, market) {
  return (
    normalizeCurrency(String(lineCurrency || '').trim()) ||
    getCurrencyByMarket(String(market || '')) ||
    'USD'
  );
}

async function preloadRatesForCurrencyRows(rows, pickCurrency) {
  const set = new Set();
  for (const row of rows) {
    const cur = pickCurrency(row);
    if (cur) set.add(cur);
  }
  const list = [...set];
  return preloadUsdRates(list.length ? list : DEFAULT_CURRENCIES);
}

function sumNativeGroupsToUsd(rows, rates, pickNative, pickCurrency) {
  let total = 0;
  for (const row of rows) {
    const cur = pickCurrency(row);
    const native = Number(pickNative(row)) || 0;
    total += convertToUSDSync(native, cur, rates[cur]);
  }
  return Number(total.toFixed(2));
}

/**
 * @param {import('mysql2/promise').Pool} pool
 * @param {number} tenantId
 * @param {import('./filterContract').DashboardFilterContract} contract
 * @param {{ skipTenant?: boolean, allTenantShops?: boolean }} fo
 * @param {{ fromSec: number, untilSec: number }|null} [window]
 * @param {{ endpoint?: string, sqlTag?: string }} [slowCtx]
 */
async function queryDashboardSummaryAggregates(pool, tenantId, contract, fo, window = null, slowCtx = null) {
  const slice =
    window && Number.isFinite(window.fromSec) && Number.isFinite(window.untilSec)
      ? { ...contract, startSec: window.fromSec, endSec: window.untilSec }
      : contract;

  const where = await buildDashboardWhere(pool, tenantId, slice, {
    skipTenant: fo.skipTenant,
    allTenantShops: fo.allTenantShops,
    dataScope: fo.dataScope,
  });

  if (where.invalidShop || where.emptyScope) {
    return { invalidShop: true, gmv: 0, orders: 0, shop_count: 0 };
  }

  const tr = normalizeRange(slice.timeRange || 'today');
  if (tr === 'today' && !window) {
    const t0 = Date.now();
    const locked = await queryTodayMetricsTenantTotal(pool, tenantId, slice, {
      skipTenant: fo.skipTenant,
      allTenantShops: fo.allTenantShops,
      dataScope: fo.dataScope,
    });
    logDashboardSlow({
      ...slowMetaFromContract(slice),
      endpoint: slowCtx?.endpoint || 'summary',
      durationMs: Date.now() - t0,
      sqlTag: slowCtx?.sqlTag || 'summary_locked_today_metrics',
      rows: locked.shop_count,
    });
    const reason =
      locked.orders === 0
        ? await resolveDashboardStatsReason(pool, locked.whereMeta || where, locked.orders)
        : '';
    if (reason) {
      logDashboardContract(slowCtx?.endpoint || 'summary', slice, {
        rows: locked.orders,
        orders: locked.orders,
        reason,
        filterHash: (locked.whereMeta || where).filterHash,
        sqlTag: 'summary_locked_today_metrics',
      });
    }
    return {
      invalidShop: false,
      gmv: locked.gmv,
      orders: locked.orders,
      shop_count: locked.shop_count,
      reason: reason || undefined,
      whereMeta: locked.whereMeta || where,
    };
  }

  const params = dashboardWhereParams(where);

  const t0 = Date.now();
  const [r] = await pool.query(
    `
    SELECT
      ${dashboardOrderCountExpr('o')} AS orders,
      COUNT(DISTINCT o.shop_id) AS shop_count,
      UPPER(COALESCE(NULLIF(TRIM(o.currency), ''), '')) AS line_currency,
      UPPER(COALESCE(NULLIF(TRIM(o.market), ''), '')) AS market,
      ${dashboardGmvNativeSumExpr(slice.orderFilter, 'o')} AS gmv_native
    FROM orders o
    WHERE 1=1
      ${where.sql}
    GROUP BY
      UPPER(COALESCE(NULLIF(TRIM(o.currency), ''), '')),
      UPPER(COALESCE(NULLIF(TRIM(o.market), ''), ''))
    WITH ROLLUP
    `,
    params,
  );

  const rows = Array.isArray(r) ? r : [];
  let orders = 0;
  let shop_count = 0;
  const gmvRowList = [];

  for (const row of rows) {
    const lc = row.line_currency;
    const mk = row.market;
    if (lc == null && mk == null) {
      orders = Number(row.orders) || 0;
      shop_count = Number(row.shop_count) || 0;
      continue;
    }
    if (lc == null || mk == null) continue;
    gmvRowList.push(row);
  }

  const rates = await preloadRatesForCurrencyRows(gmvRowList, (row) =>
    resolveDashboardCurrency(row.line_currency, row.market),
  );

  const gmv = sumNativeGroupsToUsd(
    gmvRowList,
    rates,
    (row) => row.gmv_native,
    (row) => resolveDashboardCurrency(row.line_currency, row.market),
  );

  logDashboardSlow({
    ...slowMetaFromContract(slice),
    endpoint: slowCtx?.endpoint || 'summary',
    durationMs: Date.now() - t0,
    sqlTag: slowCtx?.sqlTag || 'summary_orders_distinct_id',
    rows: gmvRowList.length,
  });

  const reason =
    orders === 0 && gmvRowList.length === 0
      ? await resolveDashboardStatsReason(pool, where, orders)
      : '';
  if (reason) {
    logDashboardContract(slowCtx?.endpoint || 'summary', slice, {
      rows: orders,
      orders,
      reason,
      filterHash: where.filterHash,
      usedMarketField: where.usedMarketField,
      usedStatusField: where.usedStatusField,
      usedDateField: where.usedDateField,
      sqlTag: slowCtx?.sqlTag || 'summary_orders_distinct_id',
    });
  }

  return { invalidShop: false, gmv, orders, shop_count, reason: reason || undefined, whereMeta: where };
}

module.exports = { queryDashboardSummaryAggregates };
