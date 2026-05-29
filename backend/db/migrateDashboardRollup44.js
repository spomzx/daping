'use strict';

/**
 * Dashboard 本地汇总层基础表（staging migration，可重复执行）
 * summary / shop-ranking / product-ranking / trend 预聚合缓存
 */

async function tableExists(conn, table) {
  const [rows] = await conn.query(
    `SELECT COUNT(*) AS c FROM INFORMATION_SCHEMA.TABLES
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
    [table],
  );
  return Number(rows[0]?.c) > 0;
}

async function mod(conn, sql) {
  try {
    await conn.query(sql);
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    if (msg.includes('Duplicate key name') || msg.includes('already exists')) return;
    console.warn('[mysql] dashboard rollup（可忽略）:', msg);
  }
}

const CACHE_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS \`dashboard_summary_cache\` (
  \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  \`tenant_id\` BIGINT UNSIGNED NOT NULL,
  \`cache_key\` VARCHAR(128) NOT NULL,
  \`shop_id\` VARCHAR(64) NOT NULL DEFAULT 'all',
  \`market\` VARCHAR(16) NOT NULL DEFAULT 'ALL',
  \`order_filter\` VARCHAR(32) NOT NULL DEFAULT 'all',
  \`time_range\` VARCHAR(32) NOT NULL DEFAULT 'today',
  \`start_date\` DATE NULL DEFAULT NULL,
  \`end_date\` DATE NULL DEFAULT NULL,
  \`payload_json\` LONGTEXT NOT NULL,
  \`refreshed_at\` DATETIME(3) NOT NULL,
  \`expires_at\` DATETIME(3) NOT NULL,
  PRIMARY KEY (\`id\`),
  UNIQUE KEY \`uk_dash_summary_cache\` (\`tenant_id\`, \`cache_key\`),
  KEY \`idx_dash_summary_expires\` (\`expires_at\`),
  KEY \`idx_dash_summary_tenant_refresh\` (\`tenant_id\`, \`refreshed_at\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS \`dashboard_shop_ranking_cache\` (
  \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  \`tenant_id\` BIGINT UNSIGNED NOT NULL,
  \`cache_key\` VARCHAR(128) NOT NULL,
  \`shop_id\` VARCHAR(64) NOT NULL DEFAULT 'all',
  \`market\` VARCHAR(16) NOT NULL DEFAULT 'ALL',
  \`order_filter\` VARCHAR(32) NOT NULL DEFAULT 'all',
  \`time_range\` VARCHAR(32) NOT NULL DEFAULT 'today',
  \`start_date\` DATE NULL DEFAULT NULL,
  \`end_date\` DATE NULL DEFAULT NULL,
  \`payload_json\` LONGTEXT NOT NULL,
  \`refreshed_at\` DATETIME(3) NOT NULL,
  \`expires_at\` DATETIME(3) NOT NULL,
  PRIMARY KEY (\`id\`),
  UNIQUE KEY \`uk_dash_ranking_cache\` (\`tenant_id\`, \`cache_key\`),
  KEY \`idx_dash_ranking_expires\` (\`expires_at\`),
  KEY \`idx_dash_ranking_tenant_refresh\` (\`tenant_id\`, \`refreshed_at\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS \`dashboard_product_ranking_cache\` (
  \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  \`tenant_id\` BIGINT UNSIGNED NOT NULL,
  \`cache_key\` VARCHAR(128) NOT NULL,
  \`shop_id\` VARCHAR(64) NOT NULL DEFAULT 'all',
  \`market\` VARCHAR(16) NOT NULL DEFAULT 'ALL',
  \`order_filter\` VARCHAR(32) NOT NULL DEFAULT 'all',
  \`time_range\` VARCHAR(32) NOT NULL DEFAULT 'today',
  \`start_date\` DATE NULL DEFAULT NULL,
  \`end_date\` DATE NULL DEFAULT NULL,
  \`payload_json\` LONGTEXT NOT NULL,
  \`refreshed_at\` DATETIME(3) NOT NULL,
  \`expires_at\` DATETIME(3) NOT NULL,
  PRIMARY KEY (\`id\`),
  UNIQUE KEY \`uk_dash_product_ranking_cache\` (\`tenant_id\`, \`cache_key\`),
  KEY \`idx_dash_product_ranking_expires\` (\`expires_at\`),
  KEY \`idx_dash_product_ranking_tenant_refresh\` (\`tenant_id\`, \`refreshed_at\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS \`dashboard_trend_cache\` (
  \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  \`tenant_id\` BIGINT UNSIGNED NOT NULL,
  \`cache_key\` VARCHAR(128) NOT NULL,
  \`endpoint\` VARCHAR(32) NOT NULL DEFAULT 'trend',
  \`shop_id\` VARCHAR(64) NOT NULL DEFAULT 'all',
  \`market\` VARCHAR(16) NOT NULL DEFAULT 'ALL',
  \`order_filter\` VARCHAR(32) NOT NULL DEFAULT 'all',
  \`time_range\` VARCHAR(32) NOT NULL DEFAULT 'today',
  \`start_date\` DATE NULL DEFAULT NULL,
  \`end_date\` DATE NULL DEFAULT NULL,
  \`payload_json\` LONGTEXT NOT NULL,
  \`refreshed_at\` DATETIME(3) NOT NULL,
  \`expires_at\` DATETIME(3) NOT NULL,
  PRIMARY KEY (\`id\`),
  UNIQUE KEY \`uk_dash_trend_cache\` (\`tenant_id\`, \`cache_key\`),
  KEY \`idx_dash_trend_expires\` (\`expires_at\`),
  KEY \`idx_dash_trend_tenant_refresh\` (\`tenant_id\`, \`refreshed_at\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
`;

async function migrateDashboardRollup44(conn) {
  await conn.query({ sql: CACHE_TABLE_DDL, multipleStatements: true });

  const extraIndexes = [
    'CREATE INDEX `idx_orders_dash_tenant_shop_astatus_created` ON `orders` (`tenant_id`, `shop_id`, `analytics_status`, `created_at_platform`)',
    'CREATE INDEX `idx_orders_dash_tenant_market_astatus_created` ON `orders` (`tenant_id`, `market`, `analytics_status`, `created_at_platform`)',
    'CREATE INDEX `idx_orders_dash_tenant_astatus_updated` ON `orders` (`tenant_id`, `analytics_status`, `updated_at`)',
  ];
  for (const sql of extraIndexes) {
    await mod(conn, sql);
  }

  const tables = [
    'dashboard_summary_cache',
    'dashboard_shop_ranking_cache',
    'dashboard_product_ranking_cache',
    'dashboard_trend_cache',
  ];
  const ok = {};
  for (const t of tables) {
    ok[t] = await tableExists(conn, t);
  }
  return ok;
}

module.exports = { migrateDashboardRollup44, CACHE_TABLE_DDL };
