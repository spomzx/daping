import { apiGet } from './client'

export type AuthorizationRow = {
  shop_id: number
  platform_shop_id?: string
  shop_name?: string
  platform?: string
  market?: string
  /** 后端 auth contract */
  token_status?: 'active' | 'expired' | 'missing' | string
  shop_cipher_present?: boolean
  auth_contract_label?: string
  token_expire_at?: string | null
  token_updated_at?: string | null
  last_sync_at?: string | null
  /** 授权说明列：后端 contract 文案 */
  error_label?: string | null
}

export async function fetchAuthorizationsList() {
  return apiGet<{ items: AuthorizationRow[] }>('/api/authorizations/list')
}
