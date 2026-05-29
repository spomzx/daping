import { AdminTableCell } from '../table/AdminTableCell'
import { AdminTableRow } from '../table/AdminTableRow'
import { AdminEmptyState, type AdminEmptyVariant } from './AdminEmptyState'

export type AdminTableEmptyProps = {
  colSpan: number
  variant?: AdminEmptyVariant
  title?: string
  description?: string
}

export function AdminTableEmpty({ colSpan, variant = 'empty', title, description }: AdminTableEmptyProps) {
  return (
    <AdminTableRow>
      <AdminTableCell colSpan={colSpan} className="admin-table__empty-cell">
        <AdminEmptyState variant={variant} layout="table" title={title} description={description} />
      </AdminTableCell>
    </AdminTableRow>
  )
}
