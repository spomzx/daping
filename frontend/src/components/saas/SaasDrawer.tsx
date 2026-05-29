import { useEffect, type ReactNode } from 'react'

export type SaasDrawerProps = {
  open: boolean
  title: string
  subtitle?: ReactNode
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
}

export function SaasDrawer({ open, title, subtitle, onClose, children, footer }: SaasDrawerProps) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = prev
    }
  }, [open, onClose])

  if (!open) return null

  return (
    <>
      <div className="saas-drawer-backdrop" role="presentation" onClick={onClose} aria-hidden />
      <aside className="saas-drawer" role="dialog" aria-modal="true" aria-labelledby="saas-drawer-title">
        <header className="saas-drawer__header">
          <h2 id="saas-drawer-title" className="saas-drawer__title">
            {title}
          </h2>
          {subtitle ? <p className="saas-drawer__subtitle">{subtitle}</p> : null}
        </header>
        <div className="saas-drawer__body">{children}</div>
        {footer ? <footer className="saas-drawer__footer">{footer}</footer> : null}
      </aside>
    </>
  )
}
