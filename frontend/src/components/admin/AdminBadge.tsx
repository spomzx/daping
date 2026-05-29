import type { ReactNode } from 'react'

export type AdminBadgeVariant = 'success' | 'warning' | 'danger' | 'info' | 'neutral' | 'processing'

export type AdminBadgeProps = {
  variant?: AdminBadgeVariant
  children: ReactNode
  className?: string
  title?: string
}

const VARIANT_CLASS: Record<AdminBadgeVariant, string> = {
  success: 'admin-badge--success',
  warning: 'admin-badge--warning',
  danger: 'admin-badge--danger',
  info: 'admin-badge--info',
  neutral: 'admin-badge--neutral',
  processing: 'admin-badge--processing',
}

export function AdminBadge({ variant = 'neutral', children, className, title }: AdminBadgeProps) {
  return (
    <span
      className={['admin-badge', VARIANT_CLASS[variant], className].filter(Boolean).join(' ')}
      title={title}
    >
      {children}
    </span>
  )
}

/** 与 AdminBadge 相同，用于表格状态列语义 */
export const AdminStatusTag = AdminBadge
