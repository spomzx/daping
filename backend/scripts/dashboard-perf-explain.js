#!/usr/bin/env node
'use strict';

/**
 * Dashboard SQL EXPLAIN 探测（只读，不改数据）。
 *
 * 用法（staging）:
 *   cd backend && DASHBOARD_PERF_PROBE=1 node scripts/dashboard-perf-explain.js --tenantId=6
 *
 * 需配置 DB_* 环境变量（与 server 相同）。
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });

const { getMysqlPool } = require('../db/mysqlPool');
const { isMysqlConfigured } = require('../config/database');
const {
  parseDashboardFilterQuery,
  buildDashboardWhere,
  dashboardWhereParams,
  dashboardOrderCountExpr,
  orderAnalyticsEventTimeExpr,
} = require('../modules/dashboard/filterContract');
const { buildOrderFilterWhere } = require('../modules/dashboard/filterBuilder');

const SCENARIOS = [
  { orderFilter: 'all', timeRange: 'today', market: 'ALL' },
  { orderFilter: 'paid', timeRange: 'today', market: 'ALL' },
  { orderFilter: 'valid', timeRange: 'today', market: 'ALL' },
  { orderFilter: 'paid', timeRange: 'yesterday', market: 'ALL' },
  { orderFilter: 'paid', timeRange: 'today', market: 'TH' },
];

function argNum(name, fallback) {
  const m = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (!m) return fallback;
  const n = Number(m.split('=')[1]);
  return Number.isFinite(n) ? n : fallback;
}

async function explain(pool, label, sql, params) {
  const [plan] = await pool.query(`EXPLAIN ${sql}`, params);
  const row = Array.isArray(plan) && plan[0] ? plan[0] : {};
  console.log(
    [
      '[explain]',
      `tag=${label}`,
      `type=${row.type || ''}`,
      `key=${row.key || ''}`,
      `rows=${row.rows ?? ''}`,
      `Extra=${row.Extra || ''}`,
    ].join(' '),
  );
}

async function runScenario(pool, tenantId, sc) {
  const q = {
    shopId: 'all',
    market: sc.market,
    orderFilter: sc.orderFilter,
    timeRange: sc.timeRange,
    range: sc.timeRange,
  };
  const contract = parseDashboardFilterQuery(q, tenantId);
  const where = await buildDashboardWhere(pool, tenantId, contract, { alias: 'o' });
  if (where.invalidShop) {
    console.log('[explain] skip invalidShop', sc);
    return;
  }
  const params = dashboardWhereParams(where);
  const st = buildOrderFilterWhere(contract.orderFilter, 'o');
  console.log(
    `\n=== scenario orderFilter=${sc.orderFilter} timeRange=${sc.timeRange} market=${sc.market} usedStatusField=${where.usedStatusField} ===`,
  );

  const summarySql = `
    SELECT ${dashboardOrderCountExpr('o')} AS orders, COALESCE(SUM(o.total_amount), 0) AS gmv_native
    FROM orders o WHERE 1=1 ${where.sql} LIMIT 1`;
  await explain(pool, 'summary_orders_distinct_id', summarySql, params);

  const rankingSql = `
    SELECT o.shop_id, ${dashboardOrderCountExpr('o')} AS orders
    FROM orders o WHERE o.shop_id IS NOT NULL ${where.sql}
    GROUP BY o.shop_id LIMIT 30`;
  await explain(pool, 'ranking_shop_orders_distinct_id', rankingSql, params);

  const ordersSql = `
    SELECT o.id FROM orders o WHERE 1=1 ${where.sql}
    ORDER BY COALESCE(o.paid_at, o.created_at_platform, o.created_at) DESC LIMIT 50`;
  await explain(pool, 'realtime_orders_limit', ordersSql, params);

  const evt = orderAnalyticsEventTimeExpr('o');
  const trendSql = `
    SELECT DATE_FORMAT(${evt}, '%Y-%m-%d %H:00:00') AS time, COUNT(DISTINCT o.platform_order_id) AS orders
    FROM orders o WHERE 1=1 ${where.sql}
    GROUP BY DATE_FORMAT(${evt}, '%Y-%m-%d %H:00:00') ORDER BY time ASC LIMIT 48`;
  await explain(pool, 'trend_hour_dateformat_group', trendSql, params);

  if (st.sql) {
    console.log(`[explain] orderFilterWhere snippet=${st.sql.slice(0, 200)} statusField=${st.statusField}`);
  }
}

async function main() {
  if (!isMysqlConfigured()) {
    console.error('DB_* 未配置，无法 EXPLAIN');
    process.exit(1);
  }
  const pool = getMysqlPool();
  const tenantId = argNum('tenantId', 6);
  console.log('[explain] tenantId=', tenantId);
  for (const sc of SCENARIOS) {
    await runScenario(pool, tenantId, sc);
  }
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
