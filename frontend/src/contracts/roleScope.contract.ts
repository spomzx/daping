import { isPlatformScope, normalizeMeRole, type UserScope } from '../authRole'
import { getPlatformViewTenantId } from '../lib/platformViewTenant'

export type RoleScopeKind = 'platform' | 'tenant_admin' | 'normal_user'

export function resolveRoleScopeKind(role: string, scope?: UserScope): RoleScopeKind {
  if (isPlatformScope({ role, scope })) return 'platform'
  const normalized = normalizeMeRole(role)
  return normalized === 'admin' ? 'tenant_admin' : 'normal_user'
}

/**
 * 平台管理员：tenant 可选，未选即全平台（fallback all）
 * 其余角色：由后端 token 约束，不在前端拼 tenant 参数
 */
export function resolveOptionalTenantQuery(role: string, scope?: UserScope): { tenantId?: number } {
  const kind = resolveRoleScopeKind(role, scope)
  if (kind !== 'platform') return {}
  const selectedTenantId = getPlatformViewTenantId()
  return selectedTenantId != null ? { tenantId: selectedTenantId } : {}
}

export function isTenantSelectionError(message: string): boolean {
  const text = String(message || '').toLowerCase()
  return text.includes('missing_selected_tenant') || text.includes('tenant required')
}
