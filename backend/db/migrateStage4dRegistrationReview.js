'use strict';

/**
 * Stage 4-D：users.contact + notifications 表（可重复执行）。
 * @param {import('mysql2/promise').Connection} conn
 */
async function migrateStage4dRegistrationReview(conn) {
  const [cols] = await conn.query(
    `SELECT COLUMN_NAME AS c FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users'`,
  );
  const have = new Set((Array.isArray(cols) ? cols : []).map((r) => String(r.c)));
  if (!have.has('contact')) {
    await conn.query('ALTER TABLE `users` ADD COLUMN `contact` VARCHAR(512) NULL DEFAULT NULL AFTER `phone`');
  }

  const [tabs] = await conn.query(
    `SELECT TABLE_NAME AS t FROM INFORMATION_SCHEMA.TABLES
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'notifications'`,
  );
  if (!Array.isArray(tabs) || tabs.length === 0) {
    await conn.query(`
      CREATE TABLE IF NOT EXISTS \`notifications\` (
        \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        \`tenant_id\` BIGINT UNSIGNED NULL DEFAULT NULL,
        \`user_id\` BIGINT UNSIGNED NOT NULL,
        \`title\` VARCHAR(255) NOT NULL,
        \`content\` TEXT NULL,
        \`type\` VARCHAR(64) NOT NULL DEFAULT 'system',
        \`is_read\` TINYINT(1) NOT NULL DEFAULT 0,
        \`created_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        PRIMARY KEY (\`id\`),
        KEY \`idx_notifications_user_read\` (\`user_id\`, \`is_read\`, \`created_at\`),
        KEY \`idx_notifications_tenant\` (\`tenant_id\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
  }
}

module.exports = { migrateStage4dRegistrationReview };
