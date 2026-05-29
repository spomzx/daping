import type { ReactNode } from 'react'
import { useT } from '../../../i18n'

export type AdminEmptyVariant = 'empty' | 'error' | 'unauthorized' | 'forbidden'
export type AdminEmptyLayout = 'section' | 'table' | 'analytics' | 'compact'

export type AdminEmptyStateProps = {
  variant?: AdminEmptyVariant
  layout?: AdminEmptyLayout
  title?: ReactNode
  description?: ReactNode
  action?: ReactNode
  className?: string
}

const VARIANT_ICON: Record<AdminEmptyVariant, string> = {
  empty: '○',
  error: '!',
  unauthorized: '🔒',
  forbidden: '⊘',
}

export function AdminEmptyState({
  variant = 'empty',
  layout = 'section',
  title,
  description,
  action,
  className,
}: AdminEmptyStateProps) {
  const t = useT()
  const presetTitle =
    title ??
    (variant === 'error'
      ? t('admin.empty.errorTitle')
      : variant === 'unauthorized'
        ? t('admin.empty.unauthorizedTitle')
        : variant === 'forbidden'
          ? t('admin.empty.forbiddenTitle')
          : t('empty.noData'))

  const presetDesc =
    description ??
    (variant === 'error'
      ? t('admin.empty.errorDesc')
      : variant === 'unauthorized'
        ? t('admin.empty.unauthorizedDesc')
        : variant === 'forbidden'
          ? t('admin.empty.forbiddenDesc')
          : t('admin.empty.emptyDesc'))

  return (
    <div
      className={[
        'admin-empty-state',
        `admin-empty-state--${variant}`,
        `admin-empty-state--${layout}`,
        className,
      ]
        .filter(Boolean)
        .join(' ')}
      role="status"
    >
      <span className="admin-empty-state__icon" aria-hidden>
        {VARIANT_ICON[variant]}
      </span>
      <p className="admin-empty-state__title">{presetTitle}</p>
      {presetDesc ? <p className="admin-empty-state__desc">{presetDesc}</p> : null}
      {action ? <div className="admin-empty-state__action">{action}</div> : null}
    </div>
  )
}
