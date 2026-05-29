'use strict';

const { isAdminFamily, SQL_ADMIN_ROLES_IN, SQL_VIEWER_ROLES_IN } = require('./roles');
const { isPlatformScopeUser } = require('./userScope');

/** 与 users 列表、租户 current_users 展示共用的活跃口径 */
const SQL_ACTIVE_USER = "u.status NOT IN ('disabled','deleted')";
const SQL_ACTIVE_MEMBERSHIP = "ut.status NOT IN ('disabled','deleted')";

/** 平台 /users 与 /tenants 用户数：非 viewer 成员（含平台与客户管理员） */
const COUNT_MODE_PLATFORM_LIST = 'platform_list';

/** 套餐配额：租户下全部活跃成员（含 viewer） */
const COUNT_MODE_QUOTA = 'quota';

/** 租户管理员 /users：仅 viewer 子账号 */
const COUNT_MODE_TENANT_SUB = 'tenant_sub';

function actorHasPlatformPrivileges(auth) {
  return isPlatformScopeUser({ scope: auth && auth.scope, role: auth && auth.role });
}

/**
 * 构建用户列表 WHERE（与 listUsersForActor 一致）
 * @param {{ user_id?: number, tenant_id?: number, role?: string, scope?: string }} auth
 * @param {Record<string, unknown>} [query]
 * @returns {{ ok: boolean, status?: number, error?: string, whereSql?: string, params?: unknown[], empty?: boolean }}
 */
function buildListUsersWhere(auth, query = {}) {
  const role = String(auth.role || '');
  const parts = [];
  const params = [];

  const platformActor = actorHasPlatformPrivileges(auth);

  if (platformActor) {
    parts.push(`ut.role NOT IN (${SQL_VIEWER_ROLES_IN})`);
  } else if (isAdminFamily(role)) {
    parts.push('ut.tenant_id = ?');
    params.push(auth.tenant_id);
    parts.push(`ut.role IN (${SQL_VIEWER_ROLES_IN})`);
  } else {
    return { ok: false, status: 403, error: 'forbidden' };
  }

  parts.push(SQL_ACTIVE_USER);
  parts.push(SQL_ACTIVE_MEMBERSHIP);

  const keyword = String(query.keyword || query.q || '').trim();
  if (keyword) {
    parts.push('(u.username LIKE ? OR u.display_name LIKE ? OR u.contact LIKE ?)');
    const like = `%${keyword}%`;
    params.push(like, like, like);
  }

  const roleFilter = String(query.role || '').trim().toLowerCase();
  if (roleFilter) {
    if (platformActor) {
      if (roleFilter === 'viewer' || roleFilter === 'tenant_viewer') {
        return { ok: true, empty: true, whereSql: '1=0', params: [] };
      }
      if (roleFilter === 'super_admin') {
        parts.push(`ut.role IN ('super_admin','platform_admin')`);
      } else if (roleFilter === 'admin') {
        parts.push(`ut.role IN (${SQL_ADMIN_ROLES_IN})`);
      }
    } else if (roleFilter !== 'viewer' && roleFilter !== 'tenant_viewer') {
      return { ok: true, empty: true, whereSql: '1=0', params: [] };
    }
  }

  const statusFilter = String(query.status || '').trim().toLowerCase();
  if (statusFilter === 'active' || statusFilter === 'disabled') {
    parts.push('(u.status = ? OR ut.status = ?)');
    params.push(statusFilter, statusFilter);
  } else if (statusFilter === 'pending_review') {
    parts.push('(u.status = ? OR ut.status = ?)');
    params.push('pending_review', 'pending_review');
  }

  return { ok: true, whereSql: parts.join(' AND '), params, empty: false };
}

/**
 * @param {number} tenantId
 * @param {'platform_list'|'quota'|'tenant_sub'} mode
 */
function buildTenantUserCountWhere(tenantId, mode = COUNT_MODE_QUOTA) {
  const parts = ['ut.tenant_id = ?', SQL_ACTIVE_MEMBERSHIP, SQL_ACTIVE_USER];
  const params = [tenantId];

  if (mode === COUNT_MODE_PLATFORM_LIST) {
    parts.push(`ut.role NOT IN (${SQL_VIEWER_ROLES_IN})`);
  } else if (mode === COUNT_MODE_TENANT_SUB) {
    parts.push(`ut.role IN (${SQL_VIEWER_ROLES_IN})`);
  }

  return { whereSql: parts.join(' AND '), params };
}

/**
 * @param {import('mysql2/promise').Pool} pool
 * @param {number} tenantId
 * @param {'platform_list'|'quota'|'tenant_sub'} [mode]
 */
async function countUsersForTenant(pool, tenantId, mode = COUNT_MODE_QUOTA) {
  const tid = Number(tenantId);
  if (!Number.isFinite(tid) || tid <= 0) return 0;
  const { whereSql, params } = buildTenantUserCountWhere(tid, mode);
  const [rows] = await pool.query(
    `SELECT COUNT(DISTINCT u.id) AS c
     FROM users u
     INNER JOIN user_tenants ut ON ut.user_id = u.id
     WHERE ${whereSql}`,
    params,
  );
  return Number(rows?.[0]?.c) || 0;
}

module.exports = {
  SQL_ACTIVE_USER,
  SQL_ACTIVE_MEMBERSHIP,
  COUNT_MODE_PLATFORM_LIST,
  COUNT_MODE_QUOTA,
  COUNT_MODE_TENANT_SUB,
  actorHasPlatformPrivileges,
  buildListUsersWhere,
  buildTenantUserCountWhere,
  countUsersForTenant,
};
