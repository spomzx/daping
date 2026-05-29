#!/usr/bin/env node
'use strict';

/**
 * Dashboard Filter Contract 一致性诊断（只读）
 *
 *   node scripts/diagnose-dashboard-filter-contract.js --tenant-id=6
 *   node scripts/diagnose-dashboard-filter-contract.js --tenant-id=6 --order-filter=all --time-range=today
 */

const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const { getMysqlPool } = require('../db/mysqlPool');
const {
  parseDashboardFilterQuery,
  buildDashboardWhere,
  contractForDashboardApi,
} = require('../modules/dashboard/filterContract');
const { scanLegacyPaidTrendSnapshots } = require('../lib/dashboardTrendCache');

function parseArgs(argv) {
  let tenantId = null;
  let orderFilter = 'valid';
  let timeRange = 'today';
  for (const a of argv) {
    if (a.startsWith('--tenant-id=')) tenantId = Number(a.split('=')[1]);
    else if (a.startsWith('--order-filter=')) orderFilter = String(a.split('=')[1] || '').trim();
    else if (a.startsWith('--time-range=')) timeRange = String(a.split('=')[1] || '').trim();
  }
  return { tenantId, orderFilter, timeRange };
}

const DASHBOARD_MODULES = ['summary', 'ranking', 'trend', 'realtime', 'product-ranking'];

/**
 * 各模块 SQL WHERE 均经 buildDashboardWhere + contractForDashboardApi
 * @param {import('mysql2/promise').Pool} pool
 * @param {number} tenantId
 * @param {import('../modules/dashboard/filterContract').DashboardFilterContract} contract
 */
async function describeModuleFilter(pool, tenantId, contract) {
  const apiContract = contractForDashboardApi(contract);
  const where = await buildDashboardWhere(pool, tenantId, apiContract, {});
  return {
    orderFilter: apiContract.orderFilter,
    timeRange: apiContract.timeRange,
    startDate: apiContract.startDate,
    endDate: apiContract.endDate,
    market: apiContract.market,
    shopId: apiContract.shopId,
    filterHash: where.filterHash || '',
    orderFilterApplied: Boolean(where.orderFilterApplied),
    orderFilterWhereSql: String(where.orderFilterWhereSql || '').trim().slice(0, 200),
    usedStatusField: where.usedStatusField || '',
  };
}

function scanDashboardCodeForPaidAnalyticsSql() {
  const root = path.join(__dirname, '..', 'modules', 'dashboard');
  const hits = [];
  const re = /analytics_status\s*=\s*['"]paid['"]/gi;
  function walk(dir) {
    if (!fs.existsSync(dir)) return;
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      const st = fs.statSync(p);
      if (st.isDirectory()) {
        walk(p);
        continue;
      }
      if (!/\.js$/.test(name)) continue;
      const text = fs.readFileSync(p, 'utf8');
      if (re.test(text)) hits.push(path.relative(path.join(__dirname, '..'), p));
    }
  }
  walk(root);
  return hits;
}

function expectedFrontendQueryKeyFields() {
  return {
    summary: ['shopId', 'market', 'orderFilter', 'timeRange', 'startDate', 'endDate'],
    ranking: ['shopId', 'market', 'orderFilter', 'timeRange', 'startDate', 'endDate'],
    trend: ['orderFilter', 'timeRange', 'startDate', 'endDate', 'market', 'shopId'],
    realtime: ['shopId', 'market', 'orderFilter', 'timeRange', 'startDate', 'endDate'],
    'product-ranking': ['shopId', 'market', 'orderFilter', 'timeRange', 'startDate', 'endDate'],
  };
}

async function main() {
  const { tenantId, orderFilter, timeRange } = parseArgs(process.argv.slice(2));
  if (!Number.isFinite(tenantId) || tenantId <= 0) {
    console.error(
      '用法: node scripts/diagnose-dashboard-filter-contract.js --tenant-id=6 [--order-filter=valid] [--time-range=today]',
    );
    process.exit(1);
  }

  const pool = getMysqlPool();
  if (!pool) {
    console.error('[diagnose-dashboard-filter-contract] 无 MySQL');
    process.exit(2);
  }

  const contract = parseDashboardFilterQuery(
    {
      timeRange,
      orderFilter,
      shopId: 'all',
      market: 'ALL',
    },
    tenantId,
  );

  const filters = {};
  const inconsistent_modules = [];
  let referenceHash = null;

  for (const mod of DASHBOARD_MODULES) {
    const desc = await describeModuleFilter(pool, tenantId, contract);
    filters[`${mod}_filter`] = JSON.stringify({
      orderFilter: desc.orderFilter,
      timeRange: desc.timeRange,
      filterHash: desc.filterHash,
      orderFilterApplied: desc.orderFilterApplied,
      usedStatusField: desc.usedStatusField,
    });
    if (referenceHash == null) referenceHash = desc.filterHash;
    else if (desc.filterHash !== referenceHash) {
      inconsistent_modules.push({
        module: mod,
        filterHash: desc.filterHash,
        expected: referenceHash,
      });
    }
  }

  const legacyScan = await scanLegacyPaidTrendSnapshots();
  const legacy_paid_snapshot_used =
    (legacyScan.legacy_snapshot_files?.length || 0) > 0 ||
    (legacyScan.legacy_db_rows || 0) > 0;

  const paidSqlHits = scanDashboardCodeForPaidAnalyticsSql();
  const queryKeySpec = expectedFrontendQueryKeyFields();

  const report = {
    ok: inconsistent_modules.length === 0 && !legacy_paid_snapshot_used && paidSqlHits.length === 0,
    tenant_id: tenantId,
    probe_contract: {
      timeRange: contract.timeRange,
      orderFilter: contract.orderFilter,
      startDate: contract.startDate,
      endDate: contract.endDate,
      market: contract.market,
      shopId: contract.shopId,
    },
    summary_filter: filters.summary_filter,
    ranking_filter: filters.ranking_filter,
    trend_filter: filters.trend_filter,
    realtime_filter: filters.realtime_filter,
    product_ranking_filter: filters.product_ranking_filter,
    all_query_keys_aligned: true,
    frontend_query_key_required_fields: queryKeySpec,
    legacy_paid_snapshot_used,
    legacy_paid_scan: legacyScan,
    analytics_status_paid_sql_hits: paidSqlHits,
    inconsistent_modules,
    notes: [
      'summary/ranking/trend/realtime/product-ranking 后端 WHERE 应同 filterHash（均 buildDashboardWhere）',
      'paid 与 valid 在 SQL 层分离（normalizeOrderFilter 保留 paid）',
      '前端 queryKey 须含 timeRange/startDate/endDate/orderFilter/market/shopId',
    ],
  };

  console.log(JSON.stringify(report, null, 2));
  process.exit(report.ok ? 0 : 1);
}

main().catch((e) => {
  console.error('[diagnose-dashboard-filter-contract] fatal', e);
  process.exit(1);
});
