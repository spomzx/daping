'use strict';

const { getClientIp, getUserAgent } = require('./operationLog');
const { insertOperationLogRow } = require('../modules/operation-logs/write');

function jsonSafe(v) {
  if (v == null) return null;
  try {
    return typeof v === 'string' ? v : JSON.stringify(v);
  } catch {
    return null;
  }
}

function pickAuthFields(auth = {}) {
  return {
    username: auth.username != null ? String(auth.username).slice(0, 128) : null,
    role: auth.role != null ? String(auth.role).slice(0, 32) : null,
  };
}

/**
 * 统一操作审计写入（MySQL operation_logs）
 * @param {import('mysql2/promise').Pool} pool
 * @param {{
 *   tenantId?: number|null,
 *   userId?: number|null,
 *   username?: string|null,
 *   role?: string|null,
 *   action: string,
 *   module: string,
 *   targetType?: string|null,
 *   targetId?: string|number|null,
 *   beforeData?: unknown,
 *   afterData?: unknown,
 *   status?: string,
 *   message?: string|null,
 *   req?: import('express').Request,
 * }} opts
 */
async function logOperation(pool, opts = {}) {
  if (!pool) return;
  const authFields = pickAuthFields(opts.req?.auth);
  const status = String(opts.status || 'success').slice(0, 16);
  const message = opts.message != null ? String(opts.message).slice(0, 512) : null;
  const detail = {
    username: opts.username ?? authFields.username,
    role: opts.role ?? authFields.role,
    status,
    message,
    before_data: opts.beforeData ?? null,
    after_data: opts.afterData ?? null,
  };

  try {
    await insertOperationLogRow(pool, {
      tenant_id: opts.tenantId ?? opts.req?.auth?.tenant_id ?? opts.req?.tenantId ?? null,
      user_id: opts.userId ?? opts.req?.auth?.user_id ?? null,
      username: detail.username,
      role: detail.role,
      status,
      message,
      before_data: opts.beforeData ?? null,
      after_data: opts.afterData ?? null,
      action: opts.action,
      module: opts.module,
      target_type: opts.targetType ?? null,
      target_id: opts.targetId != null ? String(opts.targetId) : null,
      ip: opts.req ? getClientIp(opts.req) : null,
      user_agent: opts.req ? getUserAgent(opts.req) : null,
      detail_json: detail,
    });
  } catch (e) {
    if (e && e.code === 'RATE_LIMITED') {
      console.warn('[operationLogger] rate limited:', opts.module, opts.action);
      return;
    }
    console.error('[operationLogger] write failed:', opts.module, opts.action, e?.message || e);
  }
}

module.exports = { logOperation, jsonSafe };
