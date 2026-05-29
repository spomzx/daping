#!/usr/bin/env node
'use strict';

/**
 * 店铺今日单/GMV 口径诊断（shop_id / platform_shop_id）
 *
 *   node backend/scripts/diagnose-shop-today-kpi.js --shop-id=21
 *   node backend/scripts/diagnose-shop-today-kpi.js --platform-shop-id=8646954221409830843 --tenant-id=6
 */

const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const { getMysqlPool } = require('../db/mysqlPool');
const { orderAnalyticsEventTimeExpr } = require('../modules/dashboard/filterContract');
const {
  queryTodayMetricsByShopForTenant,
  queryTodayMetricsForShopId,
  enforceTodayMetricsInvariant,
} = require('../modules/dashboard/todayMetricsQuery');

function parseArgs(argv) {
  let shopId = null;
  let platformShopId = null;
  let tenantId = null;
  for (const a of argv) {
    if (a.startsWith('--shop-id=')) shopId = Number(a.split('=')[1]);
    else if (a.startsWith('--platform-shop-id=')) platformShopId = String(a.split('=')[1]).trim();
    else if (a.startsWith('--tenant-id=')) tenantId = Number(a.split('=')[1]);
  }
  return { shopId, platformShopId, tenantId };
}

async function loadShop(pool, { shopId, platformShopId, tenantId }) {
  if (shopId != null && Number.isFinite(shopId)) {
    const [rows] = await pool.query('SELECT * FROM shops WHERE id = ? LIMIT 1', [shopId]);
    return rows?.[0] || null;
  }
  if (platformShopId) {
    const params = [platformShopId];
    let sql = `SELECT * FROM shops WHERE LOWER(TRIM(platform_shop_id)) = LOWER(TRIM(?))`;
    if (tenantId != null && Number.isFinite(tenantId)) {
      sql += ' AND tenant_id = ?';
      params.push(tenantId);
    }
    sql += ' LIMIT 1';
    const [rows] = await pool.query(sql, params);
    return rows?.[0] || null;
  }
  return null;
}

async function ordersDetailToday(pool, shop, tenantId) {
  const pack = await queryTodayMetricsForShopId(pool, tenantId, Number(shop.id));
  const n = enforceTodayMetricsInvariant(pack);
  return {
    order_count: n.today_orders,
    gmv_sum: n.today_gmv,
  };
}

async function readSnapshotGmv(tenantId, platformShopId) {
  const base = path.join(__dirname, '../storage/dashboard-snapshot');
  const out = { gmv_compare: null, files_scanned: [] };
  const tenantDir = path.join(base, `tenant-${tenantId}`);
  if (!fs.existsSync(tenantDir)) return out;

  const gmvDir = path.join(tenantDir, 'gmv-compare');
  if (fs.existsSync(gmvDir)) {
    const files = fs.readdirSync(gmvDir).filter((f) => f.endsWith('.json'));
    for (const f of files.slice(0, 20)) {
      out.files_scanned.push(path.join('gmv-compare', f));
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(gmvDir, f), 'utf8'));
        const shops = raw?.shops || raw?.payload?.shops || raw?.data?.shops;
        if (Array.isArray(shops)) {
          const hit = shops.find(
            (s) =>
              String(s.shopId ?? s.shop_id ?? s.platform_shop_id ?? '')
                .toLowerCase()
                .trim() === String(platformShopId).toLowerCase().trim(),
          );
          if (hit) {
            out.gmv_compare = {
              file: f,
              todayOrders: hit.todayOrders ?? hit.today_orders ?? hit.orders,
              todayGmv: hit.todayGmv ?? hit.gmv ?? hit.shop_gmv,
            };
          }
        }
      } catch {
        /* ignore */
      }
    }
  }
  return out;
}

async function readTableCacheSummary(pool, tenantId) {
  try {
    const [rows] = await pool.query(
      `SELECT cache_key, shop_id, time_range, payload_json, refreshed_at
       FROM dashboard_summary_cache
       WHERE tenant_id = ? AND time_range = 'today'
       ORDER BY refreshed_at DESC
       LIMIT 5`,
      [tenantId],
    );
    return (Array.isArray(rows) ? rows : []).map((r) => ({
      cache_key: r.cache_key,
      shop_id: r.shop_id,
      refreshed_at: r.refreshed_at,
      payload_preview: String(r.payload_json || '').slice(0, 200),
    }));
  } catch (e) {
    if (e?.code === 'ER_NO_SUCH_TABLE') return [];
    throw e;
  }
}

async function simulateListApiFields(pool, shop) {
  const { enrichShopsListWithTodayStats } = require('../modules/shops/shopLiveStatsService');
  const { mergeStatusIntoShopRow, listShopSyncStatusByShopIds } = require('../sync/services/shopSyncStatusService');
  const statusMap = await listShopSyncStatusByShopIds(pool, shop.tenant_id, [shop.id]);
  let row = mergeStatusIntoShopRow(shop, statusMap.get(Number(shop.id)));
  [row] = await enrichShopsListWithTodayStats(pool, [row]);
  return {
    today_orders: row.today_orders,
    today_gmv: row.today_gmv,
    last_order_count: row.last_order_count,
    last_gmv_amount: row.last_gmv_amount,
    stats_source: row.stats_source,
    kpi_trusted: row.kpi_trusted,
    sync_status: row.sync_status,
    last_error: row.last_error ? String(row.last_error).slice(0, 80) : null,
    last_error_full: row.last_error_full,
  };
}

async function main() {
  const pool = getMysqlPool();
  if (!pool) {
    console.error('[diagnose-shop-today-kpi] 无 MySQL');
    process.exit(2);
  }

  const shop = await loadShop(pool, parseArgs(process.argv.slice(2)));
  if (!shop) {
    console.error('[diagnose-shop-today-kpi] 未找到店铺');
    process.exit(1);
  }

  const tenantId = Number(shop.tenant_id);
  const evt = orderAnalyticsEventTimeExpr('o');

  const [detail, aggPack, perShop, syncRow, apiSim, snap, tableCache] = await Promise.all([
    ordersDetailToday(pool, shop, tenantId),
    queryTodayMetricsByShopForTenant(pool, tenantId),
    queryTodayMetricsForShopId(pool, tenantId, Number(shop.id)),
    pool
      .query(
        `SELECT sync_status, last_error, last_success_sync_at, sync_fail_count
         FROM shop_sync_status WHERE shop_id = ? AND tenant_id = ? LIMIT 1`,
        [shop.id, tenantId],
      )
      .then(([r]) => r?.[0] || null),
    simulateListApiFields(pool, shop),
    readSnapshotGmv(tenantId, shop.platform_shop_id),
    readTableCacheSummary(pool, tenantId),
  ]);

  const fromAgg = enforceTodayMetricsInvariant(
    aggPack.byShopId.get(Number(shop.id)) ||
      aggPack.byPlatformId.get(String(shop.platform_shop_id || '').toLowerCase()) ||
      { today_orders: 0, today_gmv: 0 },
  );
  const perShopNorm = enforceTodayMetricsInvariant(perShop || { today_orders: 0, today_gmv: 0 });

  const report = {
    shop_id: shop.id,
    platform_shop_id: shop.platform_shop_id,
    shop_name: shop.display_name || shop.shop_name,
    tenant_id: tenantId,
    event_time_expr: evt,
    date_window: 'CURDATE',
    shops_table_stale: {
      last_order_count: Number(shop.last_order_count) || 0,
      last_gmv_amount: Number(shop.last_gmv_amount) || 0,
    },
    orders_mysql_today: {
      order_count: Number(detail.order_count) || 0,
      gmv_sum: Number(detail.gmv_sum) || 0,
    },
    aggregate_today_stats: fromAgg,
    per_shop_fallback: perShopNorm,
    shop_sync_status: syncRow,
    dashboard_summary_cache_rows: tableCache,
    deprecated_snapshot: snap,
    list_api_simulation: apiSim,
    mismatch_flags: [],
  };

  const o = report.orders_mysql_today.order_count;
  const g = report.orders_mysql_today.gmv_sum;
  if (o <= 0 && g > 0) report.mismatch_flags.push('mysql_orders_zero_gmv_positive');
  if (
    Number(shop.last_order_count) <= 0 &&
    Number(shop.last_gmv_amount) > 0
  ) {
    report.mismatch_flags.push('shops_table_stale_gmv_without_orders');
  }
  if (
    Number(apiSim.today_orders) <= 0 &&
    Number(apiSim.today_gmv) > 0
  ) {
    report.mismatch_flags.push('api_sim_orders_zero_gmv_positive');
  }

  console.log(JSON.stringify(report, null, 2));
}

main().catch((e) => {
  console.error('[diagnose-shop-today-kpi] fatal', e);
  process.exit(1);
});
