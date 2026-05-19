'use strict';

/**
 * 本地验收证据：不依赖 HTTP，直接读 MySQL + storage 路径
 * 用法：cd backend && node scripts/acceptanceEvidence.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const path = require('path');
const { getMysqlPool } = require('../db/mysqlPool');
const { enrichShopRows } = require('../modules/shops/shopLiveStatsService');
const { buildOrdersReconcileReport } = require('../modules/orders/orderReconcileService');
const { rebuildOrdersCacheFromMysql, ORDERS_CACHE_PATH } = require('../modules/orders/orderCacheRebuildService');
const { cacheFileStats } = require('../lib/ordersCachePath');
const { storageDir } = require('../lib/storageFile');

const CQ_PLATFORM_ID = '8646969730649196387';

async function main() {
  const pool = getMysqlPool();
  if (!pool) {
    console.error('MySQL pool unavailable');
    process.exit(1);
  }

  console.log('=== STORAGE PATHS ===');
  console.log(
    JSON.stringify(
      {
        process_cwd: process.cwd(),
        STORAGE_DIR_env: process.env.STORAGE_DIR || null,
        storageDir_from_lib: storageDir(),
        ORDERS_CACHE_PATH,
        cacheFileStats: cacheFileStats(),
        controller_relative: path.join(__dirname, '..', 'modules', 'shops', '../../storage'),
        reconcile_resolves_to: path.join(
          process.env.STORAGE_DIR || path.join(__dirname, '..', 'storage'),
          'orders-cache.json',
        ),
      },
      null,
      2,
    ),
  );

  const [shops] = await pool.query(
    `SELECT * FROM shops WHERE LOWER(TRIM(platform_shop_id)) = ? OR shop_name LIKE '%CQ Chic%' LIMIT 5`,
    [CQ_PLATFORM_ID.toLowerCase()],
  );

  const tenantId = shops[0] ? Number(shops[0].tenant_id) : 1;
  const enriched = await enrichShopRows(pool, tenantId, shops, ORDERS_CACHE_PATH);
  const cq =
    enriched.shops.find(
      (s) =>
        String(s.platform_shop_id || '').trim() === CQ_PLATFORM_ID ||
        /cq\s*chic/i.test(String(s.shop_name || '')),
    ) || enriched.shops[0];

  console.log('\n=== CQ CHIC /api/shops ROW (enriched) ===');
  console.log(JSON.stringify(cq, null, 2));

  const auth = { scope: 'tenant', role: 'admin', user_id: 1, tenant_id: tenantId };
  console.log('\n=== /api/orders/reconcile BEFORE rebuild ===');
  const before = await buildOrdersReconcileReport(tenantId, auth, { windowHours: 24 });
  console.log(
    JSON.stringify(
      {
        cache_file_path: before.debug?.cacheSource?.cache_file_path,
        cache_updated_at: before.debug?.cacheSource?.cache_updated_at,
        cache_lag_minutes: before.debug?.cacheSource?.cache_lag_minutes,
        orderDiffReasonStats: before.debug?.orderDiffReasonStats,
        itemDiffReasonStats: before.debug?.itemDiffReasonStats,
        mysqlOrders: before.mysqlOrders,
        cacheOrders: before.cacheOrders,
      },
      null,
      2,
    ),
  );

  console.log('\n=== REBUILD ===');
  const rebuilt = await rebuildOrdersCacheFromMysql(tenantId, auth);
  console.log(JSON.stringify(rebuilt, null, 2));

  console.log('\n=== /api/orders/reconcile AFTER rebuild ===');
  const after = await buildOrdersReconcileReport(tenantId, auth, { windowHours: 24 });
  console.log(
    JSON.stringify(
      {
        cache_file_path: after.debug?.cacheSource?.cache_file_path,
        cache_updated_at: after.debug?.cacheSource?.cache_updated_at,
        cache_lag_minutes: after.debug?.cacheSource?.cache_lag_minutes,
        orderDiffReasonStats: after.debug?.orderDiffReasonStats,
        itemDiffReasonStats: after.debug?.itemDiffReasonStats,
        mysqlOrders: after.mysqlOrders,
        cacheOrders: after.cacheOrders,
      },
      null,
      2,
    ),
  );

  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
