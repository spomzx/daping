import type { SaasNavItem } from '../config/saasNav'

export type BreadcrumbItem = {
  label: string
  path?: string
}

/** 返回完整面包屑（含当前页 label） */
export function resolveSaasBreadcrumb(
  pathname: string,
  navItems: SaasNavItem[],
  resolveLabel: (labelKey: string) => string,
  labels: { home: string },
): BreadcrumbItem[] {
  const normalized = pathname.replace(/\/+$/, '') || '/'
  const home: BreadcrumbItem = { label: labels.home, path: '/dashboard' }

  const match = navItems.find(
    (item) =>
      item.path !== '/legacy' &&
      (normalized === item.path || (item.path !== '/dashboard' && normalized.startsWith(`${item.path}/`))),
  )

  if (!match) {
    return normalized === '/dashboard' ? [{ label: labels.home }] : [home, { label: normalized }]
  }

  if (match.path === '/dashboard') {
    return [{ label: resolveLabel(match.labelKey) }]
  }

  return [home, { label: resolveLabel(match.labelKey) }]
}
