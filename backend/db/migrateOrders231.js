'use strict';

/**
 * 2.3.1 orders 表（cache → MySQL 双写）；与 schema.sql 对齐，可重复执行。
 * @param {import('mysql2/promise').Connection} conn
 */
async function migrateOrders231(conn) {
  await conn.query(`
CREATE TABLE IF NOT EXISTS \`orders\` (
  \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  \`tenant_id\` BIGINT UNSIGNED NOT NULL,
  \`shop_id\` BIGINT UNSIGNED NULL DEFAULT NULL,
  \`platform\` VARCHAR(32) NOT NULL,
  \`platform_order_id\` VARCHAR(128) NOT NULL,
  \`shop_name\` VARCHAR(255) NULL DEFAULT NULL,
  \`market\` VARCHAR(32) NULL DEFAULT NULL,
  \`currency\` VARCHAR(16) NULL DEFAULT NULL,
  \`buyer_name\` VARCHAR(255) NULL DEFAULT NULL,
  \`order_status\` VARCHAR(64) NULL DEFAULT NULL,
  \`total_amount\` DECIMAL(18,2) NOT NULL DEFAULT 0,
  \`created_at_platform\` DATETIME(3) NULL DEFAULT NULL,
  \`paid_at\` DATETIME(3) NULL DEFAULT NULL,
  \`raw_json\` LONGTEXT NULL,
  \`created_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  \`updated_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (\`id\`),
  UNIQUE KEY \`uk_orders_platform_order\` (\`platform\`, \`platform_order_id\`),
  KEY \`idx_orders_shop\` (\`shop_id\`),
  KEY \`idx_orders_created\` (\`created_at_platform\`),
  KEY \`idx_orders_market\` (\`market\`),
  KEY \`idx_orders_tenant\` (\`tenant_id\`),
  CONSTRAINT \`fk_orders_tenant\` FOREIGN KEY (\`tenant_id\`) REFERENCES \`tenants\` (\`id\`) ON DELETE CASCADE,
  CONSTRAINT \`fk_orders_shop\` FOREIGN KEY (\`shop_id\`) REFERENCES \`shops\` (\`id\`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
`);
}

module.exports = { migrateOrders231 };
