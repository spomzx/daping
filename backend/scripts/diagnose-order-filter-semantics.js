#!/usr/bin/env node
'use strict';

/**
 * 订单筛选语义诊断（paid vs valid 分离）
 *
 *   node scripts/diagnose-order-filter-semantics.js --tenant-id=6 --date=2026-05-25
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const { getMysqlPool } = require('../db/mysqlPool');
const {
  parseDashboardFilterQuery,
  buildDashboardWhere,
  dashboardWhereParams,
  dashboardOrderCountExpr,
  contractForDashboardApi,
} = require('../modules/dashboard/filterContract');
const {
  describeMysqlDashboardOrderFilterClause,
  DASHBOARD_ORDER_FILTER_SEMANTICS,
  LOCKED_KPI_ORDER_FILTER,
} = require('../lib/orderFilter');
const { buildIndexFriendlyEventTimeWhere } = require('../modules/dashboard/filterContract');
const { getTimeRangeBounds, parseYmd } = require('../lib/dashboardTimeRange');

const BUTTON_ORDER = ['all', 'valid', 'paid', 'unpaid', 'sample', 'cancelled'];
const DEFAULT_ORDER_FILTER = 'valid';

function parseArgs(argv) {
  let tenantId = null;
  let dateYmd = null;
  for (const a of argv) {
    if (a.startsWith('--tenant-id=')) tenantId = Number(a.split('=')[1]);
    else if (a.startsWith('--date=')) dateYmd = String(a.split('=')[1] || '').trim();
  }
  return { tenantId, dateYmd };
}

/**
 * @param {import('mysql2/promise').Pool} pool
 * @param {number} tenantId
 * @param {string} orderFilter
 * @param {number} startSec
 * @param {number} endSec
 */
/**
 * @param {import('mysql2/promise').Pool} pool
 * @param {number} tenantId
 * @param {string} orderFilter
 * @param {string} startYmd
 */
async function countOrdersForFilter(pool, tenantId, orderFilter, startYmd) {
  const contract = contractForDashboardApi(
    parseDashboardFilterQuery(
      {
        timeRange: 'custom',
        startDate: startYmd,
        endDate: startYmd,
        shopId: 'all',
        market: 'ALL',
        orderFilter,
      },
      tenantId,
    ),
  );
  const st = await buildDashboardWhere(pool, tenantId, contract, {});
  if (st.invalidShop || st.emptyScope) return { count: 0, where: st };

  const sql = `SELECT ${dashboardOrderCountExpr('o')} AS c FROM orders o WHERE o.tenant_id = ? AND o.shop_id IS NOT NULL ${st.sql || ''}`;
  const params = [tenantId, ...dashboardWhereParams(st)];
  const [rows] = await pool.query(sql, params);
  const row = Array.isArray(rows) && rows[0] ? rows[0] : null;
  return { count: Number(row?.c) || 0, where: st };
}

async function countCancelledPaid(pool, tenantId, startSec, endSec) {
  const tw = buildIndexFriendlyEventTimeWhere('o', startSec, endSec);
  const [rows] = await pool.query(
    `SELECT COUNT(DISTINCT o.id) AS c
     FROM orders o
     WHERE o.tenant_id = ?
       AND o.shop_id IS NOT NULL
       ${tw.sql}
       AND o.analytics_status = 'cancelled'
       AND COALESCE(o.total_amount, 0) > 0`,
    [tenantId, ...tw.params],
  );
  return Number(rows?.[0]?.c) || 0;
}

async function main() {
  const { tenantId, dateYmd } = parseArgs(process.argv.slice(2));
  if (!Number.isFinite(tenantId) || tenantId <= 0) {
    console.error('用法: node scripts/diagnose-order-filter-semantics.js --tenant-id=6 --date=2026-05-25');
    process.exit(1);
  }

  const pool = getMysqlPool();
  if (!pool) {
    console.error('[diagnose-order-filter-semantics] 无 MySQL');
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
    console.error('无效 --date');
    process.exit(1);
  }
  const startYmd = `${parsed.y}-${String(parsed.mo).padStart(2, '0')}-${String(parsed.d).padStart(2, '0')}`;
  const bounds = getTimeRangeBounds('custom', startYmd, startYmd);

  const filters = {};
  for (const f of BUTTON_ORDER) {
    const desc = describeMysqlDashboardOrderFilterClause(f);
    filters[f] = desc.summary;
  }

  const all = await countOrdersForFilter(pool, tenantId, 'all', startYmd);
  const valid = await countOrdersForFilter(pool, tenantId, 'valid', startYmd);
  const paid = await countOrdersForFilter(pool, tenantId, 'paid', startYmd);
  const unpaid = await countOrdersForFilter(pool, tenantId, 'unpaid', startYmd);
  const sample = await countOrdersForFilter(pool, tenantId, 'sample', startYmd);
  const cancelled = await countOrdersForFilter(pool, tenantId, 'cancelled', startYmd);

  const cancelledPaid = await countCancelledPaid(pool, tenantId, bounds.startSec, bounds.endSec);

  const valid_count = valid.count;
  const paid_count = paid.count;
  const paid_greater_or_equal_valid = paid_count >= valid_count;
  const paid_not_equal_valid_when_cancelled_paid_exists =
    cancelledPaid > 0 ? paid_count > valid_count : true;
  const paid_includes_cancelled_paid = cancelledPaid > 0 && paid_count > valid_count;

  const kpi_default_unchanged = LOCKED_KPI_ORDER_FILTER === 'valid';

  const ok =
    paid_greater_or_equal_valid &&
    paid_not_equal_valid_when_cancelled_paid_exists &&
    all.count >= paid_count &&
    paid_count >= valid_count &&
    kpi_default_unchanged &&
    (cancelledPaid === 0 || paid_count > valid_count);

  const report = {
    ok,
    tenant_id: tenantId,
    date: startYmd,
    default_order_filter: DEFAULT_ORDER_FILTER,
    button_order: BUTTON_ORDER,
    kpi_locked_order_filter: LOCKED_KPI_ORDER_FILTER,
    kpi_default_unchanged,
    all_count: all.count,
    valid_count,
    paid_count,
    unpaid_count: unpaid.count,
    sample_count: sample.count,
    cancelled_count: cancelled.count,
    cancelled_paid_with_amount_count: cancelledPaid,
    paid_includes_cancelled_paid,
    paid_greater_or_equal_valid,
    paid_not_equal_valid_when_cancelled_paid_exists,
    filters,
    filter_semantics_doc: DASHBOARD_ORDER_FILTER_SEMANTICS,
    notes: [
      'valid = KPI 默认口径（analytics_status=valid）',
      'paid = valid ∪ (cancelled 且 amount>0 或 paid_at)，排除 sample/unpaid',
      cancelledPaid > 0
        ? `当日有 ${cancelledPaid} 笔已付款后取消，paid 应大于 valid`
        : '当日无「已付款后取消」样本，paid 可能等于 valid',
    ],
  };

  console.log(JSON.stringify(report, null, 2));
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error('[diagnose-order-filter-semantics] fatal', e);
  process.exit(1);
});
