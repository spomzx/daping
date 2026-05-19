'use strict';

const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { getJwtSecret, getJwtExpiresIn } = require('../../config/jwt');
const { findLoginContextByUsername, touchLastLogin } = require('../users/service');
const { normalizeRoleFromDb } = require('../../lib/roles');
const { normalizeUserScope } = require('../../lib/userScope');
const { insertOperationLog, getClientIp, getUserAgent } = require('../../lib/operationLog');

function isLoginBlockedStatus(v) {
  const s = String(v || '').trim();
  return s === 'disabled' || s === 'deleted';
}

async function login(pool, { username, password, req }) {
  const ip = getClientIp(req);
  const ua = getUserAgent(req);
  const row = await findLoginContextByUsername(pool, username);
  const failDetail = { username: String(username || '').trim(), reason: 'bad_credentials' };

  if (!row) {
    await insertOperationLog(pool, {
      tenant_id: null,
      user_id: null,
      action: 'login_failed',
      module: 'auth',
      target_type: 'user',
      target_id: String(username || '').trim(),
      ip,
      user_agent: ua,
      detail_json: failDetail,
    });
    return { ok: false, status: 401, error: 'invalid_credentials' };
  }

  if (
    isLoginBlockedStatus(row.user_status) ||
    isLoginBlockedStatus(row.membership_status) ||
    isLoginBlockedStatus(row.tenant_status)
  ) {
    await insertOperationLog(pool, {
      tenant_id: row.tenant_id,
      user_id: row.user_id,
      action: 'login_failed',
      module: 'auth',
      target_type: 'user',
      target_id: String(username || '').trim(),
      ip,
      user_agent: ua,
      detail_json: { ...failDetail, reason: 'account_disabled' },
    });
    return { ok: false, status: 401, error: 'invalid_credentials' };
  }

  const okPass = await bcrypt.compare(String(password || ''), String(row.password_hash || ''));
  if (!okPass) {
    await insertOperationLog(pool, {
      tenant_id: row.tenant_id,
      user_id: row.user_id,
      action: 'login_failed',
      module: 'auth',
      target_type: 'user',
      target_id: String(row.user_id),
      ip,
      user_agent: ua,
      detail_json: failDetail,
    });
    return { ok: false, status: 401, error: 'invalid_credentials' };
  }

  const scope = normalizeUserScope(row.user_scope);
  const payload = {
    user_id: row.user_id,
    tenant_id: row.tenant_id,
    role: normalizeRoleFromDb(row.role),
    username: row.username,
    scope,
  };
  const token = jwt.sign(payload, getJwtSecret(), { expiresIn: getJwtExpiresIn() });
  await touchLastLogin(pool, row.user_id);

  await insertOperationLog(pool, {
    tenant_id: row.tenant_id,
    user_id: row.user_id,
    action: 'login_success',
    module: 'auth',
    target_type: 'user',
    target_id: String(row.user_id),
    ip,
    user_agent: ua,
    detail_json: { username: row.username, role: normalizeRoleFromDb(row.role) },
  });

  const role = normalizeRoleFromDb(row.role);
  return {
    ok: true,
    token,
    user: {
      id: row.user_id,
      username: row.username,
      display_name: row.display_name,
      tenant_id: row.tenant_id,
      tenant_code: row.tenant_code,
      tenant_name: row.tenant_name,
      role,
      scope,
    },
  };
}

module.exports = { login };
