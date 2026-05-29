'use strict';

const { logOperation } = require('../../lib/operationLogger');

/**
 * 从 Express 请求写入审计（供 users / tenants / shops / sync 调用）
 * @param {import('mysql2/promise').Pool} pool
 * @param {import('express').Request} req
 * @param {object} payload
 */
async function auditFromRequest(pool, req, payload = {}) {
  if (!pool || !req?.auth) return;
  const tid =
    payload.tenantId != null
      ? Number(payload.tenantId)
      : Number(req.tenantId) || Number(req.auth.tenant_id) || null;
  await logOperation(pool, {
    ...payload,
    tenantId: Number.isFinite(tid) && tid > 0 ? tid : null,
    userId: req.auth.user_id,
    username: req.auth.username,
    role: req.auth.role,
    req,
  });
}

module.exports = { auditFromRequest };
