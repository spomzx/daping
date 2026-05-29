'use strict';

/**
 * Phase3：扩展 operation_logs 列（幂等，字段/索引已存在则跳过）
 * node modules/operation-logs/migratePhase3.js
 */

const { getMysqlPool } = require('../../db/mysqlPool');
const { resetOperationLogsSchemaCache } = require('./schemaMeta');

async function columnExists(pool, column) {
  const [rows] = await pool.query(
    `SELECT 1 AS ok FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'operation_logs' AND COLUMN_NAME = ?
     LIMIT 1`,
    [column],
  );
  return Array.isArray(rows) && rows.length > 0;
}

async function indexExists(pool, indexName) {
  const [rows] = await pool.query(
    `SELECT 1 AS ok FROM INFORMATION_SCHEMA.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'operation_logs' AND INDEX_NAME = ?
     LIMIT 1`,
    [indexName],
  );
  return Array.isArray(rows) && rows.length > 0;
}

async function addColumnIfMissing(pool, column, alterSql) {
  if (await columnExists(pool, column)) {
    console.log('[migrate-phase3-oplog] skip column (exists):', column);
    return;
  }
  await pool.query(alterSql);
  console.log('[migrate-phase3-oplog] added column:', column);
}

async function main() {
  const pool = getMysqlPool();
  if (!pool) {
    console.error('[migrate-phase3-oplog] MySQL unavailable');
    process.exit(1);
  }

  await addColumnIfMissing(
    pool,
    'username',
    'ALTER TABLE operation_logs ADD COLUMN username VARCHAR(128) NULL AFTER user_id',
  );
  await addColumnIfMissing(
    pool,
    'role',
    'ALTER TABLE operation_logs ADD COLUMN role VARCHAR(32) NULL AFTER username',
  );
  await addColumnIfMissing(
    pool,
    'status',
    "ALTER TABLE operation_logs ADD COLUMN status VARCHAR(32) NOT NULL DEFAULT 'success' AFTER role",
  );
  await addColumnIfMissing(
    pool,
    'message',
    'ALTER TABLE operation_logs ADD COLUMN message VARCHAR(512) NULL AFTER status',
  );
  await addColumnIfMissing(
    pool,
    'before_data',
    'ALTER TABLE operation_logs ADD COLUMN before_data JSON NULL AFTER message',
  );
  await addColumnIfMissing(
    pool,
    'after_data',
    'ALTER TABLE operation_logs ADD COLUMN after_data JSON NULL AFTER before_data',
  );

  if (!(await indexExists(pool, 'idx_oplog_module_created'))) {
    await pool.query('CREATE INDEX idx_oplog_module_created ON operation_logs (module, created_at)');
    console.log('[migrate-phase3-oplog] added index: idx_oplog_module_created');
  } else {
    console.log('[migrate-phase3-oplog] skip index (exists): idx_oplog_module_created');
  }

  resetOperationLogsSchemaCache();
  console.log('[migrate-phase3-oplog] done');
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
