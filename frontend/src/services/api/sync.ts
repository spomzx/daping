import { apiGet, apiPost } from './client'

export type SyncShopRow = {
  shop_id: number
  resolved_shop_id?: number
  platform_shop_id?: string
  shop_name?: string
  market?: string
  last_sync_at?: string | null
  today_orders_count?: number
  /** 与 contract 对齐的今日订单（若后端下发） */
  today_orders?: number
  sync_enabled?: number
  /** 后端 auth contract */
  token_status?: 'active' | 'expired' | 'missing' | string
  sync_status?: string | null
  error_label?: string | null
  status_label?: string | null
  eligible_for_manual_sync?: boolean
}

export type SyncLogRow = {
  id: number
  shop_id?: number
  platform_shop_id?: string
  shop_name?: string
  status?: string
  fetched_orders_count?: number
  inserted_orders_count?: number
  updated_orders_count?: number
  error_message?: string | null
  duration_ms?: number | null
  created_at?: string
}

export async function fetchSyncStatus() {
  return apiGet<{ shops: SyncShopRow[]; can_manual_sync?: boolean }>('/api/sync/status')
}

export async function fetchSyncLogs(query: Record<string, string>) {
  return apiGet<{ items: SyncLogRow[] }>('/api/sync/logs', query)
}

export async function postSyncRun(shopId: string) {
  return apiPost<{ ok: boolean; result?: { status?: string; error_message?: string } }>(
    `/api/sync/run/${encodeURIComponent(shopId)}`,
  )
}

export async function postSyncRetry(shopId: string) {
  return apiPost<{ ok: boolean }>(`/api/sync/retry/${encodeURIComponent(shopId)}`)
}
