import { apiGet } from './client'

export type AuthorizationRow = {
  shop_id: number
  platform_shop_id?: string
  shop_name?: string
  platform?: string
  market?: string
  token_status?: string
  auth_status?: string
  token_expire_at?: string | null
  token_updated_at?: string | null
  last_sync_at?: string | null
  last_health_message?: string | null
  has_token?: number
  error_label?: string | null
}

export async function fetchAuthorizationsList() {
  return apiGet<{ items: AuthorizationRow[] }>('/api/authorizations/list')
}
