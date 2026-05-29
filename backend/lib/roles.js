'use strict';

/**
 * SaaS 角色（锁版）：仅 super_admin | admin | viewer。
 * 读入兼容历史枚举并映射为三者之一；platform_admin 并入 super_admin。
 */

function normalizeRoleFromDb(role) {
  const x = String(role || '').trim();
  if (x === 'super_admin' || x === 'platform_admin') return 'super_admin';
  if (x === 'viewer' || x === 'tenant_viewer') return 'viewer';
  if (x === 'admin' || x === 'tenant_owner' || x === 'tenant_admin') return 'admin';
  return x;
}

/** @deprecated 请使用 userScope.isPlatformScope；保留别名避免遗漏调用点 */
function isPlatformAdmin(roleOrUser) {
  const { isPlatformScope } = require('./userScope');
  if (roleOrUser && typeof roleOrUser === 'object') {
    return isPlatformScope(roleOrUser);
  }
  return isPlatformScope({ role: roleOrUser });
}

/** 新写入 user_tenants.role 仅落库 canonical 三值 */
function normalizeRoleForStorage(role) {
  const x = String(role || '').trim();
  if (x === 'super_admin' || x === 'platform_admin') return 'super_admin';
  return normalizeRoleFromDb(x);
}

/** 用户管理 / analytics 租户隔离等；平台店铺范围请用 userScope.isPlatformScopeUser */
function isSuperAdmin(role) {
  const r =
    role && typeof role === 'object' ? role.role ?? role : role;
  return normalizeRoleFromDb(r) === 'super_admin';
}

function isAdminFamily(role) {
  const r = role && typeof role === 'object' ? role.role ?? role : role;
  return normalizeRoleFromDb(r) === 'admin';
}

function isReadOnlyRole(role) {
  const r = role && typeof role === 'object' ? role.role ?? role : role;
  return normalizeRoleFromDb(r) === 'viewer';
}

/** SQL IN：管理员类（含历史枚举；不含 super_admin 时用于「客户主账号 pending」等） */
const SQL_ADMIN_ROLES_IN = "'admin','tenant_owner','tenant_admin'";

/** SQL IN：只读类（含历史枚举） */
const SQL_VIEWER_ROLES_IN = "'viewer','tenant_viewer'";

/** SQL IN：含 super_admin 的成员角色查询 */
const SQL_ANY_ADMIN_INCLUDING_SUPER = "'super_admin','platform_admin','admin','tenant_owner','tenant_admin'";

module.exports = {
  normalizeRoleFromDb,
  normalizeRoleForStorage,
  isSuperAdmin,
  isPlatformAdmin,
  isAdminFamily,
  isReadOnlyRole,
  SQL_ADMIN_ROLES_IN,
  SQL_VIEWER_ROLES_IN,
  SQL_ANY_ADMIN_INCLUDING_SUPER,
};
