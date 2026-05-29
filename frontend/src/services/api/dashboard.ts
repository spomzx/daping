import { apiGet } from './client'
import type { DashboardQueryParams } from '../../stores/dashboardQueryStore'

function unwrapPayload<T>(res: unknown): T {
  if (res && typeof res === 'object') {
    const o = res as Record<string, unknown>
    if (o.data != null) return o.data as T
  }
  return res as T
}

export type WarRoomOrdersResponse = {
  orders: unknown[]
  meta?: {
    data_source?: string
    time_window?: string
    scope?: string | null
  }
}

export async function fetchDashboardWarRoomOrders(query: Partial<DashboardQueryParams> & Record<string, string>) {
  return apiGet<WarRoomOrdersResponse>('/api/dashboard/orders', query)
}

export type DashboardSummaryResponse = {
  gmv?: number
  orders?: number
  todayGmvTarget?: number
  today_gmv_usd?: number
  summary?: { todayGmvTarget?: number; todayGmvBase?: number }
}

export async function fetchDashboardSummary(query?: Partial<DashboardQueryParams> & Record<string, string>) {
  return apiGet<DashboardSummaryResponse>('/api/dashboard/summary', query)
}

export type DashboardTrendPoint = {
  hour: string
  gmv_usd: number
  order_count?: number
  time?: string
  gmv?: number
  orders?: number
}

function normalizeTrendPayload(res: unknown): DashboardTrendPoint[] {
  if (!res || typeof res !== 'object') return []
  const o = res as Record<string, unknown>
  if (Array.isArray(o.list)) return o.list as DashboardTrendPoint[]
  if (Array.isArray(o.data)) return o.data as DashboardTrendPoint[]
  if (Array.isArray(o.series)) return o.series as DashboardTrendPoint[]
  if (Array.isArray(res)) return res as DashboardTrendPoint[]
  return []
}

export async function fetchDashboardTrend(query?: Partial<DashboardQueryParams> & Record<string, string>) {
  const res = await apiGet<unknown>('/api/dashboard/trend', query)
  return normalizeTrendPayload(unwrapPayload(res))
}

export async function fetchDashboardOrderVolume(query?: Partial<DashboardQueryParams> & Record<string, string>) {
  const res = await apiGet<unknown>('/api/dashboard/order-volume', query)
  return normalizeTrendPayload(unwrapPayload(res))
}

export async function fetchDashboardOrderVolumePayload(query?: Partial<DashboardQueryParams> & Record<string, string>) {
  return apiGet<Record<string, unknown>>('/api/dashboard/order-volume', query)
}

export type DashboardProductRankingItem = {
  product_name?: string
  sku_name?: string
  qty?: number
  gmv?: number
  orders?: number
}

function normalizeProductRankingPayload(res: unknown): DashboardProductRankingItem[] {
  if (!res || typeof res !== 'object') return []
  const o = res as Record<string, unknown>
  if (Array.isArray(o.items)) return o.items as DashboardProductRankingItem[]
  if (Array.isArray(o.list)) return o.list as DashboardProductRankingItem[]
  if (Array.isArray(o.data)) return o.data as DashboardProductRankingItem[]
  if (o.data && typeof o.data === 'object') {
    const d = o.data as Record<string, unknown>
    if (Array.isArray(d.items)) return d.items as DashboardProductRankingItem[]
    if (Array.isArray(d.list)) return d.list as DashboardProductRankingItem[]
  }
  if (Array.isArray(res)) return res as DashboardProductRankingItem[]
  return []
}

export async function fetchDashboardProductRanking(query?: Partial<DashboardQueryParams> & Record<string, string>) {
  const res = await apiGet<unknown>('/api/dashboard/product-ranking', query)
  return { items: normalizeProductRankingPayload(unwrapPayload(res)) }
}

export type DashboardRankingItem = {
  shop_id?: number
  shop_name?: string
  market?: string
  orders?: number
  gmv?: number
  gmv_currency?: string
}

function normalizeRankingPayload(res: unknown): DashboardRankingItem[] {
  if (!res || typeof res !== 'object') return []
  const o = res as Record<string, unknown>
  if (Array.isArray(o.items)) return o.items as DashboardRankingItem[]
  if (Array.isArray(o.list)) return o.list as DashboardRankingItem[]
  if (Array.isArray(o.shops)) {
    return (o.shops as Record<string, unknown>[]).map((s) => ({
      shop_id: Number(s.shop_id ?? s.shopId) || undefined,
      shop_name: String(s.shop_name ?? s.shopName ?? ''),
      market: String(s.market ?? s.region ?? ''),
      orders: Number(s.orders ?? s.todayOrders) || 0,
      gmv: Number(s.gmv ?? s.todayGmvBase ?? s.shop_gmv) || 0,
      gmv_currency: String(s.gmv_currency ?? 'USD'),
    }))
  }
  if (Array.isArray(res)) return res as DashboardRankingItem[]
  return []
}

/** 店铺销售排行：业务固定 shopId=all，禁止传入当前选中店铺 */
export async function fetchDashboardRanking(query?: Partial<DashboardQueryParams> & Record<string, string>) {
  const q: Record<string, string> = { ...(query || {}) }
  q.shopId = 'all'
  delete q.shop_id
  const res = await apiGet<unknown>('/api/dashboard/ranking', q)
  return normalizeRankingPayload(unwrapPayload(res))
}

export type DashboardGmvCompareResponse = {
  today?: { bucket: string; gmv: number }[]
  yesterday?: { bucket: string; gmv: number }[]
  summary?: { todayTotal: number; yesterdayTotal: number; changePercent: number | null }
  gmv_currency?: string
  meta?: Record<string, unknown>
}

export async function fetchDashboardGmvCompare(query?: Partial<DashboardQueryParams> & Record<string, string>) {
  return apiGet<DashboardGmvCompareResponse>('/api/dashboard/gmv-compare', query)
}
