'use strict';

/**
 * SaaS 阶段三：sync_shop_logs、system_settings、exchange_rates、roles/permissions（预留）
 * @param {import('mysql2/promise').Connection} conn
 */
async function migrateSaaS31Tables(conn) {
  await conn.query(`
    CREATE TABLE IF NOT EXISTS \`sync_shop_logs\` (
      \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      \`tenant_id\` BIGINT UNSIGNED NULL DEFAULT NULL,
      \`shop_id\` BIGINT UNSIGNED NULL DEFAULT NULL,
      \`platform_shop_id\` VARCHAR(128) NULL DEFAULT NULL,
      \`status\` VARCHAR(32) NOT NULL DEFAULT 'ok',
      \`message\` TEXT NULL,
      \`orders_fetched\` INT NOT NULL DEFAULT 0,
      \`started_at\` DATETIME(3) NULL DEFAULT NULL,
      \`finished_at\` DATETIME(3) NULL DEFAULT NULL,
      \`created_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      PRIMARY KEY (\`id\`),
      KEY \`idx_sync_shop_logs_tenant\` (\`tenant_id\`, \`created_at\`),
      KEY \`idx_sync_shop_logs_shop\` (\`shop_id\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await conn.query(`
    CREATE TABLE IF NOT EXISTS \`system_settings\` (
      \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      \`tenant_id\` BIGINT UNSIGNED NULL DEFAULT NULL COMMENT 'NULL=全局',
      \`setting_key\` VARCHAR(128) NOT NULL,
      \`setting_value\` TEXT NULL,
      \`value_type\` VARCHAR(32) NOT NULL DEFAULT 'string',
      \`created_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      \`updated_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
      PRIMARY KEY (\`id\`),
      UNIQUE KEY \`uk_settings_tenant_key\` (\`tenant_id\`, \`setting_key\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await conn.query(`
    CREATE TABLE IF NOT EXISTS \`exchange_rates\` (
      \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      \`base_currency\` VARCHAR(8) NOT NULL,
      \`target_currency\` VARCHAR(8) NOT NULL,
      \`rate\` DECIMAL(18,8) NOT NULL,
      \`source\` VARCHAR(64) NULL DEFAULT NULL,
      \`effective_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      \`created_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      \`updated_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
      PRIMARY KEY (\`id\`),
      KEY \`idx_exchange_pair\` (\`base_currency\`, \`target_currency\`, \`effective_at\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await conn.query(`
    CREATE TABLE IF NOT EXISTS \`roles\` (
      \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      \`role_code\` VARCHAR(64) NOT NULL,
      \`role_name\` VARCHAR(128) NOT NULL,
      \`description\` VARCHAR(512) NULL DEFAULT NULL,
      \`created_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      PRIMARY KEY (\`id\`),
      UNIQUE KEY \`uk_roles_code\` (\`role_code\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await conn.query(`
    CREATE TABLE IF NOT EXISTS \`permissions\` (
      \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      \`permission_code\` VARCHAR(128) NOT NULL,
      \`permission_name\` VARCHAR(255) NOT NULL,
      \`module\` VARCHAR(64) NULL DEFAULT NULL,
      \`created_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      PRIMARY KEY (\`id\`),
      UNIQUE KEY \`uk_permissions_code\` (\`permission_code\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  const seedRoles = [
    ['super_admin', '超级管理员'],
    ['admin', '管理员'],
    ['viewer', '只读'],
  ];
  for (const [code, name] of seedRoles) {
    await conn.query(
      `INSERT IGNORE INTO roles (role_code, role_name) VALUES (?, ?)`,
      [code, name],
    );
  }
}

module.exports = { migrateSaaS31Tables };
