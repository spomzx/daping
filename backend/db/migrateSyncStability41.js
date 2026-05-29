'use strict';

/**
 * Phase-4.1/4.2：sync_jobs / sync_logs / shop_sync_status（完全幂等）
 * @param {import('mysql2/promise').Connection | import('mysql2/promise').Pool} conn
 */

async function getColumns(conn, table) {
  const [rows] = await conn.query(
    `SELECT COLUMN_NAME AS c FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
    [table],
  );
  return new Set((Array.isArray(rows) ? rows : []).map((r) => String(r.c)));
}

async function tableExists(conn, table) {
  const [rows] = await conn.query(
    `SELECT COUNT(*) AS c FROM INFORMATION_SCHEMA.TABLES
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
    [table],
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

async function addColumn(conn, table, have, name, ddl) {
  if (have.has(name)) return;
  try {
    await conn.query(`ALTER TABLE \`${table}\` ${ddl}`);
    have.add(name);
    console.log(`[migrate41] ${table}.${name} added`);
  } catch (e) {
    if (String(e?.code) !== 'ER_DUP_FIELDNAME') throw e;
    have.add(name);
  }
}

async function createIndex(conn, table, indexName, ddl) {
  if (await indexExists(conn, table, indexName)) return;
  try {
    await conn.query(`ALTER TABLE \`${table}\` ${ddl}`);
    console.log(`[migrate41] index ${table}.${indexName} ok`);
  } catch (e) {
    const code = String(e?.code || '');
    if (code === 'ER_DUP_KEYNAME' || code === 'ER_DUP_INDEX') return;
    throw e;
  }
}

async function archiveLegacySyncJobs(conn) {
  if (!(await tableExists(conn, 'sync_jobs'))) return;

  const cols = await getColumns(conn, 'sync_jobs');
  if (cols.has('shop_id')) return;

  let legacyName = 'sync_jobs_legacy_v0';
  let n = 0;
  while (await tableExists(conn, legacyName)) {
    n += 1;
    legacyName = `sync_jobs_legacy_v0_${n}`;
  }

  await conn.query(`RENAME TABLE \`sync_jobs\` TO \`${legacyName}\``);
  console.log(`[migrate41] archived legacy sync_jobs → ${legacyName}`);
}

async function ensureSyncJobsTable(conn) {
  await archiveLegacySyncJobs(conn);

  if (!(await tableExists(conn, 'sync_jobs'))) {
    await conn.query(`
      CREATE TABLE \`sync_jobs\` (
        \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        \`tenant_id\` BIGINT UNSIGNED NOT NULL,
        \`shop_id\` BIGINT UNSIGNED NOT NULL,
        \`platform\` VARCHAR(32) NOT NULL DEFAULT 'tiktok',
        \`job_type\` VARCHAR(64) NOT NULL DEFAULT 'shop_orders',
        \`status\` VARCHAR(32) NOT NULL DEFAULT 'queued',
        \`priority\` INT NOT NULL DEFAULT 100,
        \`attempt_count\` INT UNSIGNED NOT NULL DEFAULT 0,
        \`max_attempts\` INT UNSIGNED NOT NULL DEFAULT 5,
        \`locked_by\` VARCHAR(128) NULL DEFAULT NULL,
        \`locked_at\` DATETIME(3) NULL DEFAULT NULL,
        \`started_at\` DATETIME(3) NULL DEFAULT NULL,
        \`finished_at\` DATETIME(3) NULL DEFAULT NULL,
        \`next_retry_at\` DATETIME(3) NULL DEFAULT NULL,
        \`error_message\` TEXT NULL,
        \`created_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        \`updated_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
        PRIMARY KEY (\`id\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    console.log('[migrate41] sync_jobs created');
  }

  const have = await getColumns(conn, 'sync_jobs');
  await addColumn(conn, 'sync_jobs', have, 'tenant_id', 'ADD COLUMN `tenant_id` BIGINT UNSIGNED NOT NULL DEFAULT 0 AFTER `id`');
  await addColumn(conn, 'sync_jobs', have, 'shop_id', 'ADD COLUMN `shop_id` BIGINT UNSIGNED NOT NULL DEFAULT 0 AFTER `tenant_id`');
  await addColumn(conn, 'sync_jobs', have, 'platform', "ADD COLUMN `platform` VARCHAR(32) NOT NULL DEFAULT 'tiktok' AFTER `shop_id`");
  await addColumn(conn, 'sync_jobs', have, 'job_type', "ADD COLUMN `job_type` VARCHAR(64) NOT NULL DEFAULT 'shop_orders' AFTER `platform`");
  await addColumn(conn, 'sync_jobs', have, 'status', "ADD COLUMN `status` VARCHAR(32) NOT NULL DEFAULT 'queued' AFTER `job_type`");
  await addColumn(conn, 'sync_jobs', have, 'priority', 'ADD COLUMN `priority` INT NOT NULL DEFAULT 100 AFTER `status`');
  await addColumn(conn, 'sync_jobs', have, 'attempt_count', 'ADD COLUMN `attempt_count` INT UNSIGNED NOT NULL DEFAULT 0 AFTER `priority`');
  await addColumn(conn, 'sync_jobs', have, 'max_attempts', 'ADD COLUMN `max_attempts` INT UNSIGNED NOT NULL DEFAULT 5 AFTER `attempt_count`');
  await addColumn(conn, 'sync_jobs', have, 'locked_by', 'ADD COLUMN `locked_by` VARCHAR(128) NULL DEFAULT NULL AFTER `max_attempts`');
  await addColumn(conn, 'sync_jobs', have, 'locked_at', 'ADD COLUMN `locked_at` DATETIME(3) NULL DEFAULT NULL AFTER `locked_by`');
  await addColumn(conn, 'sync_jobs', have, 'started_at', 'ADD COLUMN `started_at` DATETIME(3) NULL DEFAULT NULL AFTER `locked_at`');
  await addColumn(conn, 'sync_jobs', have, 'finished_at', 'ADD COLUMN `finished_at` DATETIME(3) NULL DEFAULT NULL AFTER `started_at`');
  await addColumn(conn, 'sync_jobs', have, 'next_retry_at', 'ADD COLUMN `next_retry_at` DATETIME(3) NULL DEFAULT NULL AFTER `finished_at`');
  await addColumn(conn, 'sync_jobs', have, 'error_message', 'ADD COLUMN `error_message` TEXT NULL AFTER `next_retry_at`');
  await addColumn(conn, 'sync_jobs', have, 'created_at', 'ADD COLUMN `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)');
  await addColumn(conn, 'sync_jobs', have, 'updated_at', 'ADD COLUMN `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)');

  await createIndex(conn, 'sync_jobs', 'idx_sync_jobs_tenant_status', 'ADD INDEX `idx_sync_jobs_tenant_status` (`tenant_id`, `status`)');
  await createIndex(conn, 'sync_jobs', 'idx_sync_jobs_shop_status', 'ADD INDEX `idx_sync_jobs_shop_status` (`shop_id`, `status`)');
  await createIndex(conn, 'sync_jobs', 'idx_sync_jobs_platform_status', 'ADD INDEX `idx_sync_jobs_platform_status` (`platform`, `status`)');
  await createIndex(conn, 'sync_jobs', 'idx_sync_jobs_next_retry', 'ADD INDEX `idx_sync_jobs_next_retry` (`next_retry_at`)');
}

async function archiveLegacyTableWithoutShopId(conn, table, legacyPrefix) {
  if (!(await tableExists(conn, table))) return;
  const cols = await getColumns(conn, table);
  if (cols.has('shop_id')) return;

  let legacyName = legacyPrefix;
  let n = 0;
  while (await tableExists(conn, legacyName)) {
    n += 1;
    legacyName = `${legacyPrefix}_${n}`;
  }
  await conn.query(`RENAME TABLE \`${table}\` TO \`${legacyName}\``);
  console.log(`[migrate41] archived legacy ${table} → ${legacyName}`);
}

async function ensureSyncShopLogsTable(conn) {
  await archiveLegacyTableWithoutShopId(conn, 'sync_shop_logs', 'sync_shop_logs_legacy_v0');

  if (!(await tableExists(conn, 'sync_shop_logs'))) {
    await conn.query(`
      CREATE TABLE \`sync_shop_logs\` (
        \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        \`tenant_id\` BIGINT UNSIGNED NULL DEFAULT NULL,
        \`shop_id\` BIGINT UNSIGNED NULL DEFAULT NULL,
        \`platform_shop_id\` VARCHAR(128) NULL DEFAULT NULL,
        \`platform\` VARCHAR(32) NOT NULL DEFAULT 'tiktok',
        \`status\` VARCHAR(32) NOT NULL DEFAULT 'running',
        \`message\` TEXT NULL,
        \`error_message\` TEXT NULL,
        \`orders_fetched\` INT NOT NULL DEFAULT 0,
        \`fetched_orders_count\` INT NOT NULL DEFAULT 0,
        \`inserted_orders_count\` INT NOT NULL DEFAULT 0,
        \`updated_orders_count\` INT NOT NULL DEFAULT 0,
        \`failed_orders_count\` INT NOT NULL DEFAULT 0,
        \`duration_ms\` INT UNSIGNED NULL DEFAULT NULL,
        \`started_at\` DATETIME(3) NULL DEFAULT NULL,
        \`finished_at\` DATETIME(3) NULL DEFAULT NULL,
        \`created_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        PRIMARY KEY (\`id\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    console.log('[migrate41] sync_shop_logs created');
  }

  const have = await getColumns(conn, 'sync_shop_logs');
  await addColumn(conn, 'sync_shop_logs', have, 'shop_id', 'ADD COLUMN `shop_id` BIGINT UNSIGNED NULL DEFAULT NULL AFTER `tenant_id`');
  await addColumn(conn, 'sync_shop_logs', have, 'platform_shop_id', 'ADD COLUMN `platform_shop_id` VARCHAR(128) NULL DEFAULT NULL AFTER `shop_id`');
  await addColumn(conn, 'sync_shop_logs', have, 'platform', "ADD COLUMN `platform` VARCHAR(32) NOT NULL DEFAULT 'tiktok' AFTER `platform_shop_id`");
}

async function ensureSyncLogsTable(conn) {
  await archiveLegacyTableWithoutShopId(conn, 'sync_logs', 'sync_logs_legacy_v0');

  if (!(await tableExists(conn, 'sync_logs'))) {
    await conn.query(`
      CREATE TABLE \`sync_logs\` (
        \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        \`tenant_id\` BIGINT UNSIGNED NOT NULL,
        \`shop_id\` BIGINT UNSIGNED NOT NULL,
        \`platform\` VARCHAR(32) NOT NULL DEFAULT 'tiktok',
        \`sync_job_id\` BIGINT UNSIGNED NULL DEFAULT NULL,
        \`level\` VARCHAR(16) NOT NULL DEFAULT 'info',
        \`message\` VARCHAR(512) NOT NULL,
        \`context_json\` JSON NULL,
        \`created_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        PRIMARY KEY (\`id\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    console.log('[migrate41] sync_logs created');
  }

  const have = await getColumns(conn, 'sync_logs');
  await addColumn(conn, 'sync_logs', have, 'tenant_id', 'ADD COLUMN `tenant_id` BIGINT UNSIGNED NOT NULL DEFAULT 0 AFTER `id`');
  await addColumn(conn, 'sync_logs', have, 'shop_id', 'ADD COLUMN `shop_id` BIGINT UNSIGNED NOT NULL DEFAULT 0 AFTER `tenant_id`');
  await addColumn(conn, 'sync_logs', have, 'platform', "ADD COLUMN `platform` VARCHAR(32) NOT NULL DEFAULT 'tiktok' AFTER `shop_id`");
  await addColumn(conn, 'sync_logs', have, 'sync_job_id', 'ADD COLUMN `sync_job_id` BIGINT UNSIGNED NULL DEFAULT NULL AFTER `platform`');
  await addColumn(conn, 'sync_logs', have, 'level', "ADD COLUMN `level` VARCHAR(16) NOT NULL DEFAULT 'info' AFTER `sync_job_id`");
  await addColumn(conn, 'sync_logs', have, 'message', 'ADD COLUMN `message` VARCHAR(512) NOT NULL DEFAULT \'\' AFTER `level`');
  await addColumn(conn, 'sync_logs', have, 'context_json', 'ADD COLUMN `context_json` JSON NULL AFTER `message`');
  await addColumn(conn, 'sync_logs', have, 'created_at', 'ADD COLUMN `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)');

  await createIndex(conn, 'sync_logs', 'idx_sync_logs_shop_created', 'ADD INDEX `idx_sync_logs_shop_created` (`shop_id`, `created_at`)');
  await createIndex(conn, 'sync_logs', 'idx_sync_logs_job', 'ADD INDEX `idx_sync_logs_job` (`sync_job_id`)');
  await createIndex(conn, 'sync_logs', 'idx_sync_logs_tenant_created', 'ADD INDEX `idx_sync_logs_tenant_created` (`tenant_id`, `created_at`)');
}

async function ensureShopSyncStatusTable(conn) {
  if (!(await tableExists(conn, 'shop_sync_status'))) {
    await conn.query(`
      CREATE TABLE \`shop_sync_status\` (
        \`shop_id\` BIGINT UNSIGNED NOT NULL,
        \`tenant_id\` BIGINT UNSIGNED NOT NULL,
        \`platform\` VARCHAR(32) NOT NULL DEFAULT 'tiktok',
        \`sync_status\` VARCHAR(32) NOT NULL DEFAULT 'idle',
        \`last_sync_at\` DATETIME(3) NULL DEFAULT NULL,
        \`last_success_sync_at\` DATETIME(3) NULL DEFAULT NULL,
        \`last_error\` TEXT NULL,
        \`last_error_code\` VARCHAR(64) NULL DEFAULT NULL,
        \`sync_fail_count\` INT UNSIGNED NOT NULL DEFAULT 0,
        \`is_token_valid\` TINYINT(1) NOT NULL DEFAULT 1,
        \`token_expired_at\` DATETIME(3) NULL DEFAULT NULL,
        \`current_job_id\` BIGINT UNSIGNED NULL DEFAULT NULL,
        \`sync_lock_until\` DATETIME(3) NULL DEFAULT NULL,
        \`avg_sync_ms\` INT UNSIGNED NULL DEFAULT NULL,
        \`updated_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
        PRIMARY KEY (\`shop_id\`, \`platform\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    console.log('[migrate41] shop_sync_status created');
    return;
  }

  const have = await getColumns(conn, 'shop_sync_status');
  await addColumn(conn, 'shop_sync_status', have, 'shop_id', 'ADD COLUMN `shop_id` BIGINT UNSIGNED NOT NULL FIRST');
  await addColumn(conn, 'shop_sync_status', have, 'tenant_id', 'ADD COLUMN `tenant_id` BIGINT UNSIGNED NOT NULL DEFAULT 0 AFTER `shop_id`');
  await addColumn(conn, 'shop_sync_status', have, 'platform', "ADD COLUMN `platform` VARCHAR(32) NOT NULL DEFAULT 'tiktok' AFTER `tenant_id`");
  await addColumn(conn, 'shop_sync_status', have, 'sync_status', "ADD COLUMN `sync_status` VARCHAR(32) NOT NULL DEFAULT 'idle' AFTER `platform`");
  await addColumn(conn, 'shop_sync_status', have, 'last_sync_at', 'ADD COLUMN `last_sync_at` DATETIME(3) NULL DEFAULT NULL AFTER `sync_status`');
  await addColumn(conn, 'shop_sync_status', have, 'last_success_sync_at', 'ADD COLUMN `last_success_sync_at` DATETIME(3) NULL DEFAULT NULL AFTER `last_sync_at`');
  await addColumn(conn, 'shop_sync_status', have, 'last_error', 'ADD COLUMN `last_error` TEXT NULL AFTER `last_success_sync_at`');
  await addColumn(conn, 'shop_sync_status', have, 'last_error_code', 'ADD COLUMN `last_error_code` VARCHAR(64) NULL DEFAULT NULL AFTER `last_error`');
  await addColumn(conn, 'shop_sync_status', have, 'sync_fail_count', 'ADD COLUMN `sync_fail_count` INT UNSIGNED NOT NULL DEFAULT 0 AFTER `last_error_code`');
  await addColumn(conn, 'shop_sync_status', have, 'is_token_valid', 'ADD COLUMN `is_token_valid` TINYINT(1) NOT NULL DEFAULT 1 AFTER `sync_fail_count`');
  await addColumn(conn, 'shop_sync_status', have, 'token_expired_at', 'ADD COLUMN `token_expired_at` DATETIME(3) NULL DEFAULT NULL AFTER `is_token_valid`');
  await addColumn(conn, 'shop_sync_status', have, 'current_job_id', 'ADD COLUMN `current_job_id` BIGINT UNSIGNED NULL DEFAULT NULL AFTER `token_expired_at`');
  await addColumn(conn, 'shop_sync_status', have, 'sync_lock_until', 'ADD COLUMN `sync_lock_until` DATETIME(3) NULL DEFAULT NULL AFTER `current_job_id`');
  await addColumn(conn, 'shop_sync_status', have, 'avg_sync_ms', 'ADD COLUMN `avg_sync_ms` INT UNSIGNED NULL DEFAULT NULL AFTER `sync_lock_until`');
  await addColumn(conn, 'shop_sync_status', have, 'updated_at', 'ADD COLUMN `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)');

  await createIndex(conn, 'shop_sync_status', 'idx_shop_sync_status_tenant', 'ADD INDEX `idx_shop_sync_status_tenant` (`tenant_id`, `sync_status`)');
  await createIndex(conn, 'shop_sync_status', 'idx_shop_sync_status_lock', 'ADD INDEX `idx_shop_sync_status_lock` (`sync_lock_until`)');
}

async function migrateSyncStability41(conn) {
  await ensureSyncJobsTable(conn);
  await ensureSyncLogsTable(conn);
  await ensureShopSyncStatusTable(conn);
  await ensureSyncShopLogsTable(conn);
  console.log('[migrate41] sync stability tables ok');
}

/** @param {import('mysql2/promise').Connection | import('mysql2/promise').Pool} conn */
async function verifySyncStabilitySchema(conn) {
  const required = {
    sync_jobs: [
      'id',
      'tenant_id',
      'shop_id',
      'platform',
      'job_type',
      'status',
      'priority',
      'attempt_count',
      'max_attempts',
      'locked_by',
      'locked_at',
      'started_at',
      'finished_at',
      'next_retry_at',
      'error_message',
      'created_at',
      'updated_at',
    ],
    sync_logs: [
      'id',
      'tenant_id',
      'shop_id',
      'platform',
      'sync_job_id',
      'level',
      'message',
      'context_json',
      'created_at',
    ],
    sync_shop_logs: ['shop_id'],
    shop_sync_status: [
      'shop_id',
      'tenant_id',
      'platform',
      'sync_status',
      'last_sync_at',
      'last_success_sync_at',
      'last_error',
      'last_error_code',
      'sync_fail_count',
      'is_token_valid',
      'token_expired_at',
      'current_job_id',
      'sync_lock_until',
      'avg_sync_ms',
      'updated_at',
    ],
  };

  const missing = [];
  for (const [table, cols] of Object.entries(required)) {
    if (!(await tableExists(conn, table))) {
      missing.push(`table:${table}`);
      continue;
    }
    const have = await getColumns(conn, table);
    for (const c of cols) {
      if (!have.has(c)) missing.push(`${table}.${c}`);
    }
  }

  return { ok: missing.length === 0, missing };
}

module.exports = { migrateSyncStability41, verifySyncStabilitySchema };
