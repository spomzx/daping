import type { ReactNode } from 'react'
import { useT } from '../../i18n'
import { AdminButton } from './AdminButton'

export type AdminPaginationDensity = 'normal' | 'compact'

export type AdminPaginationProps = {
  page: number
  totalPages: number
  onPrev: () => void
  onNext: () => void
  prevLabel?: string
  nextLabel?: string
  info?: ReactNode
  className?: string
  disabled?: boolean
  density?: AdminPaginationDensity
}

export function AdminPagination({
  page,
  totalPages,
  onPrev,
  onNext,
  prevLabel,
  nextLabel,
  info,
  className,
  disabled = false,
  density = 'normal',
}: AdminPaginationProps) {
  const t = useT()

  return (
    <div
      className={[
        'admin-pagination',
        'admin-pagination-bar',
        density === 'compact' ? 'admin-pagination--compact' : '',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <AdminButton variant="secondary" disabled={disabled || page <= 1} onClick={onPrev}>
        {prevLabel ?? t('orders.pager.prev')}
      </AdminButton>
      <span className="admin-pagination-bar__info">{info ?? `${page} / ${totalPages}`}</span>
      <AdminButton variant="secondary" disabled={disabled || page >= totalPages} onClick={onNext}>
        {nextLabel ?? t('orders.pager.next')}
      </AdminButton>
    </div>
  )
}
