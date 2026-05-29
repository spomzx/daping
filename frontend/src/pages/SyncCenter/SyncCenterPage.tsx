import { useCallback, useEffect, useMemo, useState } from 'react'
import { useT } from '../../i18n'
import { displayMarketCode } from '../../contracts/market.contract'
import { resolveHealthMetaFromSyncLabel } from '../../contracts/healthStatus.contract'
import { SaasPageFrame } from '../../components/layout/SaasPageFrame'
import {
  AdminBadge,
  AdminButton,
  AdminSection,
  AdminTable,
  AdminTableBody,
  AdminTableCell,
  AdminTableEmpty,
  AdminTableHeader,
  AdminTableLoading,
  AdminTableRow,
  AdminToolbarField,
} from '../../components/admin'
import { isAdminLike, type MeRole } from '../../authRole'
import {
  fetchSyncLogs,
  fetchSyncStatus,
  postSyncRetry,
  postSyncRun,
  type SyncLogRow,
  type SyncShopRow,
} from '../../services/api/sync'
import { ApiClientError } from '../../services/api/client'
import {
  isSyncCenterRunning,
  resolveSyncLogDisplayLabel,
  syncCenterStatusLabel,
} from '../../services/api/syncLabels'

function fmtDt(v: string | null | undefined): string {
  if (!v) return '—'
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleString('zh-CN', { hour12: false })
}

function formatSyncActionError(e: unknown): string {
  if (e instanceof ApiClientError) {
    if (e.status === 429 || e.body?.error === 'rate_limited') {
      return '同步频率过高，请稍后重试'
    }
    const msg = String(e.body?.message || e.body?.error || '').trim()
    if (/rate_limited/i.test(msg)) return '同步频率过高，请稍后重试'
  }
  const msg = String((e as Error)?.message || e)
  if (/rate_limited|429/i.test(msg)) return '同步频率过高，请稍后重试'
  return msg
}

export function SyncCenterPage({ appRole }: { appRole: MeRole }) {
  const t = useT()
  const canManualRole = isAdminLike(appRole)
  const [shops, setShops] = useState<SyncShopRow[]>([])
  const [logs, setLogs] = useState<SyncLogRow[]>([])
  const [canManualSync, setCanManualSync] = useState(false)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [busyShop, setBusyShop] = useState<string | null>(null)
  const [rowActionErr, setRowActionErr] = useState<Record<string, string>>({})
  const [filterShop, setFilterShop] = useState('')
  const [filterStatus, setFilterStatus] = useState('')

  const load = useCallback(async () => {
    setErr(null)
    setLoading(true)
    try {
      const [st, lg] = await Promise.all([
        fetchSyncStatus(),
        fetchSyncLogs({
          limit: '80',
          ...(filterShop ? { shop_id: filterShop } : {}),
          ...(filterStatus ? { status: filterStatus } : {}),
        }),
      ])
      setShops(Array.isArray(st.shops) ? st.shops : [])
      setCanManualSync(Boolean(st.can_manual_sync) && canManualRole)
      setLogs(Array.isArray(lg.items) ? lg.items : [])
    } catch (e) {
      setErr(String((e as Error)?.message || e))
    } finally {
      setLoading(false)
    }
  }, [filterShop, filterStatus, canManualRole])

  useEffect(() => {
    void load()
  }, [load])

  const shopOptions = useMemo(
    () =>
      shops.map((s) => ({
        id: String(s.shop_id),
        label: s.shop_name || s.platform_shop_id || String(s.shop_id),
      })),
    [shops],
  )

  const globalSyncRunning = useMemo(() => shops.some((s) => isSyncCenterRunning(s)), [shops])
  const shopColCount = canManualSync ? 6 : 5
  const logColCount = 6

  async function onRun(shop: SyncShopRow, retry = false) {
    if (!canManualSync || globalSyncRunning) return
    const key = String(shop.shop_id)
    setBusyShop(key)
    setRowActionErr((prev) => {
      const next = { ...prev }
      delete next[key]
      return next
    })
    try {
      if (retry) await postSyncRetry(key)
      else await postSyncRun(key)
      await load()
    } catch (e) {
      const msg = formatSyncActionError(e)
      setRowActionErr((prev) => ({ ...prev, [key]: msg }))
    } finally {
      setBusyShop(null)
    }
  }

  return (
    <div className="saas-admin-page sync-center-page">
      <SaasPageFrame
        title={t('saas.nav.sync')}
        description={t('sync.pageDesc')}
        loading={loading && shops.length === 0 && logs.length === 0}
        error={err}
        empty={!loading && !err && !shops.length && !logs.length}
        toolbarFilters={
          <>
            <AdminToolbarField label={t('sync.filter.shop')}>
              <select value={filterShop} onChange={(e) => setFilterShop(e.target.value)} className="locale-select">
                <option value="">{t('sync.filter.all')}</option>
                {shopOptions.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label}
                  </option>
                ))}
              </select>
            </AdminToolbarField>
            <AdminToolbarField label={t('sync.filter.status')}>
              <select value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)} className="locale-select">
                <option value="">{t('sync.filter.all')}</option>
                <option value="success">success</option>
                <option value="failed">failed</option>
                <option value="partial_success">partial_success</option>
                <option value="running">running</option>
              </select>
            </AdminToolbarField>
          </>
        }
        toolbarActions={
          <>
            <AdminButton variant="secondary" disabled={loading} onClick={() => void load()}>
              {loading ? t('common.refreshing') : t('btn.refresh')}
            </AdminButton>
            <AdminButton
              variant="secondary"
              onClick={() => {
                setFilterShop('')
                setFilterStatus('')
              }}
            >
              {t('saas.filter.reset')}
            </AdminButton>
          </>
        }
      >
        <AdminSection variant="table" title={t('sync.section.shops')}>
          <AdminTable minWidth={880} maxHeight={420} zebra wrapClassName="sync-shops-table-wrap">
            <AdminTableHeader>
              <AdminTableRow>
                <AdminTableCell as="th" className="col-shop">
                  {t('sync.col.shop')}
                </AdminTableCell>
                <AdminTableCell as="th" className="col-market">
                  {t('sync.col.market')}
                </AdminTableCell>
                <AdminTableCell as="th">{t('sync.col.lastSync')}</AdminTableCell>
                <AdminTableCell as="th" className="col-status">
                  {t('sync.col.status')}
                </AdminTableCell>
                <AdminTableCell as="th" className="col-orders">
                  {t('sync.col.todayOrders')}
                </AdminTableCell>
                {canManualSync ? (
                  <AdminTableCell as="th" className="col-actions">
                    {t('sync.col.actions')}
                  </AdminTableCell>
                ) : null}
              </AdminTableRow>
            </AdminTableHeader>
            <AdminTableBody>
              {loading && shops.length === 0 ? (
                <AdminTableLoading colSpan={shopColCount} rows={4} />
              ) : shops.length === 0 ? (
                <AdminTableEmpty colSpan={shopColCount} />
              ) : (
                shops.map((s) => {
                  const key = String(s.shop_id)
                  const busy = busyShop === key
                  const actionErr = rowActionErr[key]
                  const statusText = syncCenterStatusLabel(s)
                  const shopRunning = isSyncCenterRunning(s)
                  const syncBlocked = globalSyncRunning || shopRunning
                  const health = resolveHealthMetaFromSyncLabel(statusText)
                  const orders = Number(s.today_orders ?? s.today_orders_count ?? 0)
                  return (
                    <AdminTableRow key={s.shop_id}>
                      <AdminTableCell className="col-shop" title={s.shop_name || key}>
                        {s.shop_name || key}
                      </AdminTableCell>
                      <AdminTableCell className="col-market">{displayMarketCode(s.market)}</AdminTableCell>
                      <AdminTableCell>{fmtDt(s.last_sync_at)}</AdminTableCell>
                      <AdminTableCell className="col-status">
                        <AdminBadge variant={health.variant} title={health.tooltip}>
                          {statusText}
                        </AdminBadge>
                      </AdminTableCell>
                      <AdminTableCell numeric className="col-orders">
                        {orders > 0 ? orders : 0}
                      </AdminTableCell>
                      {canManualSync ? (
                        <AdminTableCell className="col-actions" title={actionErr || undefined}>
                          <div className="saas-sync-actions">
                            <AdminButton
                              variant="secondary"
                              disabled={busy || syncBlocked}
                              onClick={() => void onRun(s, false)}
                            >
                              {busy ? t('common.loading') : syncBlocked ? '同步执行中' : t('sync.action.run')}
                            </AdminButton>
                            {!syncBlocked ? (
                              <AdminButton variant="secondary" disabled={busy} onClick={() => void onRun(s, true)}>
                                {busy ? t('common.loading') : t('sync.action.retry')}
                              </AdminButton>
                            ) : null}
                          </div>
                        </AdminTableCell>
                      ) : null}
                    </AdminTableRow>
                  )
                })
              )}
            </AdminTableBody>
          </AdminTable>
        </AdminSection>

        <AdminSection variant="log" title={t('sync.section.logs')}>
          <AdminTable minWidth={880} maxHeight={420} zebra wrapClassName="sync-logs-table-wrap">
            <AdminTableHeader>
              <AdminTableRow>
                <AdminTableCell as="th">{t('sync.col.time')}</AdminTableCell>
                <AdminTableCell as="th" className="col-shop">
                  {t('sync.col.shop')}
                </AdminTableCell>
                <AdminTableCell as="th" className="col-status">
                  {t('sync.col.status')}
                </AdminTableCell>
                <AdminTableCell as="th" className="col-orders">
                  {t('sync.col.fetched')}
                </AdminTableCell>
                <AdminTableCell as="th" className="col-orders">
                  {t('sync.col.written')}
                </AdminTableCell>
                <AdminTableCell as="th">{t('sync.col.duration')}</AdminTableCell>
              </AdminTableRow>
            </AdminTableHeader>
            <AdminTableBody>
              {loading && logs.length === 0 ? (
                <AdminTableLoading colSpan={logColCount} rows={4} />
              ) : logs.length === 0 ? (
                <AdminTableEmpty colSpan={logColCount} />
              ) : (
                logs.map((l) => {
                  const logLabel = resolveSyncLogDisplayLabel(l.status)
                  const health = resolveHealthMetaFromSyncLabel(logLabel)
                  return (
                    <AdminTableRow key={l.id}>
                      <AdminTableCell>{fmtDt(l.created_at)}</AdminTableCell>
                      <AdminTableCell
                        className="col-shop"
                        title={String(l.shop_name || l.platform_shop_id || l.shop_id || '')}
                      >
                        {l.shop_name || l.platform_shop_id || l.shop_id}
                      </AdminTableCell>
                      <AdminTableCell className="col-status">
                        <AdminBadge variant={health.variant} title={health.tooltip}>
                          {logLabel}
                        </AdminBadge>
                      </AdminTableCell>
                      <AdminTableCell numeric className="col-orders">
                        {l.fetched_orders_count ?? 0}
                      </AdminTableCell>
                      <AdminTableCell numeric className="col-orders">
                        {(l.inserted_orders_count ?? 0) + (l.updated_orders_count ?? 0)}
                      </AdminTableCell>
                      <AdminTableCell numeric>{l.duration_ms != null ? `${l.duration_ms}ms` : '—'}</AdminTableCell>
                    </AdminTableRow>
                  )
                })
              )}
            </AdminTableBody>
          </AdminTable>
        </AdminSection>
      </SaasPageFrame>
    </div>
  )
}
