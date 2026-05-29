import type { ReactNode } from 'react'
import { useT } from '../../i18n'
import { AdminEmptyState, AdminPageHeader, AdminSection, AdminToolbar } from '../admin'
import { useDashboardShellOptional } from './DashboardShellContext'

export type SaasPageFrameProps = {
  title?: string
  description?: string
  /** 页头右侧操作；页面标题默认由 Topbar 展示 */
  headerActions?: ReactNode
  /** 筛选区（兼容：整段作为 filters） */
  toolbar?: ReactNode
  toolbarFilters?: ReactNode
  toolbarActions?: ReactNode
  loading?: boolean
  error?: string | null
  empty?: boolean
  emptyLabel?: string
  children?: ReactNode
  footer?: ReactNode
  /** 是否在 page-shell 内重复展示标题（默认 false，标题在 Topbar） */
  showPageTitle?: boolean
}

/** SaaS page-shell：描述 + sections（标题由 Dashboard Topbar 承担） */
export function SaasPageFrame({
  title,
  description,
  headerActions,
  toolbar,
  toolbarFilters,
  toolbarActions,
  loading,
  error,
  empty,
  emptyLabel,
  children,
  footer,
  showPageTitle = false,
}: SaasPageFrameProps) {
  const t = useT()
  const shell = useDashboardShellOptional()
  const showContent = !loading && !error && !empty
  const displayTitle = showPageTitle ? title : shell ? undefined : title
  const hasToolbar = Boolean(toolbar || toolbarFilters || toolbarActions)

  return (
    <div className="page-shell admin-page-shell">
      {displayTitle || description || headerActions ? (
        <AdminPageHeader title={displayTitle} description={description} actions={headerActions} />
      ) : null}

      {hasToolbar ? (
        <AdminSection variant="filter" bare>
          <AdminToolbar filters={toolbarFilters ?? toolbar} actions={toolbarActions} />
        </AdminSection>
      ) : null}

      {error ? (
        <AdminEmptyState variant="error" title={t('admin.empty.errorTitle')} description={error} />
      ) : null}
      {loading && !error ? (
        <AdminEmptyState
          variant="empty"
          layout="compact"
          title={t('common.loading')}
          description={t('admin.empty.emptyDesc')}
        />
      ) : null}
      {!loading && !error && empty ? (
        <AdminEmptyState
          variant="empty"
          layout="section"
          title={emptyLabel || t('empty.noData')}
          description={t('admin.empty.emptyDesc')}
        />
      ) : null}

      {showContent ? children : null}

      {footer ? <div className="admin-page-footer page-shell__footer">{footer}</div> : null}
    </div>
  )
}
