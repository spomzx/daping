import { apiDelete, apiGet, apiPatch, apiPost, apiPut, ApiClientError } from './client'

export type UserRow = {
  id?: number
  username?: string
  display_name?: string | null
  nickname?: string | null
  contact?: string | null
  role?: string
  scope?: string
  user_status?: string
  membership_status?: string
  tenant_id?: number
  tenant_name?: string
  tenant_code?: string
  last_login_at?: string | null
  created_at?: string | null
  assigned_shop_count?: number
}

export type UsersListResponse = {
  list: UserRow[]
  users?: UserRow[]
  total: number
  page: number
  page_size: number
}

export type AssignableShop = {
  shop_id: number
  shop_name?: string
  platform?: string
  region?: string
  status?: string
  tenant_id?: number
}

export type ShopPermissionRow = {
  shop_id: number
  shop_name?: string
  platform?: string
  region?: string
  status?: string
}

export async function fetchUsersList(query?: Record<string, string | number | undefined>) {
  return apiGet<UsersListResponse>('/api/users', query)
}

export async function fetchUserShopPermissions(userId: number) {
  return apiGet<{ user_id: number; shops: ShopPermissionRow[] }>(
    `/api/users/${userId}/shop-permissions`,
  )
}

export async function updateUserShopPermissions(userId: number, shopIds: number[]) {
  return apiPut<{ ok: boolean; user_id: number; shops: ShopPermissionRow[] }>(
    `/api/users/${userId}/shop-permissions`,
    { shop_ids: shopIds },
  )
}

export async function fetchAssignableShops() {
  return apiGet<{ shops: AssignableShop[] }>('/api/users/assignable-shops')
}

export async function createUser(body: Record<string, unknown>) {
  return apiPost<{ user: UserRow }>('/api/users', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

export async function patchUserStatus(userId: number, status: 'active' | 'disabled') {
  return apiPatch<{ ok: boolean }>(`/api/users/${userId}/status`, { status })
}

export async function resetUserPassword(userId: number, password: string) {
  return apiPost<{ ok: boolean }>(`/api/users/${userId}/reset-password`, {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  })
}

export async function deleteUser(userId: number) {
  return apiDelete<{ ok: boolean }>(`/api/users/${userId}`)
}

export async function approveUser(userId: number) {
  return apiPost<{ ok: boolean }>(`/api/users/${userId}/approve`)
}

export async function rejectUser(userId: number) {
  return apiPost<{ ok: boolean }>(`/api/users/${userId}/reject`)
}

export function usersApiErrorMessage(e: unknown, t: (k: string) => string): string {
  if (e instanceof ApiClientError) {
    const code = String(e.body.error || '')
    if (code === 'forbidden') return t('error.forbidden')
    if (code === 'invalid_shop_ids') return String(e.body.message || e.message)
    return String(e.body.message || e.message || code)
  }
  return String((e as Error)?.message || e)
}
