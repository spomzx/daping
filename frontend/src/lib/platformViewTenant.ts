const STORAGE_KEY = 'daping_platform_view_tenant_id'

const TENANT_QUERY_PREFIXES = [
  '/api/dashboard',
  '/api/gmv/current',
  '/api/analytics',
  '/api/shops',
  '/api/sync',
]

export function getPlatformViewTenantId(): number | null {
  if (typeof window === 'undefined') return null
  const raw = sessionStorage.getItem(STORAGE_KEY)
  if (!raw) return null
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : null
}

export function setPlatformViewTenantId(tenantId: number | null): void {
  if (typeof window === 'undefined') return
  if (tenantId == null || !Number.isFinite(tenantId) || tenantId <= 0) {
    sessionStorage.removeItem(STORAGE_KEY)
  } else {
    sessionStorage.setItem(STORAGE_KEY, String(Math.floor(tenantId)))
  }
  window.dispatchEvent(new CustomEvent('daping:platform-view-tenant'))
}

export function appendPlatformViewTenantQuery(path: string): string {
  const tid = getPlatformViewTenantId()
  if (!tid) return path
  if (!TENANT_QUERY_PREFIXES.some((p) => path.startsWith(p))) return path
  try {
    const base = typeof window !== 'undefined' ? window.location.origin : 'http://local'
    const u = new URL(path, base)
    if (!u.searchParams.has('tenant_id')) {
      u.searchParams.set('tenant_id', String(tid))
    }
    return `${u.pathname}${u.search}`
  } catch {
    if (path.includes('tenant_id=')) return path
    const sep = path.includes('?') ? '&' : '?'
    return `${path}${sep}tenant_id=${tid}`
  }
}
