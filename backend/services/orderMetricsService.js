'use strict';

/**
 * 统一订单 / GMV 统计入口（ONLY MYSQL）
 *
 * 【今日订单数 + 今日 GMV】唯一实现：modules/dashboard/todayMetricsQuery.js（LOCKED）
 * 本服务封装 dashboard 路由；店铺管理经 shopTodayStats → todayMetricsQuery。
 * 禁止 readJsonCache / orders-cache.json / gmv-cache.json / dashboard-snapshot。
 */

const { getMysqlPool } = require('../db/mysqlPool');
const { withDashboardCache } = require('../lib/dashboardCache');
const { strictAnalyticsFilterOpts } = require('../lib/resolveTenantShop');
const { buildDataSourceDebug } = require('../lib/dataSourceDebug');
const {
  parseDashboardFilterQuery,
  buildDashboardWhere,
  buildLockedKpiDashboardWhere,
  orderAnalyticsEventTimeExpr,
} = require('../modules/dashboard/filterContract');
const { queryDashboardGmvUsd } = require('../modules/dashboard/usdGmv');
const { queryDashboardRanking } = require('../modules/dashboard/rankingQuery');
const { queryDashboardTrend } = require('../modules/dashboard/trendQuery');
const { queryDashboardGmvCompare } = require('../modules/dashboard/gmvCompareQuery');
const { queryDashboardProductRanking } = require('../modules/dashboard/productRankingQuery');
const { resolveDashboardDataScope } = require('../lib/dashboardEligibleShops');

function ensurePool() {
  const pool = getMysqlPool();
  if (!pool) {
    const err = new Error('mysql_unavailable');
    err.code = 'mysql_unavailable';
    throw err;
  }
  return pool;
}

function afOpts() {
  return strictAnalyticsFilterOpts();
}

/**
 * 今日订单数 + GMV（USD）— 与 /api/dashboard/summary 同口径
 */
async function getTodayOrderSummary(tenantId, q, auth) {
  const contract = parseDashboardFilterQuery(q, tenantId);
  const dataScope = await resolveDashboardDataScope(auth, tenantId);
  return withDashboardCache({
    endpoint: 'summary',
    tenantId,
    contract,
    q: { ...q, _scope: dataScope.mode },
    sqlTag: 'summary_orders_distinct_id',
    loader: async () => {
      const pool = ensurePool();
      const fo = afOpts(auth);
      const whereMeta = await buildDashboardWhere(pool, tenantId, contract, {
        skipTenant: fo.skipTenant,
        allTenantShops: fo.allTenantShops,
        dataScope,
      });
      const snap = await queryDashboardGmvUsd(
        pool,
        tenantId,
        contract,
        { ...fo, dataScope },
        null,
        {
          endpoint: 'summary',
          sqlTag: 'summary_orders_distinct_id',
        },
      );
      if (snap.invalidShop) {
        return {
          orders: 0,
          gmv: 0,
          shop_count: 0,
          gmv_currency: 'USD',
          reason: 'shop_filter_no_match',
          debug: buildDataSourceDebug(contract, {
            invalidShop: true,
            reason: 'shop_filter_no_match',
          }),
        };
      }
      return {
        orders: snap.orders,
        gmv: snap.gmv,
        shop_count: snap.shop_count,
        gmv_currency: 'USD',
        reason: snap.reason,
        debug: buildDataSourceDebug(contract, {
          dateWindow: whereMeta.dateWindow,
          timeWhereSql: whereMeta.timeWhereSql,
          filterHash: snap.whereMeta?.filterHash || whereMeta.filterHash,
          usedMarketField: snap.whereMeta?.usedMarketField || whereMeta.usedMarketField,
          usedStatusField: snap.whereMeta?.usedStatusField || whereMeta.usedStatusField,
          usedDateField: snap.whereMeta?.usedDateField || whereMeta.usedDateField,
          reason: snap.reason,
        }),
      };
    },
  });
}

/**
 * 店铺排行
 */
async function getShopRanking(tenantId, q, auth) {
  const pool = ensurePool();
  const contract = parseDashboardFilterQuery(q, tenantId);
  const dataScope = await resolveDashboardDataScope(auth, tenantId);
  const fo = afOpts(auth);
  const whereMeta = await buildDashboardWhere(pool, tenantId, contract, {
    skipTenant: fo.skipTenant,
    allTenantShops: fo.allTenantShops,
    dataScope,
  });
  const items = await queryDashboardRanking(tenantId, q, dataScope);
  return {
    items,
    debug: buildDataSourceDebug(contract, {
      endpoint: 'ranking',
      dateWindow: whereMeta.dateWindow,
      timeWhereSql: whereMeta.timeWhereSql,
      filterHash: whereMeta.filterHash,
      usedMarketField: whereMeta.usedMarketField,
      usedStatusField: whereMeta.usedStatusField,
      usedDateField: whereMeta.usedDateField,
    }),
  };
}

/**
 * 趋势 / 订单量
 */
async function getOrderTrend(tenantId, q, auth, endpoint = 'trend') {
  const pool = ensurePool();
  const contract = parseDashboardFilterQuery(q, tenantId);
  const fo = afOpts(auth);
  const whereMeta = await buildLockedKpiDashboardWhere(pool, tenantId, contract, {
    skipTenant: fo.skipTenant,
    allTenantShops: fo.allTenantShops,
  });
  const { rows, cacheMeta } = await queryDashboardTrend(tenantId, q, auth, endpoint);
  return {
    rows,
    debug: buildDataSourceDebug(contract, {
      endpoint,
      dateWindow: whereMeta.dateWindow,
      timeWhereSql: whereMeta.timeWhereSql,
      orderFilterApplied: whereMeta.orderFilterApplied,
      orderFilterWhereSql: whereMeta.orderFilterWhereSql,
      orderFilterStatusSupported: whereMeta.orderFilterStatusSupported,
      ...(cacheMeta || {}),
    }),
  };
}

/**
 * GMV 对比（今日 vs 昨日同期）
 */
async function getGmvCompare(tenantId, q) {
  const pool = ensurePool();
  const contract = parseDashboardFilterQuery(q, tenantId);
  const fo = afOpts();
  const whereMeta = await buildDashboardWhere(pool, tenantId, contract, {
    skipTenant: fo.skipTenant,
    allTenantShops: fo.allTenantShops,
  });
  const out = await queryDashboardGmvCompare(tenantId, q);
  return {
    ...out,
    debug: buildDataSourceDebug(contract, {
      endpoint: 'gmv-compare',
      dateWindow: whereMeta.dateWindow,
      timeWhereSql: whereMeta.timeWhereSql,
    }),
  };
}

/**
 * 商品排行
 */
async function getProductRanking(tenantId, q, limit = 20) {
  const pool = ensurePool();
  const contract = parseDashboardFilterQuery(q, tenantId);
  const fo = afOpts();
  const whereMeta = await buildDashboardWhere(pool, tenantId, contract, {
    skipTenant: fo.skipTenant,
    allTenantShops: fo.allTenantShops,
  });
  const items = await queryDashboardProductRanking(tenantId, { ...q, limit });
  return {
    items,
    debug: buildDataSourceDebug(contract, {
      endpoint: 'product-ranking',
      dateWindow: whereMeta.dateWindow,
      timeWhereSql: whereMeta.timeWhereSql,
      filterHash: whereMeta.filterHash,
      usedMarketField: whereMeta.usedMarketField,
      usedStatusField: whereMeta.usedStatusField,
      usedDateField: whereMeta.usedDateField,
    }),
  };
}

/**
 * 文档用：有效订单状态集合（与 lib/orderFilter VALID_CANON 一致）
 */
const VALID_ORDER_STATUS_CANON = [
  'awaiting_shipment',
  'awaiting_collection',
  'partially_shipping',
  'in_transit',
  'delivered',
  'completed',
  'paid',
  'pending_payment',
  'awaiting_payment',
  'returned',
  'shipped',
  'ready_to_ship',
  'partially_shipped',
  'awaiting_package',
  'to_ship',
];

/**
 * 文档用：统一时间条件说明（实现为 epoch 自然日，等价 CURDATE 日历边界）
 */
function describeTodayTimePredicate(alias = 'o') {
  const ts = orderAnalyticsEventTimeExpr(alias);
  return `${ts} >= 今日 00:00:00 (server local) AND ${ts} <= now`;
}

module.exports = {
  getTodayOrderSummary,
  getShopRanking,
  getOrderTrend,
  getGmvCompare,
  getProductRanking,
  ensurePool,
  parseDashboardFilterQuery,
  buildDashboardWhere,
  orderAnalyticsEventTimeExpr,
  VALID_ORDER_STATUS_CANON,
  describeTodayTimePredicate,
  buildDataSourceDebug,
};
