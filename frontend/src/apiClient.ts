import { AUTH_TOKEN_KEY, clearAuthAndRedirectToLogin, getAuthHeaders } from './authStorage'
import { appendPlatformViewTenantQuery } from './lib/platformViewTenant'

export { AUTH_TOKEN_KEY, clearAuthAndRedirectToLogin, getAuthHeaders }

const AUTH_ME_TIMEOUT_MS = 8000

/** 认证接口路径字面量（禁止出现页面路由 `/login` 作为 API） */
const URL_AUTH_LOGIN = '/api/auth/login' as const
const URL_AUTH_ME = '/api/auth/me' as const
const URL_AUTH_LOGOUT = '/api/auth/logout' as const

export const AUTH_API = {
  LOGIN: URL_AUTH_LOGIN,
  ME: URL_AUTH_ME,
  LOGOUT: URL_AUTH_LOGOUT,
} as const

/**
 * 仅用于 login / me / logout：用字符串拼接出最终 URL，不经过「path 归一化」或其它可能产生 `/login` 的逻辑。
 */
function resolveAuthFetchUrl(fixedPath: typeof URL_AUTH_LOGIN | typeof URL_AUTH_ME | typeof URL_AUTH_LOGOUT): string {
  const base = getApiBase()
  if (base) {
    const b = base.replace(/\/$/, '')
    const root = /^[a-z]+:/i.test(b) ? b : `https://${b}`
    return `${root}${fixedPath}`
  }
  if (typeof window !== 'undefined' && window.location?.origin) {
    return `${window.location.origin}${fixedPath}`
  }
  return fixedPath
}

/**
 * 生产构建且配置了 VITE_API_BASE_URL 时，API 发往该源。
 * 开发环境无 base 时，在浏览器内用 location.origin 拼绝对 URL。
 */
export function getApiBase(): string {
  if (import.meta.env.DEV) return ''
  const raw = import.meta.env.VITE_API_BASE_URL
  if (typeof raw !== 'string') return ''
  return raw.trim().replace(/\/$/, '')
}

function normalizePathSegment(path: string): string {
  const t = path.trim()
  const p = t.startsWith('/') ? t : `/${t}`
  if (p === '/login' || p === '/login/') {
    return URL_AUTH_LOGIN
  }
  return p
}

function sameOriginRequestUrl(path: string): string {
  if (typeof window === 'undefined' || !window.location?.origin) {
    return path
  }
  return new URL(path, window.location.origin).href
}

export function apiUrl(path: string): string {
  const p = normalizePathSegment(path)
  const base = getApiBase()
  if (!base) {
    return sameOriginRequestUrl(p)
  }
  try {
    const baseForJoin = base.includes('://') ? base : `https://${base}`
    return new URL(p, baseForJoin.endsWith('/') ? baseForJoin : `${baseForJoin}/`).href
  } catch {
    return sameOriginRequestUrl(p)
  }
}

export function resolveApiRequestInput(input: RequestInfo | URL): RequestInfo | URL {
  if (typeof input === 'string' && input.startsWith('/api')) {
    return apiUrl(appendPlatformViewTenantQuery(input))
  }
  return input
}

/**
 * 统一 API 请求入口；路径须以 `/api/` 开头（不会自动把 `/auth/login` 补成 `/api/...`）。
 */
export function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  const p = normalizePathSegment(appendPlatformViewTenantQuery(path))
  if (!p.startsWith('/api/')) {
    console.error('[apiClient] apiFetch 路径必须以 /api/ 开头，当前:', path, '→', p)
  }
  return fetch(apiUrl(p), init)
}

const AUTH_401_REDIRECT_ERRORS = new Set([
  'missing_token',
  'invalid_token',
  'invalid_token_payload',
  'inactive_account',
])

/**
 * 业务接口用：在 {@link apiFetch} 上合并 `Authorization: Bearer`，并对会话失效类 401 清 token 后跳转登录（与 AppShell /me 失败处理一致）。
 * 禁止对需认证的接口裸用 `fetch(url)` 而不带 Bearer。
 */
export async function fetchWithAuth(path: string, init?: RequestInit): Promise<Response> {
  const scopedPath = appendPlatformViewTenantQuery(path)
  const headers = new Headers(init?.headers ?? undefined)
  const auth = getAuthHeaders()
  if (auth.Authorization) {
    headers.set('Authorization', auth.Authorization)
  }
  const res = await apiFetch(scopedPath, { ...init, headers })
  if (res.status === 401) {
    let errCode = ''
    try {
      const ct = res.headers.get('content-type') || ''
      if (ct.includes('application/json')) {
        const j = (await res.clone().json()) as { error?: string }
        errCode = String(j?.error || '').trim()
      }
    } catch {
      /* ignore */
    }
    if (AUTH_401_REDIRECT_ERRORS.has(errCode)) {
      clearAuthAndRedirectToLogin()
    }
  }
  return res
}

/**
 * 登录：最终请求地址固定为 `/api/auth/login`（同源时为 `origin + /api/auth/login`）。
 * 本文件不存在 fetch('/login')、apiFetch('/login') 等写法。
 */
export function login(body: { username: string; password: string }): Promise<Response> {
  const url = resolveAuthFetchUrl(URL_AUTH_LOGIN)
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    cache: 'no-store',
  })
}

/** 公开注册主账号（无需 Bearer） */
export function registerPublicAccount(body: {
  tenant_name: string
  username: string
  display_name?: string
  password: string
  confirm_password: string
  contact?: string
}): Promise<Response> {
  return apiFetch('/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    cache: 'no-store',
  })
}

/** @deprecated 语义同 {@link login}，保留别名供现有 import */
export const postAuthLogin = login

/** 登出：最终请求地址固定为 `/api/auth/logout` */
export function logout(token: string | null): Promise<Response> {
  return fetch(resolveAuthFetchUrl(URL_AUTH_LOGOUT), {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  })
}

export const postAuthLogout = logout

/**
 * 当前用户：最终请求地址固定为 `/api/auth/me`（Bearer）。
 */
export function me(init?: RequestInit): Promise<Response> {
  const t = typeof window !== 'undefined' ? localStorage.getItem(AUTH_TOKEN_KEY) : null
  if (!t) {
    return Promise.reject(new Error('no_token'))
  }
  const headers = new Headers(init?.headers)
  headers.set('Authorization', `Bearer ${t}`)
  const ctrl = new AbortController()
  const tid = window.setTimeout(() => ctrl.abort(), AUTH_ME_TIMEOUT_MS)
  return fetch(resolveAuthFetchUrl(URL_AUTH_ME), {
    ...init,
    headers,
    cache: 'no-store',
    signal: ctrl.signal,
  }).finally(() => {
    window.clearTimeout(tid)
  })
}

export const fetchAuthMe = me
