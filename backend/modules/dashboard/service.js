'use strict';

const { getMysqlPool } = require('../../db/mysqlPool');
const { getTimeRangeBounds, normalizeRange } = require('../../lib/dashboardTimeRange');
const { orderAnalyticsEventTimeExpr } = require('../../lib/analyticsFilter');
const {
  resolveOrderCurrency,
  amountToUsdWithStatus,
  preloadUsdRates,
} = require('../../lib/orderRowMoney');
const analyticsSvc = require('../analytics/service');
const repo = require('./repository');

function ensurePool() {
  const pool = getMysqlPool();
  if (!pool) {
    const err = new Error('mysql_unavailable');
    err.code = 'mysql_unavailable';
    throw err;
  }
  return pool;
}

async function getSummary(tenantId, q, auth) {
  const pool = ensurePool();
  return repo.querySummary(pool, tenantId, q, auth);
}

function formatTrendHourLabel(timeStr) {
  const s = String(timeStr || '').trim();
  const m = /\s(\d{2}):00:00$/.exec(s) || /^(\d{2}):00/.exec(s);
  if (m) return `${m[1]}:00`;
  if (s.length >= 16) return s.slice(11, 16);
  return s || '00:00';
}

function currentHourLabel() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:00`;
}

function normalizeTrendRows(rows) {
  return (Array.isArray(rows) ? rows : []).map((r) => ({
    hour: formatTrendHourLabel(r.time),
    gmv_usd: Number(Number(r.gmv || 0).toFixed(2)),
    order_count: Number(r.orders) || 0,
    time: r.time,
    orders: r.orders,
    gmv: r.gmv,
    gmv_currency: r.gmv_currency || 'USD',
    items: r.items,
  }));
}

/**
 * 与 summary 同窗口聚合今日 GMV(USD) / 订单数（MySQL 单点快照，非 cache/json fallback）
 */
async function queryTodayUsdTotals(pool, tenantId, q, auth) {
  const rangeNorm = normalizeRange(q.range || 'today');
  const tb = getTimeRangeBounds(rangeNorm, q.startDate, q.endDate);
  const fo = repo.afOpts(auth);
  const af = await require('../../lib/analyticsFilter').buildAnalyticsFilter(
    pool,
    tenantId,
    {
      ...q,
      range: rangeNorm,
      analytics_time_from_epoch_sec: tb.startSec,
      analytics_time_until_epoch_sec: tb.endSec,
    },
    fo,
  );
  if (af.invalidShop) {
    return { todayGmvUsd: 0, todayOrders: 0 };
  }

  const evt = orderAnalyticsEventTimeExpr('o');
  const [rows] = await pool.query(
    `
    SELECT
      UPPER(COALESCE(NULLIF(TRIM(o.currency), ''), '')) AS line_currency,
      UPPER(COALESCE(NULLIF(TRIM(o.market), ''), '')) AS market,
      COUNT(DISTINCT o.platform_order_id) AS orders,
      COALESCE(SUM(o.total_amount), 0) AS gmv
    FROM orders o
    WHERE 1=1${af.sql}
    GROUP BY UPPER(COALESCE(NULLIF(TRIM(o.currency), ''), '')), UPPER(COALESCE(NULLIF(TRIM(o.market), ''), ''))
    `,
    af.params,
  );

  const list = Array.isArray(rows) ? rows : [];
  const curSet = list.map((row) => resolveOrderCurrency(row));
  const rates = await preloadUsdRates([...curSet, 'USD', 'THB', 'MYR', 'VND', 'PHP', 'SGD']);

  let todayGmvUsd = 0;
  let todayOrders = 0;
  for (const row of list) {
    const cur = resolveOrderCurrency(row);
    const gmv = Number(row.gmv) || 0;
    const { usd, usd_pending } = amountToUsdWithStatus(gmv, cur, rates);
    if (!usd_pending && usd != null) todayGmvUsd += usd;
    todayOrders += Number(row.orders) || 0;
  }

  return {
    todayGmvUsd: Number(todayGmvUsd.toFixed(2)),
    todayOrders,
  };
}

function buildFallbackTrendList(todayGmvUsd, todayOrders) {
  if (!(todayGmvUsd > 0) && !(todayOrders > 0)) return [];
  return [
    {
      hour: currentHourLabel(),
      gmv_usd: Number(todayGmvUsd.toFixed(2)),
      order_count: todayOrders,
      time: new Date().toISOString(),
      orders: todayOrders,
      gmv: todayGmvUsd,
      gmv_currency: 'USD',
      items: 0,
      _mysql_hour_snapshot: true,
    },
  ];
}

async function getTrend(tenantId, q, auth) {
  ensurePool();
  const src = q && typeof q === 'object' ? q : {};
  const merged = {
    ...src,
    range: src.range ?? 'today',
    hours: src.hours ?? 24,
    groupBy: src.groupBy ?? src.group_by ?? 'hour',
  };

  let rows = await analyticsSvc.getShopTrend(tenantId, merged, auth);
  let list = normalizeTrendRows(rows);
  const hasData = list.some((p) => p.gmv_usd > 0 || p.order_count > 0);

  if (!hasData) {
    const pool = getMysqlPool();
    const totals = await queryTodayUsdTotals(pool, tenantId, merged, auth);
    if (totals.todayGmvUsd > 0 || totals.todayOrders > 0) {
      list = buildFallbackTrendList(totals.todayGmvUsd, totals.todayOrders);
    }
  }

  return list;
}

async function getRanking(tenantId, q, auth) {
  ensurePool();
  const rows = await analyticsSvc.getTopShops(tenantId, q, auth);
  return { items: rows, source: 'mysql' };
}

module.exports = { getSummary, getTrend, getRanking };
