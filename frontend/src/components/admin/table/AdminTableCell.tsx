import type { ComponentPropsWithoutRef, ReactNode } from 'react'

export type AdminTableCellProps = {
  children?: ReactNode
  as?: 'td' | 'th'
  numeric?: boolean
  mono?: boolean
} & ComponentPropsWithoutRef<'td'>

export function AdminTableCell({
  children,
  as = 'td',
  numeric = false,
  mono = false,
  className,
  ...props
}: AdminTableCellProps) {
  const Tag = as
  const classes = [
    'admin-table__cell',
    numeric || (className && className.includes('num')) ? 'num' : '',
    mono ? 'saas-td-mono' : '',
    className,
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <Tag className={classes} {...(props as ComponentPropsWithoutRef<'td'>)}>
      {children}
    </Tag>
  )
}
