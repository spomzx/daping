'use strict';

/**
 * 2.1 shops 表增量列（已有库可重复执行）。
 * @param {import('mysql2/promise').Connection} conn
 */
async function migrateShops21Columns(conn) {
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

  await add('display_name', 'ADD COLUMN `display_name` VARCHAR(255) NULL DEFAULT NULL AFTER `shop_name`');
  await add('sort_order', 'ADD COLUMN `sort_order` INT NOT NULL DEFAULT 0 AFTER `currency`');
  await add('hidden', 'ADD COLUMN `hidden` TINYINT(1) NOT NULL DEFAULT 0 AFTER `sort_order`');
  await add('sync_enabled', 'ADD COLUMN `sync_enabled` TINYINT(1) NOT NULL DEFAULT 1 AFTER `hidden`');
  await add('remarks', 'ADD COLUMN `remarks` TEXT NULL AFTER `sync_enabled`');
  await add(
    'imported_from_cache',
    'ADD COLUMN `imported_from_cache` TINYINT(1) NOT NULL DEFAULT 0 AFTER `remarks`',
  );
  await add(
    'last_cache_sync_at',
    'ADD COLUMN `last_cache_sync_at` DATETIME(3) NULL DEFAULT NULL AFTER `imported_from_cache`',
  );
}

module.exports = { migrateShops21Columns };
