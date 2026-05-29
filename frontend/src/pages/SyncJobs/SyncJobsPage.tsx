import { useCallback, useEffect, useState } from 'react'
import { fetchSyncJobs, type SyncJobRow } from '../../services/api/syncJobs'
import { useT } from '../../i18n'
import type { MeRole } from '../../authRole'
import { resolveSyncStatusMeta, type SyncStatusCode } from '../../contracts/syncStatus.contract'
import { SaasPageFrame } from '../../components/layout/SaasPageFrame'
import {
  AdminButton,
  AdminSection,
  AdminTable,
  AdminTableBody,
  AdminTableCell,
  AdminTableEmpty,
  AdminTableHeader,
  AdminTableLoading,
  AdminTableRow,
} from '../../components/admin'
import '../../admin/styles/admin-sync.css'

const STATUS_FILTERS: Array<'' | SyncStatusCode> = ['', 'queued', 'running', 'retry_wait', 'success', 'failed']
const COL_COUNT = 7

function fmtDt(v: string | null | undefined) {
  if (!v) return '—'
  const d = new Date(v)
  return Number.isFinite(d.getTime()) ? d.toLocaleString() : String(v)
}

export function SyncJobsPage({ appRole: _appRole }: { appRole: MeRole }) {
  const t = useT()
  const [items, setItems] = useState<SyncJobRow[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [statusFilter, setStatusFilter] = useState<string>('')

  const load = useCallback(async () => {
    setLoading(true)
    setErr(null)
    try {
      const res = await fetchSyncJobs({
        status: statusFilter || undefined,
        limit: 100,
      })
      setItems(Array.isArray(res.items) ? res.items : [])
    } catch (e) {
      setErr(String((e as Error)?.message || e))
      setItems([])
    } finally {
      setLoading(false)
    }
  }, [statusFilter])

  useEffect(() => {
    void load()
    const id = window.setInterval(() => void load(), 15000)
    return () => window.clearInterval(id)
  }, [load])

  return (
    <div className="saas-admin-page sync-jobs-page">
      <SaasPageFrame
        title={t('syncJobs.title')}
        description={t('syncJobs.hint')}
        error={err}
        loading={loading && items.length === 0}
        empty={!loading && !err && items.length === 0}
        toolbarFilters={
          <>
            {STATUS_FILTERS.map((st) => (
              <AdminButton
                key={st || 'all'}
                variant="secondary"
                active={statusFilter === st}
                onClick={() => setStatusFilter(st)}
              >
                {st ? resolveSyncStatusMeta(st).label : t('syncJobs.filterAll')}
              </AdminButton>
            ))}
          </>
        }
        toolbarActions={
          <AdminButton variant="secondary" onClick={() => void load()}>
            {t('syncJobs.refresh')}
          </AdminButton>
        }
      >
        <AdminSection variant="table" title={t('syncJobs.title')}>
          <AdminTable
            minWidth={900}
            maxHeight={520}
            zebra
            wrapClassName="sync-jobs-table-wrap"
            className="sync-jobs-table"
          >
            <AdminTableHeader>
              <AdminTableRow>
                <AdminTableCell as="th">ID</AdminTableCell>
                <AdminTableCell as="th">{t('syncJobs.colShop')}</AdminTableCell>
                <AdminTableCell as="th">{t('syncJobs.colStatus')}</AdminTableCell>
                <AdminTableCell as="th">{t('syncJobs.colAttempt')}</AdminTableCell>
                <AdminTableCell as="th">{t('syncJobs.colDuration')}</AdminTableCell>
                <AdminTableCell as="th">{t('syncJobs.colStarted')}</AdminTableCell>
                <AdminTableCell as="th">{t('syncJobs.colError')}</AdminTableCell>
              </AdminTableRow>
            </AdminTableHeader>
            <AdminTableBody>
              {loading ? (
                <AdminTableLoading colSpan={COL_COUNT} />
              ) : items.length === 0 ? (
                <AdminTableEmpty colSpan={COL_COUNT} title={t('syncJobs.empty')} />
              ) : (
                items.map((row) => (
                  <AdminTableRow key={row.id}>
                    <AdminTableCell>{row.id}</AdminTableCell>
                    <AdminTableCell>
                      <div>{row.shop_name || '—'}</div>
                      <small>{row.platform_shop_id || row.shop_id}</small>
                    </AdminTableCell>
                    <AdminTableCell>
                      {(() => {
                        const status = resolveSyncStatusMeta(row.status)
                        return (
                          <span className={`admin-badge admin-badge--${status.variant}`} title={status.tooltip}>
                            {status.label}
                          </span>
                        )
                      })()}
                    </AdminTableCell>
                    <AdminTableCell>
                      {row.attempt_count}/{row.max_attempts}
                    </AdminTableCell>
                    <AdminTableCell>{row.duration_ms != null ? `${Math.round(row.duration_ms)}ms` : '—'}</AdminTableCell>
                    <AdminTableCell>{fmtDt(row.started_at)}</AdminTableCell>
                    <AdminTableCell className="sync-jobs-err-cell" title={row.error_message || ''}>
                      {row.error_message ? String(row.error_message).slice(0, 80) : '—'}
                    </AdminTableCell>
                  </AdminTableRow>
                ))
              )}
            </AdminTableBody>
          </AdminTable>
        </AdminSection>
      </SaasPageFrame>
    </div>
  )
}
