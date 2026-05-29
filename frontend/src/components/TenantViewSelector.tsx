import { planTypeLabel } from '../lib/tenantPlan'
import { usePlatformViewTenant } from '../context/PlatformViewTenantContext'

export function TenantViewSelector({ compact }: { compact?: boolean }) {
  const ctx = usePlatformViewTenant()
  if (!ctx) return null

  const { tenants, viewingTenantId, setViewingTenantId, loading, viewingTenant } = ctx

  return (
    <label className={`tenant-view-select${compact ? ' tenant-view-select--compact' : ''}`}>
      <span className="tenant-view-select__label">当前租户</span>
      <select
        className="tenant-view-select__control"
        disabled={loading || tenants.length === 0}
        value={viewingTenantId ?? ''}
        onChange={(e) => {
          const n = Number(e.target.value)
          if (!e.target.value) {
            setViewingTenantId(null)
            return
          }
          if (Number.isFinite(n) && n > 0) setViewingTenantId(n)
        }}
      >
        <option value="">全部租户</option>
        {tenants.length === 0 ? <option value="">加载中…</option> : null}
        {tenants.map((t) => (
          <option key={t.id} value={t.id}>
            {t.tenant_name}（{t.current_shops}/{t.shop_limit} 店）
          </option>
        ))}
      </select>
      {viewingTenant && !compact ? (
        <span className="tenant-view-select__meta">
          {planTypeLabel(viewingTenant.plan_type)} · 用户 {viewingTenant.current_users}/
          {viewingTenant.max_users}
        </span>
      ) : null}
    </label>
  )
}
