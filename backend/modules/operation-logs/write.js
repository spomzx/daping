'use strict';

const { checkOperationLogWrite } = require('../../middlewares/rateLimit');
const { loadOperationLogsSchema } = require('./schemaMeta');

function detailJsonString(detail) {
  if (detail == null) return null;
  return typeof detail === 'string' ? detail : JSON.stringify(detail);
}

function jsonColValue(v) {
  if (v == null) return null;
  return typeof v === 'string' ? v : JSON.stringify(v);
}

/**
 * 写入 operation_logs（按表结构动态列；status 写入列 + detail_json）
 * @param {import('mysql2/promise').Pool} pool
 * @param {object} row
 */
async function insertOperationLogRow(pool, row) {
  if (!pool) return;
  if (!checkOperationLogWrite(row.tenant_id, row.user_id)) {
    const err = new Error('operation_log_rate_limited');
    err.code = 'RATE_LIMITED';
    throw err;
  }

  const schema = await loadOperationLogsSchema(pool);
  const detail =
    row.detail_json != null && typeof row.detail_json === 'object' ? { ...row.detail_json } : {};
  const status = String(row.status || detail.status || 'success').slice(0, 32);
  detail.status = status;

  const username =
    row.username != null
      ? String(row.username).slice(0, 128)
      : detail.username != null
        ? String(detail.username).slice(0, 128)
        : null;
  const role =
    row.role != null
      ? String(row.role).slice(0, 32)
      : detail.role != null
        ? String(detail.role).slice(0, 32)
        : null;
  const message =
    row.message != null
      ? String(row.message).slice(0, 512)
      : detail.message != null
        ? String(detail.message).slice(0, 512)
        : null;

  if (username != null) detail.username = username;
  if (role != null) detail.role = role;
  if (message != null) detail.message = message;

  const columns = ['tenant_id', 'user_id'];
  const values = [row.tenant_id ?? null, row.user_id ?? null];

  if (schema.hasUsername) {
    columns.push('username');
    values.push(username);
  }
  if (schema.hasRole) {
    columns.push('role');
    values.push(role);
  }
  if (schema.hasStatus) {
    columns.push('status');
    values.push(status);
  }
  if (schema.hasMessage) {
    columns.push('message');
    values.push(message);
  }
  if (schema.hasBeforeData) {
    columns.push('before_data');
    const bd = row.before_data !== undefined ? row.before_data : detail.before_data;
    values.push(jsonColValue(bd));
  }
  if (schema.hasAfterData) {
    columns.push('after_data');
    const ad = row.after_data !== undefined ? row.after_data : detail.after_data;
    values.push(jsonColValue(ad));
  }

  columns.push(
    'action',
    'module',
    'target_type',
    'target_id',
    'ip',
    'user_agent',
    'detail_json',
  );
  values.push(
    String(row.action || '').slice(0, 64),
    String(row.module || '').slice(0, 64),
    row.target_type != null ? String(row.target_type).slice(0, 64) : null,
    row.target_id != null ? String(row.target_id).slice(0, 128) : null,
    row.ip != null ? String(row.ip).slice(0, 64) : null,
    row.user_agent != null ? String(row.user_agent).slice(0, 512) : null,
    detailJsonString(detail),
  );

  const placeholders = columns.map(() => '?').join(', ');
  await pool.execute(`INSERT INTO operation_logs (${columns.join(', ')}) VALUES (${placeholders})`, values);
}

module.exports = { insertOperationLogRow };
