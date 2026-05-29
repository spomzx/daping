import { apiGet } from './client'
import type { OrdersListApiResponse } from '../../types/ordersListApi'
import type { DashboardQueryParams } from '../../stores/dashboardQueryStore'

export type { OrdersListItem, OrdersListApiResponse } from '../../types/ordersListApi'

export async function fetchOrdersList(query: Partial<DashboardQueryParams> & Record<string, string>) {
  return apiGet<OrdersListApiResponse>('/api/orders/list', query)
}

export async function fetchOrdersStats(query: Partial<DashboardQueryParams> & Record<string, string>) {
  return apiGet<{ orders: number; gmv: number; shops: number }>('/api/orders/stats', query)
}
