import type { ComponentPropsWithoutRef, ReactNode } from 'react'

export type AdminTableBodyProps = {
  children: ReactNode
} & ComponentPropsWithoutRef<'tbody'>

export function AdminTableBody({ children, className, ...props }: AdminTableBodyProps) {
  return (
    <tbody className={['admin-table__body', className].filter(Boolean).join(' ')} {...props}>
      {children}
    </tbody>
  )
}
