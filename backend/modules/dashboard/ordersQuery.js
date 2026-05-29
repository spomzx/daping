'use strict';

/**
 * 大屏实时订单 MySQL 查询（仅 dashboard/orders 使用，不走 analytics recent-orders）。
 */

const { getMysqlPool } = require('../../db/mysqlPool');
const { strictAnalyticsFilterOpts } = require('../../lib/resolveTenantShop');
const { marketColorHex, orderLevelFromUsd, isLargeOrderUsd, isMultiItem } = require('../../lib/marketOrderMeta');
const {
  resolveOrderCurrency,
  pickOrderAmount,
  amountToUsdWithStatus,
  preloadUsdRates: preloadUsdRatesRows,
} = require('../../lib/orderRowMoney');
const {
  parseDashboardFilterQuery,
  buildDashboardWhere,
  dashboardWhereParams,
  logDashboardContract,
} = require('./filterContract');
const { logDashboardSlow, slowMetaFromContract } = require('../../lib/dashboardSlowLog');
const { logDashboardPerfProbe } = require('../../lib/dashboardPerfProbe');
const { withInFlightDedupe, buildOrdersDedupeKey } = require('../../lib/dashboardRequestDedupe');
const { resolveDashboardDataScope } = require('../../lib/dashboardEligibleShops');

function afOpts(_auth) {
  return strictAnalyticsFilterOpts();
}

function formatMysqlDateTime(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * @param {number} tenantId
 * @param {Record<string, string>} q
 * @param {object} auth
 * @returns {Promise<object[]>}
 */
async function queryDashboardRealtimeOrdersUncached(tenantId, q, auth) {
  const pool = getMysqlPool();
  if (!pool) {
    const err = new Error('mysql_unavailable');
    err.code = 'mysql_unavailable';
    throw err;
  }

  const contract = parseDashboardFilterQuery(q, tenantId);
  const fo = afOpts(auth);
  const dataScope = await resolveDashboardDataScope(auth, tenantId);
  const limit = Math.min(50, Math.max(1, Number(q.limit) || 50));

  const where = await buildDashboardWhere(pool, tenantId, contract, {
    alias: 'o0',
    skipTenant: fo.skipTenant,
    allTenantShops: fo.allTenantShops,
    dataScope,
  });

  if (where.invalidShop || where.emptyScope) {
    logDashboardContract('orders', contract, { rows: 0, orders: 0 });
    return [];
  }

  const oiQtyExpr = `(SELECT COALESCE(SUM(oi.quantity), 0)
        FROM order_items oi
        WHERE oi.tenant_id = o.tenant_id
          AND oi.platform = o.platform
          AND oi.platform_order_id = o.platform_order_id)`;

  const sql = `
    SELECT
      o.platform_order_id,
      o.shop_id AS shop_id,
      COALESCE(NULLIF(TRIM(o.shop_name), ''), NULLIF(TRIM(s.shop_name), ''), '') AS shop_name,
      UPPER(COALESCE(NULLIF(TRIM(o.market), ''), NULLIF(TRIM(s.market), ''), '')) AS market,
      UPPER(COALESCE(NULLIF(TRIM(o.currency), ''), '')) AS currency,
      o.total_amount AS amount,
      ${oiQtyExpr} AS items,
      o.created_at_platform AS created_at_platform,
      o.analytics_status AS analytics_status
    FROM (
      SELECT
        o0.platform_order_id,
        o0.tenant_id,
        o0.platform,
        o0.shop_id,
        o0.shop_name,
        o0.market,
        o0.currency,
        o0.total_amount,
        o0.created_at_platform,
        o0.created_at,
        o0.analytics_status
      FROM orders o0
      WHERE 1=1
        ${where.sql}
      ORDER BY COALESCE(o0.created_at_platform, o0.created_at) DESC
      LIMIT ${limit}
    ) o
    LEFT JOIN shops s ON s.id = o.shop_id AND s.tenant_id = o.tenant_id
    ORDER BY COALESCE(o.created_at_platform, o.created_at) DESC
  `;

  const params = dashboardWhereParams(where);
  const probeT0 = Date.now();
  const sqlT0 = Date.now();
  const [r] = await pool.query(sql, params);
  const sqlMs = Date.now() - sqlT0;
  const rows = Array.isArray(r) ? r : [];
  logDashboardSlow({
    ...slowMetaFromContract(contract),
    endpoint: 'orders',
    durationMs: sqlMs,
    sqlTag: 'realtime_orders_limit',
    rows: rows.length,
  });

  const curSet = rows.map((row) => resolveOrderCurrency(row));
  const currenciesToLoad = [...new Set([...curSet, 'USD'].filter(Boolean))];
  const rates = await preloadUsdRatesRows(currenciesToLoad, false, { lenient: true });
  const cnyPer = rates.CNY > 0 ? rates.CNY : 0;

  const out = rows.map((row) => {
    const raw = pickOrderAmount(row);
    const cur = resolveOrderCurrency(row);
    const money = amountToUsdWithStatus(raw, cur, rates);
    const usdAmount = money.usd_pending ? null : money.usd;
    const cnyAmount = usdAmount != null && cnyPer > 0 ? usdAmount * cnyPer : null;
    const missingRate = money.usd_pending === true;
    const rawDecimals = cur === 'VND' ? 0 : 2;
    const usd = usdAmount != null ? Number(Number(usdAmount).toFixed(2)) : null;
    const exchange_rate = money.exchange_rate;
    const it = Number(row.items) || 0;
    const mkt = String(row.market || '');
    const order_level = orderLevelFromUsd(usd != null ? usd : 0);
    return {
      platform_order_id: String(row.platform_order_id || ''),
      shop_id: row.shop_id != null && Number.isFinite(Number(row.shop_id)) ? Number(row.shop_id) : null,
      shop_name: String(row.shop_name || ''),
      market: mkt,
      currency: cur,
      original_currency: cur,
      original_amount: Number(raw.toFixed(rawDecimals)),
      amount: Number(raw.toFixed(rawDecimals)),
      usd_amount: usd,
      usd_pending: money.usd_pending,
      exchange_rate,
      cny_amount: cnyAmount != null ? Number(cnyAmount.toFixed(2)) : null,
      missing_rate: missingRate,
      items: it,
      is_large_order: isLargeOrderUsd(usd),
      is_multi_item: isMultiItem(it),
      is_sample: String(row.analytics_status || '').trim().toLowerCase() === 'sample',
      market_color: marketColorHex(mkt),
      order_level,
      created_at_platform: row.created_at_platform
        ? row.created_at_platform instanceof Date
          ? formatMysqlDateTime(row.created_at_platform)
          : String(row.created_at_platform)
        : '',
    };
  });

  logDashboardContract('orders', contract, {
    rows: out.length,
    orders: out.length,
    filterHash: where.filterHash,
    usedMarketField: where.usedMarketField,
    usedStatusField: where.usedStatusField,
    usedDateField: where.usedDateField,
    sqlTag: 'realtime_orders_limit',
  });
  logDashboardPerfProbe({
    endpoint: 'orders',
    filterHash: where.filterHash,
    cache: 'miss',
    durationMs: Date.now() - probeT0,
    sqlMs,
    rows: out.length,
    tenantId,
    shopId: contract.shopId,
    market: contract.market,
    orderFilter: contract.orderFilter,
    timeRange: contract.timeRange,
    usedStatusField: where.usedStatusField,
    sqlTag: 'realtime_orders_limit',
  });
  return out;
}

/**
 * @param {number} tenantId
 * @param {Record<string, string>} q
 * @param {object} auth
 */
async function queryDashboardRealtimeOrders(tenantId, q, auth) {
  const contract = parseDashboardFilterQuery(q, tenantId);
  const limit = Math.min(50, Math.max(1, Number(q.limit) || 50));
  const dedupeKey = buildOrdersDedupeKey(tenantId, contract, limit);
  return withInFlightDedupe(dedupeKey, () => queryDashboardRealtimeOrdersUncached(tenantId, q, auth), 3000);
}

module.exports = { queryDashboardRealtimeOrders, queryDashboardRealtimeOrdersUncached };
