'use strict';

/**
 * 用户 scope（tenant | platform）判断。
 * 禁止 require roles 模块，避免与 roles.js 循环依赖。
 */

const USER_SCOPE_TENANT = 'tenant';
const USER_SCOPE_PLATFORM = 'platform';

/** 历史角色视为平台运维（与 users.scope=platform 等价） */
const LEGACY_PLATFORM_ROLES = new Set(['super_admin', 'platform_admin']);

function normalizeUserScope(value) {
  const s = String(value || '').trim().toLowerCase();
  if (s === USER_SCOPE_PLATFORM) return USER_SCOPE_PLATFORM;
  return USER_SCOPE_TENANT;
}

function extractRoleString(role) {
  const r = role && typeof role === 'object' ? role.role ?? role : role;
  return String(r || '').trim();
}

/** 本地归一化：super_admin / platform_admin → 平台角色 */
function normalizePlatformRole(role) {
  const x = extractRoleString(role);
  if (LEGACY_PLATFORM_ROLES.has(x)) return 'super_admin';
  return x;
}

function isLegacyPlatformRole(role) {
  return LEGACY_PLATFORM_ROLES.has(extractRoleString(role));
}

/**
 * 全项目统一的「平台级」判断（大屏 tenant 隔离、analytics 等必须只用此函数）。
 * @param {{ scope?: string, role?: string } | null | undefined} auth
 */
function isPlatformScope(auth) {
  if (!auth || typeof auth !== 'object') return false;
  const scope = normalizeUserScope(auth.scope);
  const role = normalizeRoleFromDb(auth.role);
  return scope === USER_SCOPE_PLATFORM || role === 'super_admin';
}

/** 与 roles.normalizeRoleFromDb 等价，本地实现避免 userScope → roles 循环依赖 */
function normalizeRoleFromDb(role) {
  const x = extractRoleString(role);
  if (x === 'super_admin' || x === 'platform_admin') return 'super_admin';
  if (x === 'viewer' || x === 'tenant_viewer') return 'viewer';
  if (x === 'admin' || x === 'tenant_owner' || x === 'tenant_admin') return 'admin';
  return x;
}

/**
 * 平台级运维（兼容旧名；与 {@link isPlatformScope} 等价）。
 * @param {{ scope?: string, role?: string } | string | null | undefined} authOrRole
 */
function isPlatformScopeUser(authOrRole) {
  if (authOrRole && typeof authOrRole === 'object') {
    return isPlatformScope(authOrRole);
  }
  return isLegacyPlatformRole(authOrRole);
}

function isTenantScopeUser(authOrRole) {
  return !isPlatformScopeUser(authOrRole);
}

/** Express req.auth / req.user */
function isPlatformScopeFromRequest(auth) {
  return isPlatformScope(auth);
}

module.exports = {
  USER_SCOPE_TENANT,
  USER_SCOPE_PLATFORM,
  LEGACY_PLATFORM_ROLES,
  normalizeUserScope,
  normalizePlatformRole,
  isPlatformScope,
  isPlatformScopeUser,
  isTenantScopeUser,
  isPlatformScopeFromRequest,
};
