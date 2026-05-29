'use strict';

const { getMysqlPool } = require('../../db/mysqlPool');
const { strictAnalyticsFilterOpts } = require('../../lib/resolveTenantShop');
const { getWithDashboardCache } = require('./cache/dashboardCacheRequire');
const {
  parseDashboardFilterQuery,
  buildDashboardWhere,
  dashboardWhereParams,
  dashboardOrderCountExpr,
  resolveDashboardStatsReason,
  logDashboardContract,
} = require('./filterContract');
const { dashboardGmvNativeSumExpr } = require('./filterBuilder');
const {
  resolveDashboardCurrency,
  preloadRatesForCurrencyRows,
  nativeAmountToUsd,
} = require('./gmvUsdConvert');
const { logDashboardSlow, slowMetaFromContract } = require('../../lib/dashboardSlowLog');
const {
  listDashboardEligibleShops,
  mergeRankingWithEligibleShops,
} = require('../../lib/dashboardEligibleShops');
const { normalizeRange } = require('../../lib/dashboardTimeRange');
const { queryTodayMetricsRankingRows } = require('./todayMetricsQuery');

function afOpts() {
  return strictAnalyticsFilterOpts();
}

/**
 * @param {number} tenantId
 * @param {Record<string, unknown>} q
 */
async function queryDashboardRanking(tenantId, q, dataScope = null) {
  const contract = parseDashboardFilterQuery(q, tenantId);
  const limit = Math.min(500, Math.max(1, Number(q.limit) || 100));
  const sortRaw = String(q.sort || 'gmv').toLowerCase();
  let orderCol = 'gmv';
  if (sortRaw === 'orders' || sortRaw === 'order') orderCol = 'orders';
  const scopeKey =
    dataScope?.mode === 'tenant_assigned'
      ? `assigned:${(dataScope.shopIds || []).join(',')}`
      : dataScope?.mode || 'all';

  return getWithDashboardCache()({
    endpoint: 'ranking',
    tenantId,
    contract,
    q: { ...q, _scope: scopeKey },
    extra: { limit: String(limit), sort: orderCol, scope: scopeKey },
    sqlTag: 'ranking_shop_orders_distinct_id',
    rowsPick: (val) => (Array.isArray(val) ? val.length : 0),
    loader: () => loadDashboardRankingUncached(tenantId, contract, q, limit, orderCol, dataScope),
  });
}

/**
 * @param {number} tenantId
 * @param {import('./filterContract').DashboardFilterContract} contract
 * @param {Record<string, unknown>} q
 * @param {number} limit
 * @param {string} orderCol
 */
async function loadDashboardRankingUncached(tenantId, contract, q, limit, orderCol, dataScope = null) {
  const pool = getMysqlPool();
  if (!pool) {
    const err = new Error('mysql_unavailable');
    err.code = 'mysql_unavailable';
    throw err;
  }

  const fo = afOpts();
  const where = await buildDashboardWhere(pool, tenantId, contract, {
    skipTenant: fo.skipTenant,
    allTenantShops: fo.allTenantShops,
    dataScope: dataScope || undefined,
  });
  if (where.invalidShop || where.emptyScope) {
    logDashboardContract('ranking', contract, { rows: 0, cache: 0 });
    return [];
  }

  const { shops: eligibleRows } = await listDashboardEligibleShops(pool, tenantId, dataScope, contract);

  const tr = normalizeRange(contract.timeRange || 'today');
  if (tr === 'today') {
    const t0 = Date.now();
    const baseRows = await queryTodayMetricsRankingRows(pool, tenantId, contract, {
      skipTenant: fo.skipTenant,
      allTenantShops: fo.allTenantShops,
      dataScope: dataScope || undefined,
    });
    const shopMap = new Map();
    for (const row of baseRows) {
      shopMap.set(row.shop_id, {
        shop_id: row.shop_id,
        shop_name: row.shop_name,
        market: row.market,
        orders: row.orders,
        gmv_usd: row.gmv,
      });
    }
    mergeRankingWithEligibleShops(shopMap, eligibleRows);
    const list = [...shopMap.values()];
    if (orderCol === 'orders') {
      list.sort((a, b) => b.orders - a.orders || a.shop_name.localeCompare(b.shop_name, 'en'));
    } else {
      list.sort(
        (a, b) => b.gmv_usd - a.gmv_usd || b.orders - a.orders || a.shop_name.localeCompare(b.shop_name, 'en'),
      );
    }
    const cap = Math.max(limit, eligibleRows.length);
    const out = list.slice(0, cap).map((row) => ({
      shop_id: row.shop_id,
      shop_name: row.shop_name,
      market: row.market,
      orders: row.orders,
      gmv: Number(row.gmv_usd.toFixed(2)),
      gmv_currency: 'USD',
    }));
    logDashboardSlow({
      ...slowMetaFromContract(contract),
      endpoint: 'ranking',
      durationMs: Date.now() - t0,
      sqlTag: 'ranking_locked_today_metrics',
      rows: out.length,
      cacheHit: false,
    });
    const reason =
      out.length === 0 ? await resolveDashboardStatsReason(pool, where, out.length) : '';
    logDashboardContract('ranking', contract, {
      rows: out.length,
      eligible_shops: eligibleRows.length,
      with_orders: baseRows.length,
      reason: reason || undefined,
      filterHash: where.filterHash,
      sqlTag: 'ranking_locked_today_metrics',
    });
    return out;
  }

  const params = dashboardWhereParams(where);
  const ordersSql = `
    SELECT
      o.shop_id AS shop_id,
      MAX(COALESCE(NULLIF(TRIM(o.shop_name), ''), '')) AS shop_name,
      UPPER(MAX(COALESCE(NULLIF(TRIM(o.market), ''), ''))) AS market,
      ${dashboardOrderCountExpr('o')} AS orders
    FROM orders o
    WHERE o.shop_id IS NOT NULL
      ${where.sql}
    GROUP BY o.shop_id
  `;
  const gmvSql = `
    SELECT
      o.shop_id AS shop_id,
      MAX(COALESCE(NULLIF(TRIM(o.shop_name), ''), '')) AS shop_name,
      UPPER(MAX(COALESCE(NULLIF(TRIM(o.market), ''), ''))) AS market,
      UPPER(COALESCE(NULLIF(TRIM(o.currency), ''), '')) AS line_currency,
      ${dashboardGmvNativeSumExpr(contract.orderFilter, 'o')} AS gmv_native
    FROM orders o
    WHERE o.shop_id IS NOT NULL
      ${where.sql}
    GROUP BY o.shop_id,
      UPPER(COALESCE(NULLIF(TRIM(o.currency), ''), '')),
      UPPER(COALESCE(NULLIF(TRIM(o.market), ''), ''))
  `;

  const t0 = Date.now();
  const [[orderRowsRaw], [gmvRowsRaw]] = await Promise.all([
    pool.query(ordersSql, params),
    pool.query(gmvSql, params),
  ]);
  const orderRows = Array.isArray(orderRowsRaw) ? orderRowsRaw : [];
  const gmvRows = Array.isArray(gmvRowsRaw) ? gmvRowsRaw : [];
  logDashboardSlow({
    ...slowMetaFromContract(contract),
    endpoint: 'ranking',
    durationMs: Date.now() - t0,
    sqlTag: 'ranking_shop_orders_distinct_id',
    rows: orderRows.length,
    cacheHit: false,
  });

  const rates = await preloadRatesForCurrencyRows(gmvRows, (row) =>
    resolveDashboardCurrency(row.line_currency, row.market),
  );

  const shopMap = new Map();
  for (const row of orderRows) {
    const sid = row.shop_id != null ? Number(row.shop_id) : null;
    if (sid == null) continue;
    shopMap.set(sid, {
      shop_id: sid,
      shop_name: String(row.shop_name || ''),
      market: String(row.market || ''),
      orders: Number(row.orders) || 0,
      gmv_usd: 0,
    });
  }
  for (const row of gmvRows) {
    const sid = row.shop_id != null ? Number(row.shop_id) : null;
    if (sid == null) continue;
    const cur = resolveDashboardCurrency(row.line_currency, row.market);
    const gmvUsd = nativeAmountToUsd(Number(row.gmv_native) || 0, cur, rates);
    const prev =
      shopMap.get(sid) ||
      ({
        shop_id: sid,
        shop_name: String(row.shop_name || ''),
        market: String(row.market || ''),
        orders: 0,
        gmv_usd: 0,
      });
    prev.gmv_usd += gmvUsd;
    if (!prev.shop_name && row.shop_name) prev.shop_name = String(row.shop_name || '');
    if (!prev.market && row.market) prev.market = String(row.market || '');
    shopMap.set(sid, prev);
  }

  mergeRankingWithEligibleShops(shopMap, eligibleRows);

  const list = [...shopMap.values()];
  if (orderCol === 'orders') {
    list.sort((a, b) => b.orders - a.orders || a.shop_name.localeCompare(b.shop_name, 'en'));
  } else {
    list.sort((a, b) => b.gmv_usd - a.gmv_usd || b.orders - a.orders || a.shop_name.localeCompare(b.shop_name, 'en'));
  }

  const cap = Math.max(limit, eligibleRows.length);
  const out = list.slice(0, cap).map((row) => ({
    shop_id: row.shop_id,
    shop_name: row.shop_name,
    market: row.market,
    orders: row.orders,
    gmv: Number(row.gmv_usd.toFixed(2)),
    gmv_currency: 'USD',
  }));

  const reason =
    out.length === 0 ? await resolveDashboardStatsReason(pool, where, out.length) : '';
  logDashboardContract('ranking', contract, {
    rows: out.length,
    eligible_shops: eligibleRows.length,
    with_orders: orderRows.length,
    reason: reason || undefined,
    filterHash: where.filterHash,
    usedMarketField: where.usedMarketField,
    usedStatusField: where.usedStatusField,
    usedDateField: where.usedDateField,
    sqlTag: 'ranking_shop_orders_distinct_id',
  });
  return out;
}

module.exports = { queryDashboardRanking };
