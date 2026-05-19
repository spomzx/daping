'use strict';

/**
 * 2.3.3 order_items 表；与 schema.sql 对齐，可重复执行。
 * @param {import('mysql2/promise').Connection} conn
 */
async function migrateOrderItems233(conn) {
  await conn.query(`
CREATE TABLE IF NOT EXISTS \`order_items\` (
  \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  \`tenant_id\` BIGINT UNSIGNED NOT NULL,
  \`order_id\` BIGINT UNSIGNED NULL DEFAULT NULL,
  \`platform\` VARCHAR(32) NOT NULL,
  \`platform_order_id\` VARCHAR(128) NOT NULL,
  \`platform_item_id\` VARCHAR(128) NOT NULL DEFAULT '',
  \`shop_id\` BIGINT UNSIGNED NULL DEFAULT NULL,
  \`shop_name\` VARCHAR(255) NULL DEFAULT NULL,
  \`market\` VARCHAR(32) NULL DEFAULT NULL,
  \`product_id\` VARCHAR(128) NOT NULL DEFAULT '',
  \`sku_id\` VARCHAR(128) NOT NULL DEFAULT '',
  \`sku_name\` VARCHAR(255) NULL DEFAULT NULL,
  \`product_name\` VARCHAR(512) NULL DEFAULT NULL,
  \`product_image\` VARCHAR(1024) NULL DEFAULT NULL,
  \`quantity\` INT NOT NULL DEFAULT 1,
  \`currency\` VARCHAR(16) NULL DEFAULT NULL,
  \`unit_price\` DECIMAL(18,4) NOT NULL DEFAULT 0,
  \`total_amount\` DECIMAL(18,4) NOT NULL DEFAULT 0,
  \`raw_json\` LONGTEXT NULL,
  \`created_at_platform\` DATETIME(3) NULL DEFAULT NULL,
  \`created_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  \`updated_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (\`id\`),
  UNIQUE KEY \`uk_order_items_unique\` (\`platform\`, \`platform_order_id\`, \`platform_item_id\`, \`sku_id\`, \`product_id\`),
  KEY \`idx_order_items_order\` (\`order_id\`),
  KEY \`idx_order_items_shop\` (\`shop_id\`),
  KEY \`idx_order_items_product\` (\`product_id\`),
  KEY \`idx_order_items_sku\` (\`sku_id\`),
  KEY \`idx_order_items_market\` (\`market\`),
  KEY \`idx_order_items_created\` (\`created_at_platform\`),
  CONSTRAINT \`fk_order_items_tenant\` FOREIGN KEY (\`tenant_id\`) REFERENCES \`tenants\` (\`id\`) ON DELETE CASCADE,
  CONSTRAINT \`fk_order_items_order\` FOREIGN KEY (\`order_id\`) REFERENCES \`orders\` (\`id\`) ON DELETE SET NULL,
  CONSTRAINT \`fk_order_items_shop\` FOREIGN KEY (\`shop_id\`) REFERENCES \`shops\` (\`id\`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
`);
}

module.exports = { migrateOrderItems233 };
