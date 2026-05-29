'use strict';

/**
 * 单次同步 Cavera Jewelry（MySQL 店铺源）
 * 用法：cd backend && node scripts/syncCaveraOnce.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const dayjs = require('dayjs');
const { getMysqlPool } = require('../db/mysqlPool');
const { fetchTodayOrders } = require('../tiktok-api/orders');
const {
  CAVERA_PLATFORM_SHOP_ID,
  readSyncShopsFromMysql,
  buildShopSyncLogPayload,
  stampOrdersWithShopContext,
  patchMysqlShopSyncState,
} = require('../lib/readSyncShops');
const { persistOrdersFromCache } = require('../modules/orders/orderPersistenceService');

async function main() {
  const pool = getMysqlPool();
  if (!pool) {
    console.error('MySQL unavailable');
    process.exit(1);
  }

  const shops = await readSyncShopsFromMysql(pool);
  const shop = shops.find((s) => String(s.platform_shop_id || s.shopId) === CAVERA_PLATFORM_SHOP_ID);
  if (!shop) {
    console.error('Cavera not in MySQL sync list — run importCaveraFromShopsJson.js or fix sync_enabled/token/cipher');
    process.exit(1);
  }

  console.log('[shop-sync-start]', JSON.stringify(buildShopSyncLogPayload(shop), null, 2));

  const ret = await fetchTodayOrders(shop, { logPrefix: '[cavera-once]' });
  const rawLen = Array.isArray(ret.data) ? ret.data.length : 0;

  if (!ret.ok) {
    console.log('[shop-sync-result]', JSON.stringify({
      ...buildShopSyncLogPayload(shop),
      ok: false,
      error: ret.error?.message || ret.error?.type,
      raw_orders_length: rawLen,
    }, null, 2));
    await pool.end();
    process.exit(2);
  }

  const { orders: stamped, ctx } = stampOrdersWithShopContext(ret.data, shop);
  const shopContext = {
    internal_shop_id: shop.internal_shop_id,
    platform_shop_id: ctx.platform_shop_id,
    shop_name: ctx.shop_name,
    market: ctx.market,
  };

  const stats = await persistOrdersFromCache(stamped, { shopContext, preview: true });

  await patchMysqlShopSyncState(shop.internal_shop_id, { lastSyncOk: true, lastSyncError: '' });

  console.log('[shop-sync-result]', JSON.stringify({
    ...buildShopSyncLogPayload(shop),
    ok: true,
    raw_orders_length: rawLen,
    saved_to_cache: stamped.length,
    persisted_to_mysql: stats.inserted + stats.updated,
    persist: stats,
  }, null, 2));

  await pool.end();
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
