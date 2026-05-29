import type { MeRole, UserScope } from '../authRole'
import { isAdminLike, isPlatformScope, isViewerLike } from '../authRole'

export type SaasNavId =
  | 'warRoom'
  | 'dashboard'
  | 'shops'
  | 'orders'
  | 'authorizations'
  | 'sync'
  | 'syncJobs'
  | 'users'
  | 'tenants'
  | 'logs'
  | 'settings'

export type SaasNavItem = {
  id: SaasNavId
  path: string
  labelKey: string
  icon?: string
  adminOnly?: boolean
  platformOnly?: boolean
  hideForViewer?: boolean
}

export type SaasNavGroup = {
  id: string
  labelKey: string
  itemIds: SaasNavId[]
}

export const SAAS_NAV_ITEMS: SaasNavItem[] = [
  { id: 'warRoom', path: '/legacy', labelKey: 'nav.warRoom', icon: 'war' },
  { id: 'dashboard', path: '/dashboard', labelKey: 'saas.nav.dashboard', icon: 'chart' },
  { id: 'shops', path: '/shops', labelKey: 'saas.nav.shops', icon: 'shop' },
  { id: 'orders', path: '/orders', labelKey: 'saas.nav.orders', icon: 'order' },
  { id: 'authorizations', path: '/authorizations', labelKey: 'saas.nav.authorizations', icon: 'key' },
  { id: 'sync', path: '/sync', labelKey: 'saas.nav.sync', icon: 'sync' },
  { id: 'syncJobs', path: '/admin/sync-jobs', labelKey: 'saas.nav.syncJobs', icon: 'job', adminOnly: true },
  { id: 'users', path: '/users', labelKey: 'saas.nav.users', icon: 'users', adminOnly: true },
  { id: 'tenants', path: '/tenants', labelKey: 'saas.nav.tenants', icon: 'tenant', platformOnly: true },
  { id: 'logs', path: '/logs', labelKey: 'saas.nav.logs', icon: 'log', adminOnly: true },
  { id: 'settings', path: '/settings', labelKey: 'saas.nav.settings', icon: 'settings', adminOnly: true },
]

export const SAAS_NAV_GROUPS: SaasNavGroup[] = [
  {
    id: 'business',
    labelKey: 'saas.nav.group.business',
    itemIds: ['warRoom', 'dashboard', 'shops', 'orders', 'authorizations', 'sync'],
  },
  {
    id: 'system',
    labelKey: 'saas.nav.group.system',
    itemIds: ['syncJobs', 'users', 'tenants', 'logs', 'settings'],
  },
]

export function groupSaasNavItems(items: SaasNavItem[]): { group: SaasNavGroup; items: SaasNavItem[] }[] {
  const byId = new Map(items.map((item) => [item.id, item]))
  return SAAS_NAV_GROUPS.map((group) => ({
    group,
    items: group.itemIds.map((id) => byId.get(id)).filter((item): item is SaasNavItem => Boolean(item)),
  })).filter((g) => g.items.length > 0)
}

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
