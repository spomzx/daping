import { apiGet } from './client'

export type OrderRow = {
  id: number
  platform_order_id: string
  shop_name?: string
  market?: string
  total_amount?: number
  currency?: string
  order_status?: string
  analytics_status?: string
  created_at_platform?: string
}

export async function fetchOrdersList(query: Record<string, string>) {
  return apiGet<{
    items: OrderRow[]
    total: number
    page: number
    page_size: number
  }>('/api/orders/list', query)
}

export async function fetchOrdersStats(query: Record<string, string>) {
  return apiGet<{ orders: number; gmv: number; shops: number }>('/api/orders/stats', query)
}
