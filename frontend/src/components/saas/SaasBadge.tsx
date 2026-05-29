import type { TenantPlanStatus } from '../../services/api/tenants'
import { planStatusLabel } from '../../services/api/tenants'

const BADGE_CLASS: Record<TenantPlanStatus, string> = {
  normal: 'saas-badge--normal',
  expiring: 'saas-badge--expiring',
  expired: 'saas-badge--expired',
  disabled: 'saas-badge--disabled',
}

export function SaasBadge({ status }: { status: TenantPlanStatus | undefined }) {
  const key = (status || 'normal') as TenantPlanStatus
  const cls = BADGE_CLASS[key] || BADGE_CLASS.normal
  return <span className={`saas-badge ${cls}`}>{planStatusLabel(status)}</span>
}
