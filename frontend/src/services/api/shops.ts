import { apiGet, apiPost } from './client'

export type ShopRow = Record<string, unknown>

export type ShopsListResponse = {
  list: ShopRow[]
  shops?: ShopRow[]
  total: number
  page: number
  page_size: number
  meta?: Record<string, unknown>
}

export type ShopsSummaryResponse = {
  totalAuthorized: number
  todayOrderShopCount?: number
  enabledCount?: number
  abnormalCount?: number
  currentShops?: number
  perTenantDefaultMaxShops?: number
  scope?: string
  scope_mode?: string
  max_shops?: number | null
}

export async function fetchShopsList(query: Record<string, string | number | undefined>) {
  return apiGet<ShopsListResponse>('/api/shops', query)
}

export async function fetchShopsSummary() {
  return apiGet<ShopsSummaryResponse>('/api/shops/summary')
}

export async function postShopsHealthRefresh() {
  return apiPost<{ ok?: boolean }>('/api/shops/health/refresh', { cache: 'no-store' })
}
