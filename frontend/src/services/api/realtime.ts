import { apiGet } from './client'
import type { DashboardQueryParams } from '../../stores/dashboardQueryStore'

export type RealtimeOrderListResponse = {
  ok?: boolean
  orders?: unknown[]
  list?: unknown[]
  data?: unknown[]
  timeWindow?: Record<string, unknown>
  realtimeWindow?: Record<string, unknown>
}

export async function fetchRealtimeOrders(query: Partial<DashboardQueryParams> & Record<string, string>) {
  return apiGet<RealtimeOrderListResponse>('/api/realtime/orders', query)
}
