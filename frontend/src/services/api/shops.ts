import { apiDelete, apiGet, apiPatch, apiPost } from './client'
import type { ShopsListApiResponse } from '../../types/shopListApi'

export type { ShopListApiRow, ShopsListApiResponse } from '../../types/shopListApi'

export type ShopsListResponse = ShopsListApiResponse

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

export type ShopsHealthRefreshResponse = {
  error?: string
  message?: string
  keep_previous?: boolean
  partial?: boolean
  scope?: string
  checked?: number
  abnormal?: number
  applied_count?: number
  retained_count?: number
  retry_after_ms?: number
  shops?: unknown[]
}

export async function postShopsHealthRefreshByScope(scope?: 'all') {
  const qs = scope === 'all' ? '?scope=all' : ''
  return apiPost<ShopsHealthRefreshResponse>(`/api/shops/health/refresh${qs}`, { cache: 'no-store' })
}

export async function patchShop(id: number, body: Record<string, unknown>) {
  return apiPatch<Record<string, unknown>>(`/api/shops/${id}`, body)
}

export async function patchShopStatus(id: number, status: string) {
  return apiPatch<Record<string, unknown>>(`/api/shops/${id}/status`, { status })
}

export async function deleteShop(id: number) {
  return apiDelete<Record<string, unknown>>(`/api/shops/${id}`)
}
