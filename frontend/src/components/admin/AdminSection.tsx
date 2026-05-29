import type { ComponentPropsWithoutRef, ReactNode } from 'react'

export type AdminSectionVariant = 'default' | 'stats' | 'filter' | 'auth' | 'table' | 'log' | 'form'

export type AdminSectionProps = {
  children: ReactNode
  title?: string
  description?: string
  actions?: ReactNode
  className?: string
  variant?: AdminSectionVariant
  /** 无 body 包裹层（如 stats 网格） */
  bare?: boolean
} & Omit<ComponentPropsWithoutRef<'section'>, 'title'>

export function AdminSection({
  children,
  title,
  description,
  actions,
  className,
  variant = 'default',
  bare = false,
  ...sectionProps
}: AdminSectionProps) {
  const hasHeader = Boolean(title || description || actions)
  const variantClass = variant !== 'default' ? `admin-section--${variant}` : ''

  return (
    <section
      className={['section-shell', 'admin-section', variantClass, className].filter(Boolean).join(' ')}
      {...sectionProps}
    >
      {hasHeader ? (
        <div className="admin-section__header">
          <div className="admin-section__heading">
            {title ? <h2 className="admin-section__title">{title}</h2> : null}
            {description ? <p className="admin-section__desc">{description}</p> : null}
          </div>
          {actions ? <div className="admin-section__actions">{actions}</div> : null}
        </div>
      ) : null}
      {bare ? children : <div className="admin-section__body">{children}</div>}
    </section>
  )
}
