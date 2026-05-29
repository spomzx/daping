import type { ComponentPropsWithoutRef, ReactNode } from 'react'

export type AdminTableRowProps = {
  children: ReactNode
} & ComponentPropsWithoutRef<'tr'>

export function AdminTableRow({ children, className, ...props }: AdminTableRowProps) {
  return (
    <tr className={['admin-table__row', className].filter(Boolean).join(' ')} {...props}>
      {children}
    </tr>
  )
}
