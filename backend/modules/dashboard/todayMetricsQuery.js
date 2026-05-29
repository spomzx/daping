'use strict';

/**
 * 【LOCKED DATA SOURCE】
 * 今日订单数与今日 GMV 必须来自 MySQL orders 明细同一次聚合（本模块唯一入口）。
 * - today_orders = COUNT(DISTINCT o.id)  （订单主键，与 dashboardOrderCountExpr 一致）
 * - today_gmv    = 按币种 SUM(total_amount) 后 convertToUSDSync → USD
 *
 * 禁止从 snapshot / cache / summary 表 / orders-cache / gmv-cache 单独读取 GMV 或订单数。
 * 任何修改必须同步更新 docs/data-source-policy.md
 * 并通过 node scripts/diagnose-today-metrics-consistency.js
 */

const {
  parseDashboardFilterQuery,
  buildDashboardWhere,
  dashboardWhereParams,
  dashboardOrderCountExpr,
  orderAnalyticsEventTimeExpr,
} = require('./filterContract');
const { dashboardGmvNativeSumExpr } = require('./filterBuilder');
const {
  resolveDashboardCurrency,
  preloadRatesForCurrencyRows,
  nativeAmountToUsd,
  roundKpiGmvUsd,
  rollupKpiGmvFromGmvRows,
} = require('./gmvUsdConvert');

const LOCKED_SOURCE = 'mysql_orders_intraday';

/**
 * 强制不变量：无订单则 GMV 必须为 0（除非未来单独扩展 adjustment 字段）。
 * @param {{ today_orders?: number, today_gmv?: number, gmv_usd?: number, [k: string]: unknown }} pack
 */
function enforceTodayMetricsInvariant(pack) {
  const orders = Number(pack.today_orders ?? pack.orders ?? 0) || 0;
  let gmv = Number(pack.today_gmv ?? pack.gmv_usd ?? pack.gmv ?? 0) || 0;
  if (!Number.isFinite(gmv) || gmv < 0) gmv = 0;
  if (orders <= 0) gmv = 0;
  const gmvRounded = roundKpiGmvUsd(gmv);
  return {
    ...pack,
    today_orders: orders,
    orders,
    today_gmv: gmvRounded,
    gmv_usd: gmvRounded,
    gmv: gmvRounded,
    gmv_currency: 'USD',
    stats_source: LOCKED_SOURCE,
  };
}

/**
 * 默认「今日」契约（店铺管理 / 诊断与 dashboard timeRange=today 对齐）
 * @param {number} tenantId
 */
function defaultTodayContract(tenantId) {
  return parseDashboardFilterQuery(
    { timeRange: 'today', orderFilter: 'valid', shopId: 'all', market: 'ALL' },
    tenantId,
  );
}

/**
 * @param {import('mysql2/promise').Pool} pool
 * @param {Awaited<ReturnType<typeof buildDashboardWhere>>} where
 */
async function queryTodayMetricsRowsFromWhere(pool, where, orderFilter = 'valid') {
  if (!pool || where.invalidShop || where.emptyScope) {
    return { orderRows: [], gmvRows: [], whereMeta: where };
  }

  const params = dashboardWhereParams(where);
  const gmvExpr = dashboardGmvNativeSumExpr(orderFilter, 'o');
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
      ${gmvExpr} AS gmv_native
    FROM orders o
    WHERE o.shop_id IS NOT NULL
      ${where.sql}
    GROUP BY o.shop_id,
      UPPER(COALESCE(NULLIF(TRIM(o.currency), ''), '')),
      UPPER(COALESCE(NULLIF(TRIM(o.market), ''), ''))
  `;

  const [[orderRowsRaw], [gmvRowsRaw]] = await Promise.all([
    pool.query(ordersSql, params),
    pool.query(gmvSql, params),
  ]);

  return {
    orderRows: Array.isArray(orderRowsRaw) ? orderRowsRaw : [],
    gmvRows: Array.isArray(gmvRowsRaw) ? gmvRowsRaw : [],
    whereMeta: where,
  };
}

/**
 * 合并订单数 + GMV(USD) 为 per-shop Map
 * @param {Record<string, unknown>[]} orderRows
 * @param {Record<string, unknown>[]} gmvRows
 */
async function mergeTodayMetricsByShopId(orderRows, gmvRows) {
  const rates = await preloadRatesForCurrencyRows(gmvRows, (row) =>
    resolveDashboardCurrency(row.line_currency, row.market),
  );

  const shopMap = new Map();

  for (const row of orderRows) {
    const sid = row.shop_id != null ? Number(row.shop_id) : null;
    if (!Number.isFinite(sid)) continue;
    shopMap.set(
      sid,
      enforceTodayMetricsInvariant({
        shop_id: sid,
        shop_name: String(row.shop_name || ''),
        market: String(row.market || ''),
        today_orders: Number(row.orders) || 0,
        today_gmv: 0,
        latest_order_at: 0,
      }),
    );
  }

  for (const row of gmvRows) {
    const sid = row.shop_id != null ? Number(row.shop_id) : null;
    if (!Number.isFinite(sid)) continue;
    const cur = resolveDashboardCurrency(row.line_currency, row.market);
    const gmvUsd = nativeAmountToUsd(Number(row.gmv_native) || 0, cur, rates);
    const prev =
      shopMap.get(sid) ||
      enforceTodayMetricsInvariant({
        shop_id: sid,
        shop_name: String(row.shop_name || ''),
        market: String(row.market || ''),
        today_orders: 0,
        today_gmv: 0,
      });
    prev.today_gmv = Number(prev.today_gmv) + gmvUsd;
    prev.gmv_usd = prev.today_gmv;
    if (!prev.shop_name && row.shop_name) prev.shop_name = String(row.shop_name || '');
    if (!prev.market && row.market) prev.market = String(row.market || '');
    shopMap.set(sid, enforceTodayMetricsInvariant(prev));
  }

  for (const [sid, pack] of shopMap) {
    pack.today_gmv = roundKpiGmvUsd(pack.today_gmv);
    pack.gmv_usd = pack.today_gmv;
    shopMap.set(sid, enforceTodayMetricsInvariant(pack));
  }

  return shopMap;
}

/**
 * 租户今日 per-shop 指标（唯一聚合）
 * @param {import('mysql2/promise').Pool} pool
 * @param {number} tenantId
 * @param {{ contract?: import('./filterContract').DashboardFilterContract, dataScope?: import('../../lib/dataScope').UserDataScope, fo?: { skipTenant?: boolean, allTenantShops?: boolean } }} [opts]
 */
async function queryTodayMetricsByShopForTenant(pool, tenantId, opts = {}) {
  const contract = opts.contract || defaultTodayContract(tenantId);
  const fo = opts.fo || {};
  const where = await buildDashboardWhere(pool, tenantId, contract, {
    skipTenant: fo.skipTenant,
    allTenantShops: fo.allTenantShops,
    dataScope: opts.dataScope,
  });

  const { orderRows, gmvRows, whereMeta } = await queryTodayMetricsRowsFromWhere(
    pool,
    where,
    contract.orderFilter,
  );
  const byShopId = await mergeTodayMetricsByShopId(orderRows, gmvRows);

  const byPlatformId = new Map();
  const [shopMeta] = await pool.query(
    `SELECT id, LOWER(TRIM(platform_shop_id)) AS platform_shop_id
     FROM shops WHERE tenant_id = ? AND status <> 'deleted'`,
    [tenantId],
  );
  for (const s of Array.isArray(shopMeta) ? shopMeta : []) {
    const sid = Number(s.id);
    const pid = String(s.platform_shop_id || '').trim().toLowerCase();
    const pack = byShopId.get(sid);
    if (pid && pack) byPlatformId.set(pid, pack);
  }

  return {
    byShopId,
    byPlatformId,
    contract,
    whereMeta,
    stats_source: LOCKED_SOURCE,
  };
}

/**
 * 单店今日指标（同一 WHERE 契约）
 * @param {import('mysql2/promise').Pool} pool
 * @param {number} tenantId
 * @param {number} shopId
 * @param {{ dataScope?: import('../../lib/dataScope').UserDataScope }} [opts]
 */
async function queryTodayMetricsForShopId(pool, tenantId, shopId, opts = {}) {
  const contract = parseDashboardFilterQuery(
    {
      timeRange: 'today',
      orderFilter: 'valid',
      shopId: String(shopId),
      market: 'ALL',
    },
    tenantId,
  );
  const where = await buildDashboardWhere(pool, tenantId, contract, {
    dataScope: opts.dataScope,
  });
  const { orderRows, gmvRows } = await queryTodayMetricsRowsFromWhere(pool, where, contract.orderFilter);
  const map = await mergeTodayMetricsByShopId(orderRows, gmvRows);
  const pack = map.get(Number(shopId)) || enforceTodayMetricsInvariant({ shop_id: shopId });
  return enforceTodayMetricsInvariant(pack);
}

/**
 * 租户今日汇总（dashboard summary 今日窗）
 * @param {import('mysql2/promise').Pool} pool
 * @param {number} tenantId
 * @param {import('./filterContract').DashboardFilterContract} contract
 * @param {{ skipTenant?: boolean, allTenantShops?: boolean, dataScope?: import('../../lib/dataScope').UserDataScope }} fo
 */
async function queryTodayMetricsTenantTotal(pool, tenantId, contract, fo = {}) {
  const where = await buildDashboardWhere(pool, tenantId, contract, {
    skipTenant: fo.skipTenant,
    allTenantShops: fo.allTenantShops,
    dataScope: fo.dataScope,
  });
  if (where.invalidShop || where.emptyScope) {
    return enforceTodayMetricsInvariant({
      orders: 0,
      gmv: 0,
      shop_count: 0,
      invalidShop: true,
      whereMeta: where,
    });
  }

  const { orderRows, gmvRows } = await queryTodayMetricsRowsFromWhere(pool, where, contract.orderFilter);
  const byShop = await mergeTodayMetricsByShopId(orderRows, gmvRows);
  const gmvRollup = await rollupKpiGmvFromGmvRows(gmvRows);

  let orders = 0;
  for (const pack of byShop.values()) {
    orders += Number(pack.today_orders) || 0;
  }

  return enforceTodayMetricsInvariant({
    orders,
    gmv: gmvRollup.gmv_usd,
    gmv_usd_raw_sum: gmvRollup.gmv_usd_raw_sum,
    shop_count: byShop.size,
    invalidShop: false,
    whereMeta: where,
    byShopId: byShop,
  });
}

/**
 * 与 ranking 相同输出结构
 * @param {import('mysql2/promise').Pool} pool
 * @param {number} tenantId
 * @param {import('./filterContract').DashboardFilterContract} contract
 * @param {{ skipTenant?: boolean, allTenantShops?: boolean, dataScope?: import('../../lib/dataScope').UserDataScope }} fo
 */
async function queryTodayMetricsRankingRows(pool, tenantId, contract, fo = {}) {
  const where = await buildDashboardWhere(pool, tenantId, contract, {
    skipTenant: fo.skipTenant,
    allTenantShops: fo.allTenantShops,
    dataScope: fo.dataScope,
  });
  if (where.invalidShop || where.emptyScope) return [];

  const { orderRows, gmvRows } = await queryTodayMetricsRowsFromWhere(pool, where, contract.orderFilter);
  const byShop = await mergeTodayMetricsByShopId(orderRows, gmvRows);

  return [...byShop.values()].map((row) => ({
    shop_id: row.shop_id,
    shop_name: row.shop_name,
    market: row.market,
    orders: row.today_orders,
    gmv: row.today_gmv,
    gmv_currency: 'USD',
  }));
}

module.exports = {
  LOCKED_SOURCE,
  LOCKED_COMMENT: 'mysql_orders_intraday',
  orderAnalyticsEventTimeExpr,
  dashboardOrderCountExpr,
  enforceTodayMetricsInvariant,
  defaultTodayContract,
  queryTodayMetricsRowsFromWhere,
  mergeTodayMetricsByShopId,
  queryTodayMetricsByShopForTenant,
  queryTodayMetricsForShopId,
  queryTodayMetricsTenantTotal,
  queryTodayMetricsRankingRows,
};
