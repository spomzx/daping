#!/usr/bin/env node
'use strict';

/**
 * 今日订单�?/ GMV 跨接口一致性诊�? *
 *   node backend/scripts/diagnose-today-metrics-consistency.js --tenant-id=6
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const { getMysqlPool } = require('../../db/mysqlPool');
const {
  defaultTodayContract,
  queryTodayMetricsByShopForTenant,
  queryTodayMetricsForShopId,
  queryTodayMetricsTenantTotal,
  queryTodayMetricsRankingRows,
  enforceTodayMetricsInvariant,
} = require('../../modules/dashboard/todayMetricsQuery');
const { enrichShopsListWithTodayStats } = require('../../modules/shops/shopLiveStatsService');
const { mergeStatusIntoShopRow, listShopSyncStatusByShopIds } = require('../../sync/services/shopSyncStatusService');

function parseArgs(argv) {
  let tenantId = null;
  for (const a of argv) {
    if (a.startsWith('--tenant-id=')) tenantId = Number(a.split('=')[1]);
  }
  return { tenantId };
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function checkConsistency(row) {
  const reasons = [];
  const o = num(row.orders_table_count);
  const g = num(row.orders_table_gmv);
  const spO = num(row.shop_panel_today_orders);
  const spG = num(row.shop_panel_today_gmv);
  const dO = num(row.dashboard_today_orders);
  const dG = num(row.dashboard_today_gmv);
  const rO = num(row.ranking_today_orders);
  const rG = num(row.ranking_today_gmv);

  if (o <= 0 && g > 0) reasons.push('orders_zero_gmv_positive');
  if (spO <= 0 && spG > 0) reasons.push('shop_panel_orders_zero_gmv_positive');
  if (o !== spO || Math.abs(g - spG) > 0.02) reasons.push('shop_panel_vs_orders_table');
  if (o !== dO) reasons.push('dashboard_vs_orders_table_orders');
  if (Math.abs(g - dG) > 0.02) reasons.push('dashboard_vs_orders_table_gmv');
  if (o !== rO) reasons.push('ranking_vs_orders_table_orders');
  if (Math.abs(g - rG) > 0.02) reasons.push('ranking_vs_orders_table_gmv');

  return {
    is_consistent: reasons.length === 0,
    inconsistency_reason: reasons.length ? reasons.join(';') : null,
  };
}

async function main() {
  const { tenantId } = parseArgs(process.argv.slice(2));
  if (!Number.isFinite(tenantId) || tenantId <= 0) {
    console.error('用法: --tenant-id=6');
    process.exit(1);
  }

  const pool = getMysqlPool();
  if (!pool) {
    console.error('[diagnose-today-metrics] �?MySQL');
    process.exit(2);
  }

  const contract = defaultTodayContract(tenantId);

  const [shopRows] = await pool.query(
    `SELECT id, tenant_id, platform_shop_id, shop_name, display_name, market, region, status, hidden, sync_enabled,
            last_order_count, last_gmv_amount
     FROM shops WHERE tenant_id = ? AND status <> 'deleted' ORDER BY id`,
    [tenantId],
  );
  const shops = Array.isArray(shopRows) ? shopRows : [];

  const [lockedByShop, tenantTotal, rankingRows] = await Promise.all([
    queryTodayMetricsByShopForTenant(pool, tenantId),
    queryTodayMetricsTenantTotal(pool, tenantId, contract, {}),
    queryTodayMetricsRankingRows(pool, tenantId, contract, {}),
  ]);

  const rankingByShop = new Map();
  for (const r of rankingRows) rankingByShop.set(Number(r.shop_id), r);

  const statusMap = await listShopSyncStatusByShopIds(
    pool,
    tenantId,
    shops.map((s) => Number(s.id)).filter(Boolean),
  );
  let panelRows = shops.map((s) => mergeStatusIntoShopRow(s, statusMap.get(Number(s.id))));
  panelRows = await enrichShopsListWithTodayStats(pool, panelRows);
  const panelById = new Map(panelRows.map((r) => [Number(r.id), r]));

  const reportShops = [];
  let inconsistent = 0;

  for (const shop of shops) {
    const sid = Number(shop.id);
    const locked =
      lockedByShop.byShopId.get(sid) ||
      (await queryTodayMetricsForShopId(pool, tenantId, sid));
    const normalized = enforceTodayMetricsInvariant(locked);
    const panel = panelById.get(sid) || {};
    const rank = rankingByShop.get(sid) || { orders: 0, gmv: 0 };

    const row = {
      shop_id: sid,
      platform_shop_id: shop.platform_shop_id,
      shop_name: shop.display_name || shop.shop_name,
      market: shop.market || shop.region,
      orders_table_count: normalized.today_orders,
      orders_table_gmv: normalized.today_gmv,
      shops_row_stale: {
        last_order_count: num(shop.last_order_count),
        last_gmv_amount: num(shop.last_gmv_amount),
      },
      shop_panel_today_orders: num(panel.today_orders),
      shop_panel_today_gmv: num(panel.today_gmv),
      dashboard_today_orders: normalized.today_orders,
      dashboard_today_gmv: normalized.today_gmv,
      ranking_today_orders: num(rank.orders),
      ranking_today_gmv: num(rank.gmv),
      sync_status: panel.sync_status || null,
      health_status: panel.health_status || panel.last_health_status || null,
    };

    const chk = checkConsistency(row);
    row.is_consistent = chk.is_consistent;
    row.inconsistency_reason = chk.inconsistency_reason;
    if (!chk.is_consistent) inconsistent += 1;
    reportShops.push(row);
  }

  const summary = {
    tenant_id: tenantId,
    locked_source: 'mysql_orders_intraday',
    shop_count: shops.length,
    inconsistent_shop_count: inconsistent,
    tenant_dashboard_total: {
      orders: tenantTotal.orders,
      gmv: tenantTotal.gmv,
    },
    shops: reportShops,
    acceptance: {
      no_zero_orders_positive_gmv: !reportShops.some(
        (r) => num(r.shop_panel_today_orders) <= 0 && num(r.shop_panel_today_gmv) > 0,
      ),
      all_consistent: inconsistent === 0,
    },
  };

  console.log(JSON.stringify(summary, null, 2));
  process.exit(summary.acceptance.all_consistent ? 0 : 1);
}

main().catch((e) => {
  console.error('[diagnose-today-metrics] fatal', e);
  process.exit(1);
});
