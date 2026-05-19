import { apiGet, apiPatch } from './client'

export type TenantPlanStatus = 'normal' | 'expiring' | 'expired' | 'disabled'

export type TenantPlanRow = {
  id: number
  tenant_code: string
  tenant_name: string
  status: string
  plan_type: 'basic' | 'enterprise' | 'custom' | string
  shop_limit: number
  max_users: number
  max_shops: number
  shop_count: number
  active_shop_count: number
  current_shops: number
  current_users: number
  expires_at: string | null
  is_active: number
  plan_remark: string | null
  plan_status?: TenantPlanStatus
  created_at?: string | null
  updated_at?: string | null
  updated_by?: number | null
  /** 主管理员登录账号（user_tenants 推导，只读展示） */
  primary_admin_username?: string | null
}

export type TenantPlanPatch = {
  plan_type?: 'basic' | 'enterprise' | 'custom'
  shop_limit?: number
  max_users?: number
  expires_at?: string | null
  is_active?: boolean | number
  plan_remark?: string | null
}

export type TenantListQuery = {
  page?: number
  page_size?: number
  keyword?: string
  plan_type?: string
  is_active?: number | string
  plan_status?: string
  /** 为 1 时包含系统租户 default（诊断用） */
  include_system?: number | string
}

export type TenantListResult = {
  list: TenantPlanRow[]
  total: number
  page: number
  page_size: number
}

export async function fetchTenantPlans(query: TenantListQuery = {}): Promise<TenantListResult> {
  const params = new URLSearchParams()
  if (query.page) params.set('page', String(query.page))
  if (query.page_size) params.set('page_size', String(query.page_size))
  if (query.keyword) params.set('keyword', query.keyword)
  if (query.plan_type) params.set('plan_type', query.plan_type)
  if (query.is_active !== undefined && query.is_active !== '') {
    params.set('is_active', String(query.is_active))
  }
  if (query.plan_status) params.set('plan_status', query.plan_status)
  if (query.include_system !== undefined && query.include_system !== '') {
    params.set('include_system', String(query.include_system))
  }
  const qs = params.toString()
  const data = await apiGet<TenantListResult>(`/api/tenants${qs ? `?${qs}` : ''}`)
  return {
    list: data.list ?? [],
    total: Number(data.total) || 0,
    page: Number(data.page) || 1,
    page_size: Number(data.page_size) || 20,
  }
}

export async function fetchMyTenantPlan(): Promise<TenantPlanRow> {
  const data = await apiGet<{ plan: TenantPlanRow }>('/api/tenants/plan/me')
  return data.plan
}

export async function patchTenantPlan(id: number, body: TenantPlanPatch): Promise<TenantPlanRow> {
  const data = await apiPatch<{ plan: TenantPlanRow }>(`/api/tenants/${id}`, body)
  return data.plan
}

export function tenantsApiErrorMessage(e: unknown, fallback: string): string {
  if (e && typeof e === 'object' && 'message' in e && typeof (e as { message: string }).message === 'string') {
    return (e as { message: string }).message
  }
  return fallback
}

export function planStatusLabel(status: TenantPlanStatus | undefined): string {
  switch (status) {
    case 'expiring':
      return '即将到期'
    case 'expired':
      return '已过期'
    case 'disabled':
      return '已禁用'
    default:
      return '正常'
  }
}

export function planStatusClass(status: TenantPlanStatus | undefined): string {
  switch (status) {
    case 'expiring':
      return 'tenants-status--expiring'
    case 'expired':
      return 'tenants-status--expired'
    case 'disabled':
      return 'tenants-status--disabled'
    default:
      return 'tenants-status--normal'
  }
}
