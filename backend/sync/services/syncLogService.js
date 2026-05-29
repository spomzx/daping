'use strict';

const { getMysqlPool } = require('../../db/mysqlPool');
const { runSyncSql } = require('./syncSql');

/**
 * @param {object} row
 * @param {'info'|'warn'|'error'} [row.level]
 */
async function appendSyncLog(row) {
  const pool = getMysqlPool();
  if (!pool) return null;
  const tid = Number(row.tenant_id);
  const sid = Number(row.shop_id);
  if (!Number.isFinite(tid) || tid <= 0 || !Number.isFinite(sid) || sid <= 0) return null;

  const level = ['info', 'warn', 'error'].includes(String(row.level)) ? row.level : 'info';
  const message = String(row.message || '').slice(0, 512);
  const platform = String(row.platform || 'tiktok').slice(0, 32);
  const jobId = row.sync_job_id != null ? Number(row.sync_job_id) : null;
  let ctx = null;
  if (row.context_json != null) {
    try {
      ctx = typeof row.context_json === 'string' ? row.context_json : JSON.stringify(row.context_json);
    } catch {
      ctx = null;
    }
  }

  const [res] = await runSyncSql(pool, {
    tag: 'append_sync_log',
    table: 'sync_logs',
    sql: `INSERT INTO sync_logs (tenant_id, shop_id, platform, sync_job_id, level, message, context_json)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    params: [tid, sid, platform, Number.isFinite(jobId) ? jobId : null, level, message, ctx],
  });
  return res?.insertId ?? null;
}

module.exports = { appendSyncLog };
