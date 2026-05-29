'use strict';

/**
 * shops.seller_type — local | cross_border（OAuth 路由与入库）
 */

const { getMysqlPool } = require('./mysqlPool');

async function migrateShopsSellerType() {
  const pool = getMysqlPool();
  if (!pool) {
    console.warn('[migrate-shops-seller-type] MySQL unavailable, skip');
    return { ok: false, skipped: true };
  }
  const [cols] = await pool.query(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'shops' AND COLUMN_NAME = 'seller_type'`,
  );
  if (Array.isArray(cols) && cols.length > 0) {
    console.log('[migrate-shops-seller-type] seller_type already exists');
    return { ok: true, already: true };
  }
  await pool.execute(
    "ALTER TABLE `shops` ADD COLUMN `seller_type` VARCHAR(32) NULL DEFAULT NULL COMMENT 'local|cross_border' AFTER `market`",
  );
  console.log('[migrate-shops-seller-type] added shops.seller_type');
  return { ok: true };
}

if (require.main === module) {
  migrateShopsSellerType()
    .then((r) => process.exit(r.ok || r.skipped ? 0 : 1))
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}

module.exports = { migrateShopsSellerType };
