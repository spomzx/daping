import type { ReactNode } from 'react'
import { useT } from '../../i18n'

export type SaasPageFrameProps = {
  title?: string
  description?: string
  loading?: boolean
  error?: string | null
  empty?: boolean
  emptyLabel?: string
  toolbar?: ReactNode
  children?: ReactNode
  footer?: ReactNode
}

/** SaaS 内页统一：说明 + 筛选 + 状态 + 内容（不含重复导航） */
export function SaasPageFrame({
  title,
  description,
  loading,
  error,
  empty,
  emptyLabel,
  toolbar,
  children,
  footer,
}: SaasPageFrameProps) {
  const t = useT()

  return (
    <div className="saas-page-frame">
      {title ? <h2 className="saas-page-frame__title">{title}</h2> : null}
      {description ? <p className="saas-page-frame__desc">{description}</p> : null}
      {toolbar ? <div className="saas-module-toolbar">{toolbar}</div> : null}
      {error ? <p className="warn-text saas-page-frame__error">{error}</p> : null}
      {loading ? <p className="saas-page-frame__loading">{t('common.loading')}</p> : null}
      {!loading && !error && empty ? (
        <p className="saas-page-frame__empty">{emptyLabel || t('empty.noData')}</p>
      ) : null}
      {!loading && !error && !empty ? children : null}
      {footer}
    </div>
  )
}
