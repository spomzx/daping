import { useCallback, useEffect, useState } from 'react'
import { useT } from '../../i18n'
import { SaasPageFrame } from '../../components/layout/SaasPageFrame'
import { fetchOrdersList, fetchOrdersStats, type OrderRow } from '../../services/api/orders'

function fmtDt(v: string | null | undefined): string {
  if (!v) return '—'
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleString('zh-CN', { hour12: false })
}

export function OrdersPage() {
  const t = useT()
  const [rows, setRows] = useState<OrderRow[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [stats, setStats] = useState({ orders: 0, gmv: 0, shops: 0 })
  const [market, setMarket] = useState('ALL')
  const [hours, setHours] = useState('24')
  const [status, setStatus] = useState('all')
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const pageSize = 30

  const load = useCallback(async () => {
    setLoading(true)
    setErr(null)
    const q: Record<string, string> = {
      page: String(page),
      page_size: String(pageSize),
      hours,
      status,
    }
    if (market !== 'ALL') q.market = market
    try {
      const [list, st] = await Promise.all([fetchOrdersList(q), fetchOrdersStats(q)])
      setRows(list.items)
      setTotal(list.total)
      setStats(st)
    } catch (e) {
      setErr(String((e as Error)?.message || e))
    } finally {
      setLoading(false)
    }
  }, [page, market, hours, status])

  useEffect(() => {
    void load()
  }, [load])

  const totalPages = Math.max(1, Math.ceil(total / pageSize))

  const toolbar = (
    <>
      <label>
        {t('orders.filter.market')}
        <select
          value={market}
          onChange={(e) => {
            setMarket(e.target.value)
            setPage(1)
          }}
          className="locale-select"
        >
          <option value="ALL">ALL</option>
          {['TH', 'PH', 'MY', 'SG', 'VN'].map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
      </label>
      <label>
        {t('orders.filter.hours')}
        <select
          value={hours}
          onChange={(e) => {
            setHours(e.target.value)
            setPage(1)
          }}
          className="locale-select"
        >
          <option value="24">24h</option>
          <option value="168">7d</option>
          <option value="720">30d</option>
        </select>
      </label>
      <label>
        {t('orders.filter.status')}
        <select
          value={status}
          onChange={(e) => {
            setStatus(e.target.value)
            setPage(1)
          }}
          className="locale-select"
        >
          <option value="all">{t('filter.order.all')}</option>
          <option value="valid">{t('filter.order.validShort')}</option>
          <option value="unpaid">{t('filter.order.unpaid')}</option>
          <option value="sample">{t('filter.order.sample')}</option>
          <option value="cancelled">{t('filter.order.cancelledShort')}</option>
        </select>
      </label>
      <button type="button" className="refresh-btn" disabled={loading} onClick={() => void load()}>
        {t('btn.refresh')}
      </button>
      <button
        type="button"
        className="refresh-btn"
        onClick={() => {
          setMarket('ALL')
          setHours('24')
          setStatus('all')
          setPage(1)
        }}
      >
        {t('saas.filter.reset')}
      </button>
    </>
  )

  const footer = (
    <div className="saas-module-toolbar" style={{ marginTop: 12 }}>
      <button type="button" className="refresh-btn" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
        {t('orders.pager.prev')}
      </button>
      <span>
        {page} / {totalPages}
      </span>
      <button type="button" className="refresh-btn" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>
        {t('orders.pager.next')}
      </button>
    </div>
  )

  return (
    <SaasPageFrame
      description={t('orders.pageDesc')}
      loading={loading}
      error={err}
      empty={!loading && !err && rows.length === 0}
      toolbar={toolbar}
      footer={footer}
    >
      <p className="debug-meta-hint">
        {t('orders.statsLine', { orders: stats.orders, gmv: stats.gmv.toFixed(2), shops: stats.shops, total })}
      </p>
      <div className="saas-table-wrap">
        <table className="saas-table">
          <thead>
            <tr>
              <th>{t('orders.col.time')}</th>
              <th>{t('orders.col.orderId')}</th>
              <th>{t('orders.col.shop')}</th>
              <th>{t('orders.col.market')}</th>
              <th>{t('orders.col.amount')}</th>
              <th>{t('orders.col.status')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td>{fmtDt(r.created_at_platform)}</td>
                <td className="saas-td-mono">{r.platform_order_id}</td>
                <td>{r.shop_name || '—'}</td>
                <td>{r.market || '—'}</td>
                <td className="num">
                  {r.total_amount ?? 0} {r.currency || ''}
                </td>
                <td>{r.analytics_status || r.order_status || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </SaasPageFrame>
  )
}
