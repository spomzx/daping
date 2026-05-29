import type { ReactNode } from 'react'

export type AdminTableFooterProps = {
  children: ReactNode
  className?: string
}

export function AdminTableFooter({ children, className }: AdminTableFooterProps) {
  return (
    <footer className={['admin-table-footer', 'admin-pagination', className].filter(Boolean).join(' ')}>
      {children}
    </footer>
  )
}
