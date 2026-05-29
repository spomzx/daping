import type { ReactNode } from 'react'

export function AnalyticsLayout({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={['analytics-layout', 'analytics-page', 'analytics-page-root', className].filter(Boolean).join(' ')}>
      {children}
    </div>
  )
}

export function AnalyticsTopFilters({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={['analytics-top-filters', 'analytics-page__filters', className].filter(Boolean).join(' ')}>
      {children}
    </div>
  )
}

export function AnalyticsGrid({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={['analytics-grid', 'analytics-main-grid', className].filter(Boolean).join(' ')}>{children}</div>
}

export function AnalyticsColumn({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={['analytics-column', 'analytics-main-col', className].filter(Boolean).join(' ')}>{children}</div>
  )
}

export type AnalyticsCardProps = {
  children: ReactNode
  title?: ReactNode
  actions?: ReactNode
  className?: string
}

export function AnalyticsCard({ children, title, actions, className }: AnalyticsCardProps) {
  return (
    <section className={['analytics-card', 'admin-section', className].filter(Boolean).join(' ')}>
      {title || actions ? (
        <header className="analytics-card__header admin-section__header">
          {title ? <h3 className="analytics-card__title admin-section__title">{title}</h3> : <span />}
          {actions ? <div className="analytics-card__actions admin-section__actions">{actions}</div> : null}
        </header>
      ) : null}
      <div className="analytics-card__body admin-section__body">{children}</div>
    </section>
  )
}
