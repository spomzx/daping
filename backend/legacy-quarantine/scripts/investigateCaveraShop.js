'use strict';

/**
 * Cavera Jewelry 数据链路排查
 * 用法：cd backend && node scripts/investigateCaveraShop.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../', '.env') });

const fs = require('fs');
const path = require('path');
const dayjs = require('dayjs');
const { getMysqlPool } = require('../../db/mysqlPool');
const { orderAnalyticsEventTimeExpr } = require('../../lib/analyticsFilter');
const { getCreateEpochSec, dedupeOrdersByOrderId } = require('../../tiktok-api/ordersDashboardFromCache');
const { ORDERS_CACHE_PATH, cacheFileStats } = require('../../lib/ordersCachePath');
const { readJsonWithRecovery } = require('../../lib/storageFile');
const { loadOpenApiSyncStateByPlatformShopId } = require('../../modules/shops/shopHealthService');
const { enrichShopRows, shopStatsWindowHours } = require('../../modules/shops/shopLiveStatsService');

const PLATFORM_ID = '7496312889470388950';
const WINDOW_HOURS = shopStatsWindowHours();

async function main() {
  const pool = getMysqlPool();
  if (!pool) {
    console.error('MySQL unavailable');
    process.exit(1);
  }

  const evt = orderAnalyticsEventTimeExpr('o');
  const hours = WINDOW_HOURS;

  const [shopRows] = await pool.query(
    `SELECT id, tenant_id, platform_shop_id, shop_name, display_name, market, region, status
     FROM shops
     WHERE LOWER(TRIM(platform_shop_id)) = ?
        OR shop_name LIKE '%Cavera%'
        OR display_name LIKE '%Cavera%'`,
    [PLATFORM_ID.toLowerCase()],
  );

  console.log('=== SHOPS TABLE ===');
  console.log(JSON.stringify(shopRows, null, 2));

  const shop = shopRows[0];
  const internalId = shop ? Number(shop.id) : null;

  const mysqlStats = await pool.query(
    `
    SELECT
      COUNT(DISTINCT CONCAT(o.platform, ':', o.platform_order_id)) AS today_orders,
      COALESCE(SUM(o.total_amount), 0) AS today_gmv,
      MAX(${evt}) AS latest_order_at
    FROM orders o
    WHERE ${evt} IS NOT NULL
      AND ${evt} >= DATE_SUB(NOW(3), INTERVAL ? HOUR)
      AND (
        o.shop_id = ?
        OR o.shop_id IN (SELECT id FROM shops WHERE LOWER(TRIM(platform_shop_id)) = ?)
        OR EXISTS (
          SELECT 1 FROM shops s
          WHERE s.id = o.shop_id AND LOWER(TRIM(s.platform_shop_id)) = ?
        )
      )
    `,
    [hours, internalId, PLATFORM_ID.toLowerCase(), PLATFORM_ID.toLowerCase()],
  );

  const statusDist = await pool.query(
    `
    SELECT o.order_status, COUNT(*) AS c
    FROM orders o
    LEFT JOIN shops s ON s.id = o.shop_id
    WHERE ${evt} IS NOT NULL
      AND ${evt} >= DATE_SUB(NOW(3), INTERVAL ? HOUR)
      AND (
        LOWER(TRIM(s.platform_shop_id)) = ?
        OR o.shop_id = ?
      )
    GROUP BY o.order_status
    ORDER BY c DESC
    `,
    [hours, PLATFORM_ID.toLowerCase(), internalId],
  );

  const sample = await pool.query(
    `
    SELECT
      o.id, o.shop_id, o.platform, o.platform_order_id, o.total_amount, o.currency,
      o.order_status, o.created_at_platform, o.created_at, o.paid_at, o.updated_at,
      s.platform_shop_id, s.shop_name
    FROM orders o
    LEFT JOIN shops s ON s.id = o.shop_id
    WHERE ${evt} IS NOT NULL
      AND ${evt} >= DATE_SUB(NOW(3), INTERVAL ? HOUR)
      AND (
        LOWER(TRIM(s.platform_shop_id)) = ?
        OR o.shop_id = ?
      )
    ORDER BY ${evt} DESC
    LIMIT 10
    `,
    [hours, PLATFORM_ID.toLowerCase(), internalId],
  );

  const orphanByPlatform = await pool.query(
    `
    SELECT COUNT(*) AS c
    FROM orders o
    LEFT JOIN shops s ON s.id = o.shop_id
    WHERE ${evt} IS NOT NULL
      AND ${evt} >= DATE_SUB(NOW(3), INTERVAL ? HOUR)
      AND LOWER(TRIM(s.platform_shop_id)) = ?
      AND (o.shop_id IS NULL OR o.shop_id <> ?)
    `,
    [hours, PLATFORM_ID.toLowerCase(), internalId],
  );

  const wrongShopId = await pool.query(
    `
    SELECT o.shop_id, s.platform_shop_id, COUNT(*) AS c
    FROM orders o
    LEFT JOIN shops s ON s.id = o.shop_id
    WHERE ${evt} IS NOT NULL
      AND ${evt} >= DATE_SUB(NOW(3), INTERVAL ? HOUR)
      AND (
        LOWER(TRIM(s.platform_shop_id)) = ?
        OR o.shop_id = ?
      )
    GROUP BY o.shop_id, s.platform_shop_id
    `,
    [hours, PLATFORM_ID.toLowerCase(), internalId],
  );

  console.log('\n=== MYSQL WINDOW (24h) ===');
  console.log(
    JSON.stringify(
      {
        window_hours: hours,
        time_expr: 'COALESCE(created_at_platform, created_at, paid_at, updated_at)',
        today_orders: mysqlStats[0][0]?.today_orders,
        today_gmv: mysqlStats[0][0]?.today_gmv,
        latest_order_at: mysqlStats[0][0]?.latest_order_at,
        status_distribution: statusDist[0],
        shop_id_groups: wrongShopId[0],
        orphan_platform_mismatch_count: orphanByPlatform[0][0]?.c,
        sample_orders: sample[0],
      },
      null,
      2,
    ),
  );

  const cacheMeta = cacheFileStats();
  const pack = fs.existsSync(ORDERS_CACHE_PATH)
    ? readJsonWithRecovery(ORDERS_CACHE_PATH, { restore: true }).data || {}
    : {};
  const cutoffSec = Math.floor(Date.now() / 1000) - hours * 3600;
  const orders = Array.isArray(pack.orders) ? pack.orders : [];
  const inWindow = orders.filter((o) => {
    const pid = String(o.shopId ?? o.shop_id ?? '').trim().toLowerCase();
    return pid === PLATFORM_ID.toLowerCase() && getCreateEpochSec(o) >= cutoffSec;
  });
  const { orders: deduped } = dedupeOrdersByOrderId(inWindow);
  let cacheGmv = 0;
  for (const o of deduped) cacheGmv += Number(o.orderAmountBase ?? o.totalAmount ?? 0) || 0;

  console.log('\n=== ORDERS CACHE ===');
  console.log(
    JSON.stringify(
      {
        ...cacheMeta,
        cache_today_orders: deduped.length,
        cache_today_gmv: Number(cacheGmv.toFixed(4)),
        cache_latest_epoch: deduped.reduce((m, o) => Math.max(m, getCreateEpochSec(o)), 0),
      },
      null,
      2,
    ),
  );

  const syncMap = loadOpenApiSyncStateByPlatformShopId();
  const sync = syncMap.get(PLATFORM_ID.toLowerCase());
  console.log('\n=== OPENAPI shops.json SYNC ===');
  console.log(JSON.stringify(sync || { note: 'not in shops.json' }, null, 2));

  if (shop) {
    const { shops: enriched } = await enrichShopRows(pool, shop.tenant_id, shopRows, ORDERS_CACHE_PATH);
    console.log('\n=== enrichShopRows OUTPUT ===');
    console.log(JSON.stringify(enriched[0], null, 2));

    let classification = 'unknown';
    const mysqlOrders = Number(mysqlStats[0][0]?.today_orders) || 0;
    const enrichedOrders = Number(enriched[0]?.today_orders) || 0;
    if (mysqlOrders === 0 && deduped.length > 0) classification = 'cache_only';
    else if (mysqlOrders === 0) classification = 'mysql_no_orders';
    else if (mysqlOrders > 0 && enrichedOrders === 0) classification = 'mysql_has_frontend_zero';
    else if (Number(orphanByPlatform[0][0]?.c) > 0) classification = 'shop_id_mismatch';
    else if (mysqlOrders > 0 && enrichedOrders > 0) classification = 'ok';
    console.log('\n=== CLASSIFICATION ===', classification);
  }

  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
