import { apiUrl } from './apiClient'
import { AUTH_TOKEN_KEY } from './authStorage'

/** 浏览器跳转 TikTok Partner OAuth（与 App 大屏「连接店铺」一致） */
export function tiktokOAuthStartUrl(region = 'TH'): string {
  const token = typeof window !== 'undefined' ? localStorage.getItem(AUTH_TOKEN_KEY) : ''
  const q = token ? `region=${encodeURIComponent(region)}&token=${encodeURIComponent(token)}` : `region=${encodeURIComponent(region)}`
  return apiUrl(`/api/tiktok/auth/start?${q}`)
}
