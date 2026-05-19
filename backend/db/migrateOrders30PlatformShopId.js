'use strict';

/**
 * orders.platform_shop_id — TikTok 店铺 ID（与 orders.shop_id=shops.id 分离）
 * @param {import('mysql2/promise').Pool|import('mysql2/promise').Connection} conn
 */
async function migrateOrders30PlatformShopId(conn) {
  const [cols] = await conn.query(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'orders' AND COLUMN_NAME = 'platform_shop_id'`,
  );
  if (!Array.isArray(cols) || cols.length === 0) {
    await conn.query(`
      ALTER TABLE \`orders\`
        ADD COLUMN \`platform_shop_id\` VARCHAR(128) NULL DEFAULT NULL
          COMMENT 'TikTok platform shop id' AFTER \`shop_id\`,
        ADD KEY \`idx_orders_platform_shop\` (\`platform_shop_id\`)
    `);
    console.log('[migrate] orders.platform_shop_id column added');
  }

  const [res] = await conn.query(`
    UPDATE orders o
    INNER JOIN shops s ON s.id = o.shop_id
    SET o.platform_shop_id = s.platform_shop_id
    WHERE o.platform_shop_id IS NULL OR TRIM(o.platform_shop_id) = ''
  `);
  console.log('[migrate] backfill platform_shop_id from shops.id join:', res.affectedRows ?? 0);

  const [fix] = await conn.query(`
    UPDATE orders o
    INNER JOIN shops s ON LOWER(TRIM(s.platform_shop_id)) = LOWER(TRIM(CAST(o.shop_id AS CHAR)))
    SET o.shop_id = s.id,
        o.platform_shop_id = s.platform_shop_id,
        o.tenant_id = COALESCE(o.tenant_id, s.tenant_id)
    WHERE o.shop_id <> s.id
  `);
  console.log('[migrate] repair shop_id mistaken as platform_shop_id:', fix.affectedRows ?? 0);
}

module.exports = { migrateOrders30PlatformShopId };
