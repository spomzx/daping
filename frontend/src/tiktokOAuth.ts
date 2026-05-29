import { apiUrl, fetchWithAuth } from './apiClient'
import { AUTH_TOKEN_KEY } from './authStorage'

export type TikTokSellerType = 'local' | 'cross_border'

export type TikTokServiceAuthorizeResponse = {
  success: boolean
  authorize_url?: string
  error?: string
}

const LOCAL_MARKETS = new Set(['TH', 'MY', 'SG', 'PH', 'VN'])

/** staging：GET /api/tiktok/auth → 官方 services.tiktokshop.com 授权链接 */
export async function fetchTikTokServiceAuthorizeUrl(): Promise<string> {
  const res = await fetchWithAuth('/api/tiktok/auth', { cache: 'no-store' })
  const data = (await res.json().catch(() => ({}))) as TikTokServiceAuthorizeResponse
  if (!res.ok || !data.success || !data.authorize_url) {
    throw new Error(String(data.error || `http_${res.status}`))
  }
  return data.authorize_url
}

/**
 * TikTok OAuth 启动 URL
 * - cross_border：不传 market（避免误绑本土网关）
 * - local：必须传 market
 */
export function tiktokOAuthStartUrl(
  sellerType: TikTokSellerType,
  market?: string,
  source = 'saas',
): string {
  const st: TikTokSellerType = sellerType === 'cross_border' ? 'cross_border' : 'local'
  const token = typeof window !== 'undefined' ? localStorage.getItem(AUTH_TOKEN_KEY) : ''
  const params = new URLSearchParams({ seller_type: st, source })
  if (st === 'local') {
    const m = String(market || '').trim().toUpperCase()
    if (!LOCAL_MARKETS.has(m)) {
      throw new Error('tiktok_oauth_missing_market')
    }
    params.set('market', m)
  }
  if (token) params.set('token', token)
  return apiUrl(`/api/tiktok/auth/start?${params.toString()}`)
}
