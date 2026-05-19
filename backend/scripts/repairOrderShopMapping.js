'use strict';

/**
 * 修复 orders.shop_id 误写为 platform_shop_id 的历史数据
 * node backend/scripts/repairOrderShopMapping.js [--dry-run]
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { getMysqlPool } = require('../db/mysqlPool');
const { migrateOrders30PlatformShopId } = require('../db/migrateOrders30PlatformShopId');

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const pool = getMysqlPool();
  if (!pool) {
    console.error('MySQL unavailable');
    process.exit(1);
  }

  await migrateOrders30PlatformShopId(pool);

  const [broken] = await pool.query(`
    SELECT o.id, o.shop_id, o.platform_order_id, o.shop_name, o.market,
           s.id AS correct_shop_id, s.platform_shop_id
    FROM orders o
    LEFT JOIN shops s ON s.id = o.shop_id
    WHERE o.shop_id IS NOT NULL
      AND (
        s.id IS NULL
        OR CAST(o.shop_id AS CHAR) = TRIM(s.platform_shop_id)
      )
    LIMIT 500
  `);

  console.log('[repair] broken sample count (max 500):', broken.length);
  console.log(JSON.stringify(broken.slice(0, 20), null, 2));

  if (dryRun) {
    console.log('[repair] dry-run — no updates');
    await pool.end();
    return;
  }

  const [r1] = await pool.query(`
    UPDATE orders o
    INNER JOIN shops s ON LOWER(TRIM(s.platform_shop_id)) = LOWER(TRIM(CAST(o.shop_id AS CHAR)))
    SET o.shop_id = s.id,
        o.platform_shop_id = s.platform_shop_id,
        o.tenant_id = COALESCE(o.tenant_id, s.tenant_id),
        o.shop_name = COALESCE(o.shop_name, s.shop_name),
        o.market = COALESCE(o.market, s.market, s.region)
    WHERE o.shop_id <> s.id OR s.id IS NULL OR o.platform_shop_id IS NULL
  `);

  const [r2] = await pool.query(`
    UPDATE orders o
    INNER JOIN shops s ON s.id = o.shop_id
    SET o.platform_shop_id = s.platform_shop_id
    WHERE o.platform_shop_id IS NULL OR TRIM(o.platform_shop_id) = ''
  `);

  console.log('[repair] fixed mistaken shop_id rows:', r1.affectedRows ?? 0);
  console.log('[repair] backfilled platform_shop_id:', r2.affectedRows ?? 0);
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
