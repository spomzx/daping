import { apiFetch } from './client'
import { getAuthHeaders } from '../../authStorage'
import type { DashboardQueryParams } from '../../stores/dashboardQueryStore'

function unwrap<T>(body: unknown): T {
  if (body && typeof body === 'object') {
    const o = body as Record<string, unknown>
    if (o.data != null) return o.data as T
    if (Array.isArray(o.list)) return o.list as T
  }
  return body as T
}

type AnalyticsQuery = Record<string, string | undefined>
type ApiError = Error & { code?: string }

function compactQuery(query?: AnalyticsQuery): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(query || {})) {
    if (v == null || v === '') continue
    out[k] = String(v)
  }
  return out
}

export async function fetchAnalyticsJson<T>(path: string, query?: AnalyticsQuery): Promise<T> {
  const compact = compactQuery(query)
  const qs = Object.keys(compact).length ? `?${new URLSearchParams(compact).toString()}` : ''
  const res = await apiFetch(`${path}${qs}`, {
    headers: { ...getAuthHeaders() },
    cache: 'no-store',
  })
  if (!res.ok) {
    const err = new Error(`analytics_http_${res.status}`) as ApiError
    err.code = `analytics_http_${res.status}`
    throw err
  }
  const body = (await res.json()) as unknown
  return unwrap<T>(body)
}

export function fetchAnalyticsSummary(query?: Partial<DashboardQueryParams> & AnalyticsQuery) {
  return fetchAnalyticsJson<unknown>('/api/analytics/summary', query)
}

export function fetchAnalyticsTopProducts(query?: Partial<DashboardQueryParams> & AnalyticsQuery) {
  return fetchAnalyticsJson<unknown[]>('/api/analytics/top-products', query)
}

export function fetchAnalyticsTopShops(query?: Partial<DashboardQueryParams> & AnalyticsQuery) {
  return fetchAnalyticsJson<unknown[]>('/api/analytics/top-shops', query)
}

const RECENT_ORDERS_UNAVAILABLE = '最近订单暂时不可用，请稍后刷新'

export async function fetchAnalyticsRecentOrders(query?: Partial<DashboardQueryParams> & AnalyticsQuery) {
  try {
    return await fetchAnalyticsJson<unknown[]>('/api/analytics/recent-orders', query)
  } catch (e) {
    const code = String((e as ApiError)?.code || (e as Error)?.message || '')
    console.error('[analytics-recent-orders] unavailable', { code, error: e })
    const err = new Error(RECENT_ORDERS_UNAVAILABLE) as ApiError
    err.code = code || 'analytics_recent_orders_unavailable'
    throw err
  }
}

export function fetchAnalyticsShopTrend(query?: Partial<DashboardQueryParams> & AnalyticsQuery) {
  return fetchAnalyticsJson<unknown[]>('/api/analytics/shop-trend', query)
}

export function fetchAnalyticsSearchSku(query?: Partial<DashboardQueryParams> & AnalyticsQuery) {
  return fetchAnalyticsJson<unknown[]>('/api/analytics/search-sku', query)
}
