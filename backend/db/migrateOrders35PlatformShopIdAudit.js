'use strict';

const { migrateOrders34PlatformShopId } = require('./migrateOrders34PlatformShopId');
const { migrateOrders30PlatformShopId } = require('./migrateOrders30PlatformShopId');

async function columnExists(conn, table, columnName) {
  const [rows] = await conn.query(
    `SELECT COUNT(*) AS c FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [table, columnName],
  );
  return Number(rows[0]?.c) > 0;
}

async function indexExists(conn, table, indexName) {
  const [rows] = await conn.query(
    `SELECT COUNT(*) AS c FROM INFORMATION_SCHEMA.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?`,
    [table, indexName],
  );
  return Number(rows[0]?.c) > 0;
}

async function ensureColumn(conn, table, columnName, ddlAfterShopId) {
  if (await columnExists(conn, table, columnName)) {
    return false;
  }
  const hasShopId = await columnExists(conn, table, 'shop_id');
  const afterClause =
    ddlAfterShopId && hasShopId ? ' AFTER `shop_id`' : ddlAfterShopId ? ` AFTER \`${ddlAfterShopId}\`` : '';
  await conn.query(
    `ALTER TABLE \`${table}\` ADD COLUMN \`${columnName}\` VARCHAR(128) NULL DEFAULT NULL${afterClause}`,
  );
  console.log(`[migrate35] ${table}.${columnName} column added`);
  return true;
}

/**
 * 幂等审计：orders / sync_shop_logs 的 platform_shop_id + 索引 + 回填
 * @param {import('mysql2/promise').Connection} conn
 */
async function migrateOrders35PlatformShopIdAudit(conn) {
  const audit = {
    orders: null,
    sync_shop_logs: { columnAdded: false },
    repair30: false,
  };

  audit.orders = await migrateOrders34PlatformShopId(conn);

  audit.sync_shop_logs.columnAdded = await ensureColumn(
    conn,
    'sync_shop_logs',
    'platform_shop_id',
    'shop_id',
  );

  if (await columnExists(conn, 'orders', 'platform_shop_id')) {
    try {
      await migrateOrders30PlatformShopId(conn);
      audit.repair30 = true;
    } catch (e) {
      console.warn('[migrate35] migrateOrders30 repair skipped:', e?.message || e);
    }
  }

  if (!(await indexExists(conn, 'sync_shop_logs', 'idx_sync_shop_logs_platform_shop'))) {
    if (await columnExists(conn, 'sync_shop_logs', 'platform_shop_id')) {
      try {
        await conn.query(
          'ALTER TABLE `sync_shop_logs` ADD INDEX `idx_sync_shop_logs_platform_shop` (`platform_shop_id`)',
        );
        console.log('[migrate35] idx_sync_shop_logs_platform_shop added');
      } catch (e) {
        console.warn('[migrate35] idx_sync_shop_logs_platform_shop:', e?.message || e);
      }
    }
  }

  return audit;
}

module.exports = { migrateOrders35PlatformShopIdAudit };
