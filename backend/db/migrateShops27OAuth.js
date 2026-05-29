'use strict';

/**
 * OAuth SaaS：shops.last_authorized_at（可重复执行）。
 * @param {import('mysql2/promise').Connection} conn
 */
async function migrateShops27OAuthColumns(conn) {
  const [rows] = await conn.query(
    `SELECT COLUMN_NAME AS c FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'shops'`,
  );
  const have = new Set((Array.isArray(rows) ? rows : []).map((r) => String(r.c)));
  if (!have.has('last_authorized_at')) {
    await conn.query(
      'ALTER TABLE shops ADD COLUMN `last_authorized_at` DATETIME(3) NULL DEFAULT NULL AFTER `auth_status`',
    );
  }
}

module.exports = { migrateShops27OAuthColumns };
