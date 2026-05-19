export type TenantPlanType = 'basic' | 'enterprise' | 'custom'

export const TENANT_PLAN_TYPES: TenantPlanType[] = ['basic', 'enterprise', 'custom']

export const PLAN_PRESETS = {
  basic: { shop_limit: 10, max_users: 3 },
  enterprise: { shop_limit: 20, max_users: 10 },
} as const

const PLAN_LABELS: Record<TenantPlanType, string> = {
  basic: '基础版',
  enterprise: '企业版',
  custom: '自定义版',
}

/** 仅认 plan_type 字段，不用 shop_limit 推断 */
export function normalizeTenantPlanType(raw: string | null | undefined): TenantPlanType {
  const t = String(raw ?? 'basic')
    .trim()
    .toLowerCase()
  if (t === 'enterprise' || t === 'custom' || t === 'basic') return t
  return 'basic'
}

export function planTypeLabel(planType: string | null | undefined): string {
  return PLAN_LABELS[normalizeTenantPlanType(planType)]
}

export function planTypeHasPreset(planType: TenantPlanType): boolean {
  return planType === 'basic' || planType === 'enterprise'
}
