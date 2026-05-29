'use strict';

/**
 * sync_shop_logs 阶段四字段补充（可重复执行）
 * @param {import('mysql2/promise').Connection} conn
 */
async function migrateSyncShopLogs32(conn) {
  const [cols] = await conn.query(
    `SELECT COLUMN_NAME AS c FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sync_shop_logs'`,
  );
  const have = new Set((Array.isArray(cols) ? cols : []).map((r) => String(r.c)));

  const add = async (name, ddl) => {
    if (have.has(name)) return;
    await conn.query(`ALTER TABLE sync_shop_logs ${ddl}`);
    have.add(name);
  };

  if (!have.has('platform_shop_id')) {
    const afterShop = have.has('shop_id') ? ' AFTER `shop_id`' : '';
    await conn.query(
      `ALTER TABLE sync_shop_logs ADD COLUMN \`platform_shop_id\` VARCHAR(128) NULL DEFAULT NULL${afterShop}`,
    );
    have.add('platform_shop_id');
    console.log('[migrate32] sync_shop_logs.platform_shop_id column added');
  }

  await add('platform', "ADD COLUMN `platform` VARCHAR(32) NOT NULL DEFAULT 'tiktok' AFTER `platform_shop_id`");
  await add('fetched_orders_count', 'ADD COLUMN `fetched_orders_count` INT NOT NULL DEFAULT 0 AFTER `message`');
  await add('inserted_orders_count', 'ADD COLUMN `inserted_orders_count` INT NOT NULL DEFAULT 0 AFTER `fetched_orders_count`');
  await add('updated_orders_count', 'ADD COLUMN `updated_orders_count` INT NOT NULL DEFAULT 0 AFTER `inserted_orders_count`');
  await add('failed_orders_count', 'ADD COLUMN `failed_orders_count` INT NOT NULL DEFAULT 0 AFTER `updated_orders_count`');
  await add('duration_ms', 'ADD COLUMN `duration_ms` INT UNSIGNED NULL DEFAULT NULL AFTER `failed_orders_count`');
  await add('error_message', 'ADD COLUMN `error_message` TEXT NULL AFTER `duration_ms`');

  if (!have.has('fetched_orders_count') && have.has('orders_fetched')) {
    try {
      await conn.query(
        'UPDATE sync_shop_logs SET fetched_orders_count = orders_fetched WHERE fetched_orders_count = 0 AND orders_fetched > 0',
      );
    } catch (_) {}
  }

  try {
    await conn.query(
      'ALTER TABLE sync_shop_logs MODIFY COLUMN `status` VARCHAR(32) NOT NULL DEFAULT \'running\'',
    );
  } catch (_) {}

  try {
    await conn.query(
      `CREATE INDEX idx_sync_shop_logs_status_created ON sync_shop_logs (tenant_id, status, created_at)`,
    );
  } catch (_) {}
}

module.exports = { migrateSyncShopLogs32 };
