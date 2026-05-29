import type { ComponentPropsWithoutRef, ReactNode } from 'react'

export type AdminTableShellProps = {
  title?: string
  description?: string
  actions?: ReactNode
  meta?: ReactNode
  children: ReactNode
  footer?: ReactNode
  className?: string
} & Omit<ComponentPropsWithoutRef<'section'>, 'title'>

/** 表格外层统一容器 */
export function AdminTableShell({
  title,
  description,
  actions,
  meta,
  children,
  footer,
  className,
  ...sectionProps
}: AdminTableShellProps) {
  const hasHeader = Boolean(title || description || actions)

  return (
    <section
      className={['section-shell', 'admin-section', 'admin-table-shell', className].filter(Boolean).join(' ')}
      {...sectionProps}
    >
      {hasHeader ? (
        <header className="admin-table-shell__header">
          <div className="admin-table-shell__heading">
            {title ? <h2 className="admin-table-shell__title">{title}</h2> : null}
            {description ? <p className="admin-table-shell__desc">{description}</p> : null}
          </div>
          {actions ? <div className="admin-section__actions">{actions}</div> : null}
        </header>
      ) : null}

      {meta ? <div className="admin-table-shell__meta">{meta}</div> : null}

      <div className="admin-table-shell__body">{children}</div>

      {footer ? <footer className="admin-table-shell__footer admin-pagination">{footer}</footer> : null}
    </section>
  )
}
