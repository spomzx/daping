import type { ReactNode } from 'react'

export type AdminStatCardStatus = 'default' | 'warning' | 'danger'

export type AdminStatCardProps = {
  label: ReactNode
  value: ReactNode
  hint?: ReactNode
  status?: AdminStatCardStatus
  className?: string
}

export function AdminStatCard({ label, value, hint, status = 'default', className }: AdminStatCardProps) {
  const statusClass = status !== 'default' ? `admin-stat-card--${status}` : ''

  return (
    <div className={['admin-stat-card', statusClass, className].filter(Boolean).join(' ')}>
      <div className="admin-stat-card__label">{label}</div>
      <div className="admin-stat-card__value">{value}</div>
      {hint != null && hint !== '' ? <div className="admin-stat-card__hint">{hint}</div> : null}
    </div>
  )
}
