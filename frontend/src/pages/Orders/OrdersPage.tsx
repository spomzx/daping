import { useCallback, useEffect, useState } from 'react'
import { useT } from '../../i18n'
import { SaasPageFrame } from '../../components/layout/SaasPageFrame'
import {
  AdminButton,
  AdminPagination,
  AdminSection,
  AdminStatCard,
  AdminTable,
  AdminTableBody,
  AdminTableCell,
  AdminTableEmpty,
  AdminTableFooter,
  AdminTableHeader,
  AdminTableLoading,
  AdminTableRow,
  AdminTableShell,
  AdminToolbarField,
} from '../../components/admin'
import { fetchOrdersList, fetchOrdersStats } from '../../services/api/orders'
import type { OrdersListItem } from '../../types/ordersListApi'
import {
  buildDashboardQueryParams,
  setDashboardQueryState,
  useDashboardQueryStore,
} from '../../stores/dashboardQueryStore'

const COL_COUNT = 6

function fmtDt(v: string | null | undefined): string {
  if (!v) return '—'
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleString('zh-CN', { hour12: false })
}

export function OrdersPage() {
  const t = useT()
  const [rows, setRows] = useState<OrdersListItem[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [stats, setStats] = useState({ orders: 0, gmv: 0, shops: 0 })
  const queryStore = useDashboardQueryStore()
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const pageSize = 30

  const load = useCallback(async () => {
    setLoading(true)
    setErr(null)
    const q = {
      ...buildDashboardQueryParams(queryStore),
      page: String(page),
      page_size: String(pageSize),
    }
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
  }, [page, pageSize, queryStore])

  useEffect(() => {
    void load()
  }, [load])

  const totalPages = Math.max(1, Math.ceil(total / pageSize))

  const resetFilters = () => {
    setDashboardQueryState({ market: 'ALL', range: 'today', orderFilter: 'all', shopId: 'all' })
    setPage(1)
  }

  return (
    <div className="saas-admin-page orders-page">
      <SaasPageFrame
        title={t('saas.nav.orders')}
        description={t('orders.pageDesc')}
        loading={loading && rows.length === 0}
        error={err}
        empty={!loading && !err && rows.length === 0}
        toolbarFilters={
          <>
            <AdminToolbarField label={t('orders.filter.market')}>
              <select
                value={queryStore.market}
                onChange={(e) => {
                  setDashboardQueryState({ market: e.target.value })
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
            </AdminToolbarField>
            <AdminToolbarField label={t('orders.filter.hours')}>
              <select
                value={queryStore.range === '7d' ? '168' : queryStore.range === '30d' ? '720' : '24'}
                onChange={(e) => {
                  const nextRange = e.target.value === '168' ? '7d' : e.target.value === '720' ? '30d' : 'today'
                  setDashboardQueryState({ range: nextRange })
                  setPage(1)
                }}
                className="locale-select"
              >
                <option value="24">24h</option>
                <option value="168">7d</option>
                <option value="720">30d</option>
              </select>
            </AdminToolbarField>
            <AdminToolbarField label={t('orders.filter.status')}>
              <select
                value={queryStore.orderFilter}
                onChange={(e) => {
                  setDashboardQueryState({ orderFilter: e.target.value as 'all' | 'valid' | 'unpaid' | 'sample' | 'cancelled' })
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
            </AdminToolbarField>
          </>
        }
        toolbarActions={
          <>
            <AdminButton variant="secondary" disabled={loading} onClick={() => void load()}>
              {t('btn.refresh')}
            </AdminButton>
            <AdminButton variant="secondary" onClick={resetFilters}>
              {t('saas.filter.reset')}
            </AdminButton>
          </>
        }
        footer={
          <AdminTableFooter>
            <AdminPagination
              page={page}
              totalPages={totalPages}
              disabled={loading}
              density="compact"
              onPrev={() => setPage((p) => p - 1)}
              onNext={() => setPage((p) => p + 1)}
            />
          </AdminTableFooter>
        }
      >
        <AdminSection variant="stats" bare>
          <div className="admin-stats-grid">
            <AdminStatCard label="订单数" value={stats.orders} />
            <AdminStatCard label="GMV" value={stats.gmv.toFixed(2)} />
            <AdminStatCard label="店铺数" value={stats.shops} />
            <AdminStatCard label="列表条数" value={total} />
          </div>
        </AdminSection>

        <AdminTableShell
          title="订单列表"
          description={t('orders.statsLine', {
            orders: stats.orders,
            gmv: stats.gmv.toFixed(2),
            shops: stats.shops,
            total,
          })}
        >
          <AdminTable minWidth={960} zebra>
            <AdminTableHeader>
              <AdminTableRow>
                <AdminTableCell as="th">{t('orders.col.time')}</AdminTableCell>
                <AdminTableCell as="th">{t('orders.col.orderId')}</AdminTableCell>
                <AdminTableCell as="th">{t('orders.col.shop')}</AdminTableCell>
                <AdminTableCell as="th">{t('orders.col.market')}</AdminTableCell>
                <AdminTableCell as="th">{t('orders.col.amount')}</AdminTableCell>
                <AdminTableCell as="th">{t('orders.col.status')}</AdminTableCell>
              </AdminTableRow>
            </AdminTableHeader>
            <AdminTableBody>
              {loading ? (
                <AdminTableLoading colSpan={COL_COUNT} rows={6} />
              ) : rows.length === 0 ? (
                <AdminTableEmpty colSpan={COL_COUNT} />
              ) : (
                rows.map((r) => (
                  <AdminTableRow key={r.id}>
                    <AdminTableCell>{fmtDt(r.created_at_platform)}</AdminTableCell>
                    <AdminTableCell mono>{r.platform_order_id}</AdminTableCell>
                    <AdminTableCell>{r.shop_name || '—'}</AdminTableCell>
                    <AdminTableCell>{r.market || '—'}</AdminTableCell>
                    <AdminTableCell numeric>
                      {r.total_amount ?? 0} {r.currency || ''}
                    </AdminTableCell>
                    <AdminTableCell>{r.analytics_status || r.order_status || '—'}</AdminTableCell>
                  </AdminTableRow>
                ))
              )}
            </AdminTableBody>
          </AdminTable>
        </AdminTableShell>
      </SaasPageFrame>
    </div>
  )
}
