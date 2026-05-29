'use strict';

/**
 * 2.2 shops 健康监控列（可重复执行）。
 * @param {import('mysql2/promise').Connection} conn
 */
async function migrateShops22HealthColumns(conn) {
  const [rows] = await conn.query(
    `SELECT COLUMN_NAME AS c FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'shops'`,
  );
  const have = new Set((Array.isArray(rows) ? rows : []).map((r) => String(r.c)));

  const add = async (name, ddl) => {
    if (have.has(name)) return;
    await conn.query(`ALTER TABLE shops ${ddl}`);
    have.add(name);
  };

  await add('last_order_seen_at', 'ADD COLUMN `last_order_seen_at` DATETIME(3) NULL DEFAULT NULL AFTER `last_sync_at`');
  await add('last_order_count', 'ADD COLUMN `last_order_count` INT NOT NULL DEFAULT 0 AFTER `last_order_seen_at`');
  await add('last_gmv_amount', 'ADD COLUMN `last_gmv_amount` DECIMAL(18,4) NOT NULL DEFAULT 0 AFTER `last_order_count`');
  await add(
    'last_health_status',
    "ADD COLUMN `last_health_status` VARCHAR(32) NOT NULL DEFAULT 'unknown' AFTER `last_gmv_amount`",
  );
  await add('last_health_message', 'ADD COLUMN `last_health_message` TEXT NULL DEFAULT NULL AFTER `last_health_status`');
  await add(
    'last_health_checked_at',
    'ADD COLUMN `last_health_checked_at` DATETIME(3) NULL DEFAULT NULL AFTER `last_health_message`',
  );
  await add(
    'last_health_fail_count',
    'ADD COLUMN `last_health_fail_count` INT NOT NULL DEFAULT 0 AFTER `last_health_checked_at`',
  );
}

module.exports = { migrateShops22HealthColumns };
