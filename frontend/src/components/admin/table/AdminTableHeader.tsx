import type { ComponentPropsWithoutRef, ReactNode } from 'react'

export type AdminTableHeaderProps = {
  children: ReactNode
} & ComponentPropsWithoutRef<'thead'>

export function AdminTableHeader({ children, className, ...props }: AdminTableHeaderProps) {
  return (
    <thead className={['admin-table__head', className].filter(Boolean).join(' ')} {...props}>
      {children}
    </thead>
  )
}
