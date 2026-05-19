/** 无需登录即可访问的 SPA 路由（与 AppShell 守卫一致） */
export const PUBLIC_ROUTES = ['/login', '/register', '/pending-review'] as const

export type PublicRoute = (typeof PUBLIC_ROUTES)[number]

export function normalizePathname(pathname: string): string {
  const p = String(pathname || '').trim()
  if (!p || p === '/') return '/'
  return p.replace(/\/+$/, '') || '/'
}

export function isPublicRoute(pathname: string): boolean {
  const norm = normalizePathname(pathname)
  return (PUBLIC_ROUTES as readonly string[]).includes(norm)
}

/** 注册成功后暂存联系方式，供公开待审核页展示 */
export const REGISTER_PENDING_CONTACT_KEY = 'register_pending_contact'
