'use strict';

/**
 * 大屏 trend / order-volume（MySQL-only，filterContract，GMV 统一 USD）
 * 与 summary / ranking / product-ranking 共用 UI orderFilter + timeRange 契约。
 */

const { getMysqlPool } = require('../../db/mysqlPool');
const { strictAnalyticsFilterOpts } = require('../../lib/resolveTenantShop');
const { withDashboardCache } = require('../../lib/dashboardCache');
const { unwrapTrendCachePayload } = require('../../lib/dashboardTrendCacheMeta');
const {
  parseDashboardFilterQuery,
  buildDashboardWhere,
  dashboardWhereParams,
  dashboardOrderCountExpr,
  logDashboardContract,
  orderAnalyticsEventTimeExpr,
  contractForDashboardApi,
} = require('./filterContract');
const { dashboardGmvNativeSumExpr } = require('./filterBuilder');
const {
  resolveDashboardCurrency,
  preloadRatesForCurrencyRows,
  nativeAmountToUsd,
  sumNativeGroupsToUsd,
  sumNativeGroupsToUsdRaw,
  roundKpiGmvUsd,
  KPI_GMV_ROUNDING_CONTRACT,
} = require('./gmvUsdConvert');
const { logDashboardSlow, slowMetaFromContract } = require('../../lib/dashboardSlowLog');

function afOpts(_auth) {
  return strictAnalyticsFilterOpts();
}

/**
 * @param {number} tenantId
 * @param {Record<string, unknown>} q
 * @param {unknown} auth
 * @param {string} [logEndpoint='trend']
 */
async function queryDashboardTrend(tenantId, q, auth, logEndpoint = 'trend') {
  const parsed = contractForDashboardApi(parseDashboardFilterQuery(q, tenantId));
  const groupBy = String(q.groupBy || q.group_by || 'hour').toLowerCase() === 'day' ? 'day' : 'hour';
  const endpoint = logEndpoint === 'order-volume' ? 'order-volume' : 'trend';

  const stamped = await withDashboardCache({
    endpoint,
    tenantId,
    contract: parsed,
    q,
    extra: { groupBy },
    sqlTag: groupBy === 'day' ? 'trend_date_group' : 'trend_hour_dateformat_group',
    rowsPick: (val) => {
      if (Array.isArray(val)) return val.length;
      if (val && typeof val === 'object' && Array.isArray(val.rows)) return val.rows.length;
      return 0;
    },
    loader: () => loadDashboardTrendUncached(tenantId, parsed, auth, endpoint, groupBy),
  });
  const { payload, cacheMeta } = unwrapTrendCachePayload(stamped);
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    const body = /** @type {{ rows?: unknown[], points?: unknown[], kpi_totals?: Record<string, unknown> }} */ (
      payload
    );
    const pts = Array.isArray(body.points)
      ? body.points
      : Array.isArray(body.rows)
        ? body.rows
        : [];
    return {
      rows: pts,
      points: pts,
      cacheMeta,
      kpi_totals: body.kpi_totals || null,
    };
  }
  const rows = Array.isArray(payload) ? payload : [];
  return { rows, points: rows, cacheMeta, kpi_totals: null };
}

/**
 * @param {number} tenantId
 * @param {import('./filterContract').DashboardFilterContract} contract
 * @param {unknown} auth
 * @param {string} logEndpoint
 * @param {'hour'|'day'} groupBy
 */
async function loadDashboardTrendUncached(tenantId, contract, auth, logEndpoint, groupBy) {
  const pool = getMysqlPool();
  if (!pool) {
    const err = new Error('mysql_unavailable');
    err.code = 'mysql_unavailable';
    throw err;
  }

  const fo = afOpts(auth);
  const evt = orderAnalyticsEventTimeExpr('o');
  const bucketExpr =
    groupBy === 'day'
      ? `DATE(${evt})`
      : `DATE_FORMAT(${evt}, '%Y-%m-%d %H:00:00')`;
  const gmvExpr = dashboardGmvNativeSumExpr(contract.orderFilter, 'o');

  const where = await buildDashboardWhere(pool, tenantId, contract, {
    skipTenant: fo.skipTenant,
    allTenantShops: fo.allTenantShops,
  });
  if (where.invalidShop) {
    logDashboardContract(logEndpoint, contract, { rows: 0, points: 0 });
    const emptyKpi = {
      orders: 0,
      gmv_usd: 0,
      gmv_usd_raw_sum: 0,
      gmv_rounding_contract: KPI_GMV_ROUNDING_CONTRACT,
    };
    return { rows: [], points: [], kpi_totals: emptyKpi };
  }

  const sql = `
    SELECT
      ${bucketExpr} AS time,
      UPPER(COALESCE(NULLIF(TRIM(o.currency), ''), '')) AS line_currency,
      UPPER(COALESCE(NULLIF(TRIM(o.market), ''), '')) AS market,
      ${dashboardOrderCountExpr('o')} AS orders,
      ${gmvExpr} AS gmv_native
    FROM orders o
    WHERE 1=1
      ${where.sql}
    GROUP BY ${bucketExpr},
      UPPER(COALESCE(NULLIF(TRIM(o.currency), ''), '')),
      UPPER(COALESCE(NULLIF(TRIM(o.market), ''), ''))
    ORDER BY time ASC
  `;

  const t0 = Date.now();
  const params = dashboardWhereParams(where);
  const [r] = await pool.query(sql, params);
  const rows = Array.isArray(r) ? r : [];
  const ms = Date.now() - t0;
  logDashboardSlow({
    ...slowMetaFromContract(contract),
    endpoint: logEndpoint,
    durationMs: ms,
    sqlTag: groupBy === 'day' ? 'trend_date_group' : 'trend_hour_dateformat_group',
    rows: rows.length,
    points: rows.length,
    cacheHit: false,
  });

  const rates = await preloadRatesForCurrencyRows(rows, (row) =>
    resolveDashboardCurrency(row.line_currency, row.market),
  );

  const pickNative = (row) => Number(row.gmv_native) || 0;
  const pickCur = (row) => resolveDashboardCurrency(row.line_currency, row.market);
  const gmvRawTotal = sumNativeGroupsToUsdRaw(rows, rates, pickNative, pickCur);
  const kpiGmvUsd = sumNativeGroupsToUsd(rows, rates, pickNative, pickCur);

  let kpiOrders = 0;
  const byTime = new Map();
  for (const row of rows) {
    const t = String(row.time || '');
    if (!t) continue;
    const cur = pickCur(row);
    const gmvUsd = nativeAmountToUsd(Number(row.gmv_native) || 0, cur, rates);
    const ord = Number(row.orders) || 0;
    kpiOrders += ord;
    const prev = byTime.get(t) || { time: t, orders: 0, gmvRaw: 0, items: 0 };
    prev.orders += ord;
    prev.gmvRaw += gmvUsd;
    byTime.set(t, prev);
  }

  const out = [...byTime.values()].map((row) => ({
    time: row.time,
    orders: row.orders,
    gmv: roundKpiGmvUsd(row.gmvRaw),
    gmv_currency: 'USD',
    items: row.items,
    paid_orders: row.orders,
    paid_gmv: roundKpiGmvUsd(row.gmvRaw),
  }));

  logDashboardContract(logEndpoint, contract, {
    rows: out.length,
    points: out.length,
    orderFilter: contract.orderFilter,
    orderFilterApplied: where.orderFilterApplied,
    kpi_gmv_usd: kpiGmvUsd,
    gmv_rounding_contract: KPI_GMV_ROUNDING_CONTRACT,
  });

  const kpiTotals = {
    orders: kpiOrders,
    gmv_usd: kpiGmvUsd,
    gmv_usd_raw_sum: gmvRawTotal,
    gmv_rounding_contract: KPI_GMV_ROUNDING_CONTRACT,
  };

  return {
    rows: out,
    points: out,
    kpi_totals: kpiTotals,
  };
}

module.exports = { queryDashboardTrend };
