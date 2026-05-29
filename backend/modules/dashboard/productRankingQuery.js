'use strict';

/**
 * 商品排行：与 summary / trend 共用 dashboard orderFilter + timeRange 契约。
 */

const { getMysqlPool } = require('../../db/mysqlPool');
const { strictAnalyticsFilterOpts } = require('../../lib/resolveTenantShop');
const { getWithDashboardCache } = require('./cache/dashboardCacheRequire');
const {
  parseDashboardFilterQuery,
  buildDashboardWhere,
  dashboardOrderCountExpr,
  dashboardOrderItemsJoinParams,
  resolveDashboardStatsReason,
  logDashboardContract,
  contractForDashboardApi,
} = require('./filterContract');
const {
  resolveDashboardCurrency,
  preloadRatesForCurrencyRows,
  nativeAmountToUsd,
} = require('./usdGmv');
const { logDashboardSlow, slowMetaFromContract } = require('../../lib/dashboardSlowLog');
const { dashboardOrderItemGmvSumExpr } = require('./filterBuilder');

function afOpts() {
  return strictAnalyticsFilterOpts();
}

function buildProductRankingParams(fo, tenantId, where) {
  return dashboardOrderItemsJoinParams(tenantId, where, { skipTenant: fo.skipTenant });
}

/**
 * @param {number} tenantId
 * @param {Record<string, unknown>} q
 */
async function queryDashboardProductRanking(tenantId, q) {
  const contract = parseDashboardFilterQuery(q, tenantId);
  const limit = Math.min(200, Math.max(1, Number(q.limit) || 20));
  const sortRaw = String(q.sort || 'qty').toLowerCase();
  let sort = 'qty';
  if (sortRaw === 'gmv') sort = 'gmv';
  else if (sortRaw === 'orders' || sortRaw === 'order') sort = 'orders';

  return getWithDashboardCache()({
    endpoint: 'product-ranking',
    tenantId,
    contract,
    q,
    extra: { limit: String(limit), sort },
    sqlTag: 'product_ranking_items_join_group',
    rowsPick: (val) => (Array.isArray(val) ? val.length : 0),
    loader: () => loadDashboardProductRankingUncached(tenantId, contract, limit, sort),
  });
}

/**
 * @param {number} tenantId
 * @param {import('./filterContract').DashboardFilterContract} contract
 * @param {number} limit
 * @param {string} sort
 */
async function loadDashboardProductRankingUncached(tenantId, contract, limit, sort) {
  const pool = getMysqlPool();
  if (!pool) {
    const err = new Error('mysql_unavailable');
    err.code = 'mysql_unavailable';
    throw err;
  }

  const apiContract = contractForDashboardApi(contract);
  const fo = afOpts();
  const where = await buildDashboardWhere(pool, tenantId, apiContract, {
    alias: 'o',
    skipTenant: fo.skipTenant,
    allTenantShops: fo.allTenantShops,
  });
  if (where.invalidShop) {
    logDashboardContract('product-ranking', apiContract, { rows: 0 });
    return [];
  }

  const oiTenantClause = fo.skipTenant ? '1=1' : 'oi.tenant_id = ?';
  const grpExpr = `IF(
        TRIM(COALESCE(oi.product_id, '')) <> '' AND TRIM(COALESCE(oi.sku_id, '')) <> '',
        CONCAT('id:', oi.product_id, CHAR(31), oi.sku_id),
        CONCAT('nm:', LEFT(COALESCE(oi.product_name, ''), 64), CHAR(31), LEFT(COALESCE(oi.sku_name, ''), 64))
      )`;

  const gmvSumExpr = dashboardOrderItemGmvSumExpr(apiContract.orderFilter, 'o', 'oi');
  const lockedOrderCountExpr = dashboardOrderCountExpr('o');
  const orderBySql =
    sort === 'gmv'
      ? `${gmvSumExpr} DESC`
      : sort === 'orders'
        ? `${lockedOrderCountExpr} DESC`
        : 'SUM(oi.quantity) DESC';

  const sql = `
    SELECT
      ${grpExpr} AS grp_key,
      MAX(COALESCE(oi.product_name, '')) AS product_name,
      MAX(COALESCE(oi.sku_name, '')) AS sku_name,
      SUM(oi.quantity) AS qty,
      ${gmvSumExpr} AS gmv_native,
      ${lockedOrderCountExpr} AS orders,
      UPPER(MAX(COALESCE(NULLIF(TRIM(oi.currency), ''), NULLIF(TRIM(o.currency), ''), ''))) AS line_currency,
      UPPER(MAX(COALESCE(NULLIF(TRIM(o.market), ''), ''))) AS market
    FROM order_items oi
    INNER JOIN orders o
      ON o.tenant_id = oi.tenant_id
     AND o.platform = oi.platform
     AND o.platform_order_id = oi.platform_order_id
    WHERE ${oiTenantClause}
      ${where.sql}
    GROUP BY ${grpExpr},
      UPPER(COALESCE(NULLIF(TRIM(oi.currency), ''), NULLIF(TRIM(o.currency), ''), '')),
      UPPER(COALESCE(NULLIF(TRIM(o.market), ''), ''))
    ORDER BY ${orderBySql}
    LIMIT 500
  `;

  const params = buildProductRankingParams(fo, tenantId, where);

  const t0 = Date.now();
  const [r] = await pool.query(sql, params);
  const rows = Array.isArray(r) ? r : [];
  logDashboardSlow({
    ...slowMetaFromContract(contract),
    endpoint: 'product-ranking',
    durationMs: Date.now() - t0,
    sqlTag: 'product_ranking_items_join_group',
    rows: rows.length,
    cacheHit: false,
  });

  const rates = await preloadRatesForCurrencyRows(rows, (row) =>
    resolveDashboardCurrency(row.line_currency, row.market),
  );

  const merged = new Map();
  for (const row of rows) {
    const key = String(row.grp_key || '');
    if (!key) continue;
    const cur = resolveDashboardCurrency(row.line_currency, row.market);
    const gmvUsd = nativeAmountToUsd(Number(row.gmv_native) || 0, cur, rates);
    const prev =
      merged.get(key) ||
      ({
        product_name: String(row.product_name || ''),
        sku_name: String(row.sku_name || ''),
        qty: 0,
        gmv_usd: 0,
        orders: 0,
      });
    prev.qty += Number(row.qty) || 0;
    prev.gmv_usd += gmvUsd;
    prev.orders += Number(row.orders) || 0;
    merged.set(key, prev);
  }

  const list = [...merged.values()];
  if (sort === 'gmv') list.sort((a, b) => b.gmv_usd - a.gmv_usd);
  else if (sort === 'orders') list.sort((a, b) => b.orders - a.orders);
  else list.sort((a, b) => b.qty - a.qty);

  const out = list.slice(0, limit).map((row) => ({
    product_name: row.product_name,
    sku_name: row.sku_name,
    qty: row.qty,
    gmv: Number(row.gmv_usd.toFixed(2)),
    gmv_currency: 'USD',
    orders: row.orders,
  }));

  const reason =
    out.length === 0 ? await resolveDashboardStatsReason(pool, where, out.length) : '';
  logDashboardContract('product-ranking', apiContract, {
    rows: out.length,
    reason: reason || undefined,
    filterHash: where.filterHash,
    usedMarketField: where.usedMarketField,
    usedStatusField: where.usedStatusField,
    usedDateField: where.usedDateField,
    orderFilter: apiContract.orderFilter,
    orderFilterApplied: where.orderFilterApplied,
    sqlTag: 'product_ranking_items_join_group',
  });
  return out;
}

module.exports = { queryDashboardProductRanking };
