import { apiGet, apiPost } from './client'

export type SyncShopRow = {
  shop_id: number
  resolved_shop_id?: number
  platform_shop_id?: string
  shop_name?: string
  market?: string
  last_sync_at?: string | null
  last_health_status?: string
  last_health_message?: string | null
  last_log_status?: string | null
  last_error?: string | null
  last_finished_at?: string | null
  today_orders_count?: number
  sync_enabled?: number
  token_status?: 'active' | 'expired' | 'missing' | string
  has_token?: number
  has_shop_cipher?: number
  error_label?: string
  status_label?: string
  auth_error_label?: string
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
