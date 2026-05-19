import { apiGet } from './client'

export type WarRoomOrdersResponse = {
  orders: unknown[]
  meta?: {
    data_source?: string
    time_window?: string
    scope?: string | null
  }
}

export async function fetchDashboardWarRoomOrders(query: Record<string, string>) {
  return apiGet<WarRoomOrdersResponse>('/api/dashboard/orders', query)
}

export type DashboardSummaryResponse = {
  gmv?: number
  orders?: number
  todayGmvTarget?: number
  today_gmv_usd?: number
  summary?: { todayGmvTarget?: number; todayGmvBase?: number }
}

export async function fetchDashboardSummary(query?: Record<string, string>) {
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

export async function fetchDashboardTrend(query?: Record<string, string>) {
  const res = await apiGet<unknown>('/api/dashboard/trend', query)
  return normalizeTrendPayload(res)
}
