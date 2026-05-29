#!/usr/bin/env node
/**
 * Phase-4.2 staging 压测审计：输出 sync_jobs / lock / 重复 active job 检查
 * 用法：node scripts/syncStagingAudit.js
 */
const path = require('path');

try {
  require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
} catch (_) {}

const { getMysqlPool } = require('../db/mysqlPool');
const { describeSyncMode } = require('../sync/services/syncEnv');
const { migrateSyncStability41, verifySyncStabilitySchema } = require('../db/migrateSyncStability41');

async function runQuery(pool, label, sql) {
  const [rows] = await pool.query(sql);
  console.log(`\n=== ${label} ===`);
  console.table(rows);
  return rows;
}

async function main() {
  console.log('[sync-audit] env', JSON.stringify(describeSyncMode(), null, 2));

  const pool = getMysqlPool();
  if (!pool) {
    console.error('[sync-audit] mysql_unavailable');
    process.exit(1);
  }

  const conn = await pool.getConnection();
  try {
    await migrateSyncStability41(conn);
    const v = await verifySyncStabilitySchema(conn);
    console.log('\n=== schema verify ===');
    console.log(v.ok ? 'PASS' : `FAIL ${(v.missing || []).join(', ')}`);
    if (!v.ok) {
      console.error(
        '[sync-audit] required shop_id: sync_jobs, sync_logs, shop_sync_status, sync_shop_logs — run node db/init.js',
      );
      process.exit(2);
    }
  } finally {
    conn.release();
  }

  await runQuery(
    pool,
    'sync_jobs by status',
    `SELECT status, COUNT(*) AS cnt FROM sync_jobs GROUP BY status ORDER BY cnt DESC`,
  );

  const dupActive = await runQuery(
    pool,
    'duplicate active jobs per shop (must be empty)',
    `SELECT tenant_id, shop_id, platform, COUNT(*) AS cnt
     FROM sync_jobs
     WHERE status IN ('queued','running','retry_wait')
     GROUP BY tenant_id, shop_id, platform
     HAVING COUNT(*) > 1`,
  );

  await runQuery(
    pool,
    'stale sync_lock_until (must be empty)',
    `SELECT shop_id, tenant_id, platform, sync_status, sync_lock_until, current_job_id
     FROM shop_sync_status
     WHERE sync_lock_until IS NOT NULL AND sync_lock_until < NOW(3)`,
  );

  await runQuery(
    pool,
    'running jobs older than 15min',
    `SELECT id, tenant_id, shop_id, status, locked_by, started_at,
            TIMESTAMPDIFF(SECOND, started_at, NOW(3)) AS running_sec
     FROM sync_jobs
     WHERE status = 'running' AND started_at < DATE_SUB(NOW(3), INTERVAL 15 MINUTE)
     ORDER BY started_at ASC
     LIMIT 20`,
  );

  await runQuery(
    pool,
    'retry_wait due now',
    `SELECT id, tenant_id, shop_id, attempt_count, next_retry_at, error_message
     FROM sync_jobs
     WHERE status = 'retry_wait' AND (next_retry_at IS NULL OR next_retry_at <= NOW(3))
     ORDER BY next_retry_at ASC
     LIMIT 20`,
  );

  await runQuery(
    pool,
    'shop_sync_status summary',
    `SELECT sync_status, COUNT(*) AS cnt FROM shop_sync_status GROUP BY sync_status`,
  );

  const ok = (!dupActive || dupActive.length === 0);
  console.log(`\n[sync-audit] duplicate_active_check=${ok ? 'PASS' : 'FAIL'}`);
  process.exit(ok ? 0 : 2);
}

main().catch((e) => {
  console.error('[sync-audit] fatal', e?.message || e);
  process.exit(1);
});
