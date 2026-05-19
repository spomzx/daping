import { useCallback, useEffect, useMemo, useState } from 'react'
import { useT } from '../../i18n'
import { SaasPageFrame } from '../../components/layout/SaasPageFrame'
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
  isSyncRunningLabel,
  resolveShopSyncDisplayLabel,
  resolveSyncLogDisplayLabel,
} from '../../services/api/syncLabels'

function parseSyncTs(v: string | null | undefined): number | null {
  if (v == null || v === '') return null
  const t = Date.parse(String(v))
  return Number.isFinite(t) ? t : null
}

function fmtDt(v: string | null | undefined): string {
  if (!v) return '—'
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleString('zh-CN', { hour12: false })
}

function syncStatusBadge(status: string | null | undefined) {
  const label = status || '—'
  if (label === '同步正常' || label === '授权正常' || label === '近24h无订单') {
    return { cls: 'saas-badge saas-badge--success', label }
  }
  if (label === '限流中' || label === '异常' || label === '授权失效') {
    return { cls: 'saas-badge saas-badge--danger', label }
  }
  if (label === '同步中' || label === '未授权' || label === '同步超时') {
    return { cls: 'saas-badge saas-badge--warn', label }
  }
  return { cls: 'saas-badge saas-badge--muted', label }
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

  const latestLogByShopId = useMemo(() => {
    const m = new Map<number, SyncLogRow>()
    for (const l of logs) {
      const id = Number(l.shop_id)
      if (!Number.isFinite(id) || id <= 0) continue
      const prev = m.get(id)
      const curTs = parseSyncTs(l.created_at)
      const prevTs = prev ? parseSyncTs(prev.created_at) : null
      if (!prev || (curTs != null && (prevTs == null || curTs >= prevTs))) {
        m.set(id, l)
      }
    }
    return m
  }, [logs])

  const globalSyncRunning = useMemo(
    () =>
      shops.some((s) => {
        const label = resolveShopSyncDisplayLabel(s, latestLogByShopId.get(Number(s.shop_id)))
        return isSyncRunningLabel(label)
      }),
    [shops, latestLogByShopId],
  )

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

  const toolbar = (
    <>
      <label>
        {t('sync.filter.shop')}
        <select value={filterShop} onChange={(e) => setFilterShop(e.target.value)} className="locale-select">
          <option value="">{t('sync.filter.all')}</option>
          {shopOptions.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
      <label>
        {t('sync.filter.status')}
        <select value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)} className="locale-select">
          <option value="">{t('sync.filter.all')}</option>
          <option value="success">success</option>
          <option value="failed">failed</option>
          <option value="partial_success">partial_success</option>
          <option value="running">running</option>
        </select>
      </label>
      <button type="button" className="refresh-btn" disabled={loading} onClick={() => void load()}>
        {loading ? t('common.refreshing') : t('btn.refresh')}
      </button>
      <button
        type="button"
        className="refresh-btn"
        onClick={() => {
          setFilterShop('')
          setFilterStatus('')
        }}
      >
        {t('saas.filter.reset')}
      </button>
    </>
  )

  return (
    <div className="saas-admin-page sync-center-page">
      <SaasPageFrame
        description={t('sync.pageDesc')}
        loading={loading}
        error={err}
        empty={!loading && !err && !shops.length && !logs.length}
        toolbar={toolbar}
      >
        <div className="sync-center-body">
        <section className="saas-module-section sync-shops-section">
          <h3>{t('sync.section.shops')}</h3>
          <div className="saas-table-wrap sync-shops-table-wrap">
            <table className="saas-table">
              <thead>
                <tr>
                  <th className="col-shop">{t('sync.col.shop')}</th>
                  <th className="col-market">{t('sync.col.market')}</th>
                  <th>{t('sync.col.lastSync')}</th>
                  <th className="col-status">{t('sync.col.status')}</th>
                  <th className="col-orders">{t('sync.col.todayOrders')}</th>
                  {canManualSync ? <th className="col-actions">{t('sync.col.actions')}</th> : null}
                </tr>
              </thead>
              <tbody>
                {shops.map((s) => {
                  const key = String(s.shop_id)
                  const busy = busyShop === key
                  const actionErr = rowActionErr[key]
                  const latestLog = latestLogByShopId.get(Number(s.shop_id)) ?? null
                  const statusText = resolveShopSyncDisplayLabel(s, latestLog)
                  const shopRunning = isSyncRunningLabel(statusText)
                  const syncBlocked = globalSyncRunning || shopRunning
                  const st = syncStatusBadge(statusText)
                  const orders = Number(s.today_orders_count ?? 0)
                  return (
                    <tr key={s.shop_id}>
                      <td className="col-shop" title={s.shop_name || key}>
                        {s.shop_name || key}
                      </td>
                      <td className="col-market">{s.market || '—'}</td>
                      <td>{fmtDt(s.last_sync_at)}</td>
                      <td className="col-status">
                        <span className={st.cls}>{st.label}</span>
                      </td>
                      <td className="num col-orders">{orders > 0 ? orders : 0}</td>
                      {canManualSync ? (
                        <td className="col-actions" title={actionErr || undefined}>
                          <div className="saas-sync-actions">
                            <button
                              type="button"
                              className="refresh-btn"
                              disabled={busy || syncBlocked}
                              onClick={() => void onRun(s, false)}
                            >
                              {busy ? t('common.loading') : syncBlocked ? '同步执行中' : t('sync.action.run')}
                            </button>
                            {!syncBlocked ? (
                              <button
                                type="button"
                                className="refresh-btn"
                                disabled={busy}
                                onClick={() => void onRun(s, true)}
                              >
                                {busy ? t('common.loading') : t('sync.action.retry')}
                              </button>
                            ) : null}
                          </div>
                        </td>
                      ) : null}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </section>

        <section className="saas-module-section sync-logs-section">
          <h3>{t('sync.section.logs')}</h3>
          <div className="saas-table-wrap sync-logs-table-wrap">
            <table className="saas-table">
              <thead>
                <tr>
                  <th>{t('sync.col.time')}</th>
                  <th className="col-shop">{t('sync.col.shop')}</th>
                  <th className="col-status">{t('sync.col.status')}</th>
                  <th className="col-orders">{t('sync.col.fetched')}</th>
                  <th className="col-orders">{t('sync.col.written')}</th>
                  <th>{t('sync.col.duration')}</th>
                </tr>
              </thead>
              <tbody>
                {logs.map((l) => {
                  const logLabel = resolveSyncLogDisplayLabel(l.status)
                  const st = syncStatusBadge(logLabel)
                  return (
                    <tr key={l.id}>
                      <td>{fmtDt(l.created_at)}</td>
                      <td className="col-shop" title={String(l.shop_name || l.platform_shop_id || l.shop_id || '')}>
                        {l.shop_name || l.platform_shop_id || l.shop_id}
                      </td>
                      <td className="col-status">
                        <span className={st.cls}>{st.label}</span>
                      </td>
                      <td className="num col-orders">{l.fetched_orders_count ?? 0}</td>
                      <td className="num col-orders">
                        {(l.inserted_orders_count ?? 0) + (l.updated_orders_count ?? 0)}
                      </td>
                      <td className="num">{l.duration_ms != null ? `${l.duration_ms}ms` : '—'}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </section>
        </div>
      </SaasPageFrame>
    </div>
  )
}
