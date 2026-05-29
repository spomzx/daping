'use strict';

const { getMysqlPool } = require('../../db/mysqlPool');
const { isMysqlConfigured } = require('../../config/database');
const { login: loginService } = require('./service');
const { registerPublicTenantOwner } = require('./registerService');
const { getMeProfile } = require('../users/service');
const { getTenantPlan } = require('../tenants/planService');
const { normalizeRoleFromDb, isReadOnlyRole } = require('../../lib/roles');
const { normalizeUserScope, isPlatformScopeUser } = require('../../lib/userScope');

function dbMisconfigured503(res) {
  return res.status(503).json({
    error: 'database_not_configured',
    message: 'MySQL 未配置：请设置 DB_HOST、DB_USER、DB_NAME（及 DB_PASSWORD / DB_PORT）后重试',
  });
}

async function login(req, res) {
  if (!isMysqlConfigured()) {
    return dbMisconfigured503(res);
  }
  const pool = getMysqlPool();
  if (!pool) {
    return res.status(503).json({
      error: 'database_unavailable',
      message: 'MySQL 连接池不可用',
    });
  }
  const username = req.body && req.body.username;
  const password = req.body && req.body.password;
  const out = await loginService(pool, { username, password, req });
  if (!out.ok) {
    return res.status(out.status || 401).json({ error: out.error });
  }
  return res.json({ token: out.token, user: out.user });
}

async function register(req, res) {
  if (req.auth && isReadOnlyRole(req.auth.role)) {
    return res.status(403).json({ error: 'forbidden', message: '普通用户无法注册新账号' });
  }
  if (!isMysqlConfigured()) {
    return dbMisconfigured503(res);
  }
  const pool = getMysqlPool();
  if (!pool) {
    return res.status(503).json({
      error: 'database_unavailable',
      message: 'MySQL 连接池不可用',
    });
  }
  try {
    const out = await registerPublicTenantOwner(pool, req.body || {});
    if (!out.ok) {
      return res.status(out.status || 400).json({ error: out.error });
    }
    return res.status(201).json({
      ok: true,
      tenant_id: out.tenant_id,
      user_id: out.user_id,
      username: out.username,
      tenant_code: out.tenant_code,
    });
  } catch (e) {
    console.error('[auth/register]', e && e.message ? e.message : e);
    return res.status(500).json({ error: 'register_failed' });
  }
}

function logout(req, res) {
  res.json({ ok: true });
}

async function me(req, res) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  if (!isMysqlConfigured()) {
    return dbMisconfigured503(res);
  }
  const pool = getMysqlPool();
  if (!pool) {
    return res.status(503).json({
      error: 'database_unavailable',
      message: 'MySQL 连接池不可用',
    });
  }
  const row = await getMeProfile(pool, req.auth.user_id, req.auth.tenant_id);
  if (!row) {
    return res.status(401).json({ error: 'inactive_account' });
  }
  const us = String(row.user_status || '');
  const ms = String(row.membership_status || '');
  const ts = String(row.tenant_status || '');
  if (us === 'disabled' || us === 'deleted' || ms === 'disabled' || ms === 'deleted') {
    return res.status(401).json({ error: 'inactive_account' });
  }
  if (ts === 'disabled' || ts === 'deleted') {
    return res.status(401).json({ error: 'inactive_account' });
  }
  const pending = us === 'pending_review' || ms === 'pending_review' || ts === 'pending_review';
  const access = pending ? 'pending_review' : 'full';
  const scope = normalizeUserScope(row.user_scope);
  const platformScope = isPlatformScopeUser({ scope, role: row.role });
  let planPayload = null;
  if (!platformScope && pool) {
    planPayload = await getTenantPlan(pool, req.auth.tenant_id);
  }
  return res.json({
    user: {
      id: Number(row.id),
      username: row.username,
      display_name: row.display_name,
      contact: row.contact != null ? String(row.contact) : null,
      status: row.user_status,
      last_login_at: row.last_login_at,
      created_at: row.created_at,
      updated_at: row.updated_at,
      tenant_id: Number(row.tenant_id),
      role: normalizeRoleFromDb(row.role),
      scope,
      membership_status: row.membership_status,
    },
    tenant: {
      id: Number(row.tenant_row_id),
      tenant_code: row.tenant_code,
      tenant_name: row.tenant_name,
      status: row.tenant_status,
      max_shops: platformScope ? null : planPayload?.shop_limit ?? row.max_shops,
      shop_limit: platformScope ? null : planPayload?.shop_limit ?? row.shop_limit,
      max_users: platformScope ? null : planPayload?.max_users ?? row.max_users,
      current_shops: platformScope ? null : planPayload?.current_shops ?? null,
      current_users: platformScope ? null : planPayload?.current_users ?? null,
      expires_at: platformScope ? null : planPayload?.expires_at ?? row.expires_at,
      is_active: platformScope ? null : planPayload?.is_active ?? row.is_active,
      plan_remark: platformScope ? null : planPayload?.plan_remark ?? row.plan_remark,
      base_currency: row.base_currency,
      timezone: row.timezone,
      plan_type: planPayload?.plan_type ?? row.plan_type,
    },
    plan: platformScope ? null : planPayload,
    access,
  });
}

module.exports = { login, logout, me, register };
