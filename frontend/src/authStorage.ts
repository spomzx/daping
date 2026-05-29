/**
 * 浏览器本地认证相关存储（按设备/浏览器，不上传服务器）：
 * - `daping_auth_token`：登录成功后的 JWT
 * - `daping_last_username`：上次登录用户名（仅登录页记忆，禁止存密码）
 *
 * 登录/校验/退出接口见 `apiClient.ts`。SPA 路由 `/login` 不是 API。
 */
import { isPublicRoute } from './authRoutes'

export const AUTH_TOKEN_KEY = 'daping_auth_token'
/** 登录页记住的用户名（localStorage，禁止存密码） */
export const LAST_USERNAME_KEY = 'daping_last_username'

export function readLastUsername(): string {
  try {
    return localStorage.getItem(LAST_USERNAME_KEY) || ''
  } catch {
    return ''
  }
}

export function saveLastUsername(username: string): void {
  try {
    const u = username.trim()
    if (u) localStorage.setItem(LAST_USERNAME_KEY, u)
    else clearLastUsername()
  } catch {
    /* ignore */
  }
}

/** 清除登录页记住的用户名（不清 token） */
export function clearLastUsername(): void {
  try {
    localStorage.removeItem(LAST_USERNAME_KEY)
  } catch {
    /* ignore */
  }
}

export function getAuthHeaders(): Record<string, string> {
  try {
    const t = localStorage.getItem(AUTH_TOKEN_KEY)
    if (t) return { Authorization: `Bearer ${t}` }
  } catch {
    /* ignore */
  }
  return {}
}

/** 与 AppShell 校验失败时一致：清 token 并回到登录页（整页跳转，避免 Router 状态与 token 不一致） */
export function clearAuthAndRedirectToLogin(): void {
  try {
    localStorage.removeItem(AUTH_TOKEN_KEY)
  } catch {
    /* ignore */
  }
  if (typeof window === 'undefined') return
  const p = window.location.pathname || ''
  if (isPublicRoute(p)) return
  window.location.replace('/login')
}
