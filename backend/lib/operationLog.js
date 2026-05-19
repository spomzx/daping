'use strict';

const { checkOperationLogWrite } = require('../middlewares/rateLimit');

function getClientIp(req) {
  const xf = req.headers['x-forwarded-for'];
  if (xf) {
    const first = String(xf).split(',')[0].trim();
    if (first) return first.slice(0, 64);
  }
  const ip = req.ip || req.socket?.remoteAddress || '';
  return String(ip).slice(0, 64);
}

function getUserAgent(req) {
  return String(req.headers['user-agent'] || '').slice(0, 512);
}

/**
 * @param {import('mysql2/promise').Pool} pool
 * @param {object} row
 */
async function insertOperationLog(pool, row) {
  if (!checkOperationLogWrite(row.tenant_id, row.user_id)) {
    const err = new Error('operation_log_rate_limited');
    err.code = 'RATE_LIMITED';
    throw err;
  }
  const detailJson =
    row.detail_json == null
      ? null
      : typeof row.detail_json === 'string'
        ? row.detail_json
        : JSON.stringify(row.detail_json);
  await pool.execute(
    `INSERT INTO operation_logs (tenant_id, user_id, action, module, target_type, target_id, ip, user_agent, detail_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.tenant_id ?? null,
      row.user_id ?? null,
      String(row.action || '').slice(0, 64),
      String(row.module || '').slice(0, 64),
      row.target_type != null ? String(row.target_type).slice(0, 64) : null,
      row.target_id != null ? String(row.target_id).slice(0, 128) : null,
      row.ip != null ? String(row.ip).slice(0, 64) : null,
      row.user_agent != null ? String(row.user_agent).slice(0, 512) : null,
      detailJson,
    ],
  );
}

module.exports = { insertOperationLog, getClientIp, getUserAgent };
