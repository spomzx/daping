import { useT } from '../../../i18n'
import { AdminTableCell } from './AdminTableCell'
import { AdminTableRow } from './AdminTableRow'

export type AdminTableLoadingProps = {
  colSpan: number
  rows?: number
}

export function AdminTableLoading({ colSpan, rows = 5 }: AdminTableLoadingProps) {
  const t = useT()

  return (
    <>
      {Array.from({ length: rows }, (_, i) => (
        <AdminTableRow key={i} className="admin-table__row--skeleton" aria-hidden>
          <AdminTableCell colSpan={colSpan}>
            <span className="admin-table-skeleton-bar" />
          </AdminTableCell>
        </AdminTableRow>
      ))}
      <AdminTableRow className="admin-table__row--loading-msg">
        <AdminTableCell colSpan={colSpan} className="admin-table__loading-cell">
          <span className="admin-table-loading-label">{t('common.loading')}</span>
        </AdminTableCell>
      </AdminTableRow>
    </>
  )
}
