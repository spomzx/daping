'use strict';

const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { getJwtSecret, getJwtExpiresIn } = require('../../config/jwt');
const { findLoginContextByUsername, findLoginDiagnosticByUsername, touchLastLogin } = require('../users/service');
const { normalizeRoleFromDb } = require('../../lib/roles');
const { normalizeUserScope } = require('../../lib/userScope');
const { insertOperationLog, getClientIp, getUserAgent } = require('../../lib/operationLog');

function normStatus(v) {
  return String(v || '').trim().toLowerCase();
}

/**
 * @param {import('mysql2/promise').Pool} pool
 * @param {{ username: string, password: string, req: import('express').Request }} opts
 */
async function login(pool, { username, password, req }) {
  const ip = getClientIp(req);
  const ua = getUserAgent(req);
  const uname = String(username || '').trim();
  const diag = await findLoginDiagnosticByUsername(pool, uname);

  async function fail(error, reason, extra = {}) {
    await insertOperationLog(pool, {
      tenant_id: diag?.tenant_id ?? null,
      user_id: diag?.user_id ?? null,
      action: 'login_failed',
      module: 'auth',
      target_type: 'user',
      target_id: diag?.user_id ? String(diag.user_id) : uname,
      ip,
      user_agent: ua,
      detail_json: { username: uname, reason, error, ...extra },
    });
    return { ok: false, status: 401, error };
  }

  if (!diag) {
    return fail('password_invalid', 'user_not_found');
  }

  const tenantStatus = normStatus(diag.tenant_status);
  if (tenantStatus === 'deleted') {
    return fail('tenant_deleted', 'tenant_deleted');
  }
  if (tenantStatus === 'disabled') {
    return fail('tenant_disabled', 'tenant_disabled');
  }
  if (!diag.tenant_row_id && !diag.tenant_id) {
    return fail('tenant_not_found', 'tenant_not_found');
  }

  const userStatus = normStatus(diag.user_status);
  if (userStatus === 'disabled' || userStatus === 'deleted') {
    return fail('user_disabled', 'user_disabled');
  }

  const membershipStatus = normStatus(diag.membership_status);
  if (membershipStatus === 'disabled' || membershipStatus === 'deleted') {
    return fail('membership_disabled', 'membership_disabled');
  }

  const okPass = await bcrypt.compare(String(password || ''), String(diag.password_hash || ''));
  if (!okPass) {
    return fail('password_invalid', 'bad_password');
  }

  const row = await findLoginContextByUsername(pool, uname);
  if (!row) {
    if (tenantStatus === 'deleted') return fail('tenant_deleted', 'tenant_deleted_after_password');
    if (tenantStatus === 'disabled') return fail('tenant_disabled', 'tenant_disabled_after_password');
    return fail('membership_disabled', 'membership_inactive_after_password');
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
