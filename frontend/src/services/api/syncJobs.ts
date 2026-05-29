import { apiGet } from './client'

export type SyncJobRow = {
  id: number
  tenant_id: number
  shop_id: number
  platform: string
  job_type: string
  status: string
  priority: number
  attempt_count: number
  max_attempts: number
  locked_by: string | null
  started_at: string | null
  finished_at: string | null
  next_retry_at: string | null
  error_message: string | null
  duration_ms: number | null
  shop_name?: string
  platform_shop_id?: string
  created_at: string
}

export async function fetchSyncJobs(params: {
  status?: string
  shop_id?: string
  limit?: number
} = {}) {
  const qs = new URLSearchParams()
  if (params.status) qs.set('status', params.status)
  if (params.shop_id) qs.set('shop_id', params.shop_id)
  if (params.limit) qs.set('limit', String(params.limit))
  const suffix = qs.toString() ? `?${qs.toString()}` : ''
  return apiGet<{ ok: boolean; items: SyncJobRow[]; total: number }>(`/api/sync-jobs${suffix}`)
}
