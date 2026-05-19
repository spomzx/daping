/** 后端 JWT / user_tenants.role（canonical：super_admin | admin | viewer） */
export const ME_ROLES = ['super_admin', 'admin', 'viewer'] as const
export type MeRole = (typeof ME_ROLES)[number]

/** 兼容旧 JWT / 库内历史枚举 */
const LEGACY_ROLE_ALIASES: Record<string, MeRole> = {
  platform_admin: 'super_admin',
  tenant_owner: 'admin',
  tenant_admin: 'admin',
  tenant_viewer: 'viewer',
}

export type AccountAccess = 'full' | 'pending_review'

export type UserScope = 'platform' | 'tenant'

export type AuthSession = {
  username: string
  role: MeRole
  scope: UserScope
  access: AccountAccess
  contact?: string | null
}

export function normalizeMeRole(role: string): MeRole | null {
  const x = String(role || '').trim()
  if ((ME_ROLES as readonly string[]).includes(x)) return x as MeRole
  const mapped = LEGACY_ROLE_ALIASES[x]
  return mapped || null
}

/** 界面展示 i18n key（禁止出现 tenant 技术字样） */
export function roleDisplayI18nKey(role: string): string | null {
  const r = normalizeMeRole(role) || String(role || '')
  if (r === 'super_admin') return 'role.super_admin'
  if (r === 'admin') return 'role.admin'
  if (r === 'viewer') return 'role.viewer'
  return null
}

/**
 * 用户列表/资料角色展示：平台管理员仅由 users.scope=platform 决定（不用 role 替代租户归属）。
 */
export function userDisplayI18nKey(scope: string | undefined, role: string | undefined): string {
  if (normalizeUserScope(scope || '') === 'platform') return 'role.super_admin'
  const r = normalizeMeRole(String(role || ''))
  if (r === 'super_admin') return 'role.admin'
  const key = roleDisplayI18nKey(String(role || ''))
  if (key) return key
  return 'role.viewer'
}

/** @deprecated 请使用 roleDisplayI18nKey + t() */
export function roleDisplayName(role: string): string {
  const key = roleDisplayI18nKey(role)
  if (key === 'role.super_admin') return '平台管理员'
  if (key === 'role.admin') return '管理员'
  if (key === 'role.viewer') return '普通用户'
  return '—'
}

export function normalizeUserScope(raw: string): UserScope {
  return String(raw || '').trim().toLowerCase() === 'platform' ? 'platform' : 'tenant'
}

export function parseAuthMeJson(j: unknown): AuthSession | null {
  const roleRaw = String((j as { user?: { role?: string } })?.user?.role || '')
  const role = normalizeMeRole(roleRaw)
  const username = String((j as { user?: { username?: string } })?.user?.username || '')
  if (!username || !role) return null
  const scopeRaw = String((j as { user?: { scope?: string } })?.user?.scope || '')
  const scope: UserScope = normalizeUserScope(scopeRaw) === 'platform' ? 'platform' : 'tenant'
  const accessRaw = String((j as { access?: string })?.access || 'full')
  const access: AccountAccess = accessRaw === 'pending_review' ? 'pending_review' : 'full'
  const c = (j as { user?: { contact?: string | null } })?.user?.contact
  const contact = c != null && String(c).trim() !== '' ? String(c) : null
  return { username, role, scope, access, contact }
}

export function isKnownMeRole(role: string): role is MeRole {
  return normalizeMeRole(role) != null
}

export function isViewerLike(role: string): boolean {
  return normalizeMeRole(role) === 'viewer'
}

/** 客户管理员或平台管理员：可管理店铺、用户等 */
export function isAdminLike(role: string): boolean {
  const r = normalizeMeRole(role)
  return r === 'admin' || r === 'super_admin'
}

export function isSuperAdmin(role: string): boolean {
  return normalizeMeRole(role) === 'super_admin'
}

/**
 * 平台级运维：与后端 lib/userScope.isPlatformScope 一致。
 * scope=platform 或 role=super_admin（含历史 platform_admin）。
 */
export function isPlatformScope(session: { scope?: UserScope; role?: string }): boolean {
  if (normalizeUserScope(String(session.scope || '')) === 'platform') return true
  return isSuperAdmin(String(session.role || ''))
}

/** 客户管理员（不含平台管理员） */
export function isCustomerAdmin(role: string): boolean {
  return normalizeMeRole(role) === 'admin'
}

/** @deprecated 使用 isCustomerAdmin */
export function isTenantOwnerLike(role: string): boolean {
  return isCustomerAdmin(role)
}
