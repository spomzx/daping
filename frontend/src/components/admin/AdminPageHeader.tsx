import type { ReactNode } from 'react'

export type AdminPageHeaderProps = {
  title?: string
  description?: string
  actions?: ReactNode
}

export function AdminPageHeader({ title, description, actions }: AdminPageHeaderProps) {
  if (!title && !description && !actions) return null

  return (
    <header className="admin-page-header admin-page-header--saas">
      <div className="admin-page-header__main">
        {title ? <h1 className="admin-page-header__title">{title}</h1> : null}
        {description ? <p className="admin-page-header__desc">{description}</p> : null}
      </div>
      {actions ? <div className="admin-page-header__actions">{actions}</div> : null}
    </header>
  )
}
