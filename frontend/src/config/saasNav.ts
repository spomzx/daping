import type { MeRole, UserScope } from '../authRole'
import { isAdminLike, isPlatformScope, isViewerLike } from '../authRole'

export type SaasNavId =
  | 'warRoom'
  | 'dashboard'
  | 'shops'
  | 'orders'
  | 'authorizations'
  | 'sync'
  | 'users'
  | 'tenants'
  | 'logs'
  | 'settings'

export type SaasNavItem = {
  id: SaasNavId
  path: string
  labelKey: string
  adminOnly?: boolean
  platformOnly?: boolean
  hideForViewer?: boolean
}

export const SAAS_NAV_ITEMS: SaasNavItem[] = [
  { id: 'warRoom', path: '/legacy', labelKey: 'nav.warRoom' },
  { id: 'dashboard', path: '/dashboard', labelKey: 'saas.nav.dashboard' },
  { id: 'shops', path: '/shops', labelKey: 'saas.nav.shops' },
  { id: 'orders', path: '/orders', labelKey: 'saas.nav.orders' },
  { id: 'authorizations', path: '/authorizations', labelKey: 'saas.nav.authorizations' },
  { id: 'sync', path: '/sync', labelKey: 'saas.nav.sync' },
  { id: 'users', path: '/users', labelKey: 'saas.nav.users', adminOnly: true },
  { id: 'tenants', path: '/tenants', labelKey: 'saas.nav.tenants', platformOnly: true },
  { id: 'logs', path: '/logs', labelKey: 'saas.nav.logs', adminOnly: true },
  { id: 'settings', path: '/settings', labelKey: 'saas.nav.settings', adminOnly: true },
]

export function filterSaasNav(
  items: SaasNavItem[],
  role: MeRole,
  scope: UserScope | undefined,
): SaasNavItem[] {
  const platform = isPlatformScope({ scope, role })
  return items.filter((item) => {
    if (item.hideForViewer && isViewerLike(role)) return false
    if (item.platformOnly && !platform) return false
    if (item.adminOnly && !platform && !isAdminLike(role)) return false
    return true
  })
}
