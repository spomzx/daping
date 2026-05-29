import type { ComponentPropsWithoutRef, ReactNode } from 'react'
import { AdminScrollArea } from '../AdminScrollArea'

export type AdminTableDensity = 'normal' | 'compact'

export type AdminTableProps = {
  children: ReactNode
  density?: AdminTableDensity
  zebra?: boolean
  stickyHeader?: boolean
  minWidth?: number | string
  className?: string
  scroll?: boolean
  maxHeight?: number | string
  wrapClassName?: string
} & Omit<ComponentPropsWithoutRef<'table'>, 'children'>

export function AdminTable({
  children,
  density = 'normal',
  zebra = false,
  stickyHeader = true,
  minWidth,
  className,
  scroll = true,
  maxHeight,
  wrapClassName,
  ...tableProps
}: AdminTableProps) {
  const tableClass = [
    'admin-table',
    'saas-table',
    density === 'compact' ? 'admin-table--compact' : 'admin-table--normal',
    zebra ? 'admin-table--zebra' : '',
    stickyHeader ? 'admin-table--sticky-head' : '',
    className,
  ]
    .filter(Boolean)
    .join(' ')

  const table = (
    <table
      className={tableClass}
      style={minWidth != null ? { minWidth: typeof minWidth === 'number' ? `${minWidth}px` : minWidth } : undefined}
      {...tableProps}
    >
      {children}
    </table>
  )

  const wrapped = (
    <div className={['admin-table-wrap', 'saas-table-wrap', wrapClassName].filter(Boolean).join(' ')}>
      {table}
    </div>
  )

  if (!scroll) return wrapped

  return (
    <AdminScrollArea maxHeight={maxHeight} className="admin-table-scroll-area">
      {wrapped}
    </AdminScrollArea>
  )
}
