import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { formatMoneyByCurrency } from '../currencyDisplay'
import type { DashboardFilterState } from '../lib/dashboardFilters'
import { buildModuleDashboardQuery } from '../lib/dashboardFilterContract'
import { inferOrderIsSample } from '../lib/dashboardOrderFilter'
import {
  beginDashboardQuerySoft,
  isAbortedFetchError,
  shouldApplyDashboardQueryGeneration,
} from '../lib/dashboardQueryGuard'
import {
  bindOrdersPanel,
  buildOrdersCanonicalKey,
  mergeOrdersPollSuspendUntil,
  notifyDashboardOrdersMetricsChanged,
} from '../lib/ordersPollScheduler'
import { useT } from '../i18n'
import type { OrderLevel, OrderRealtimeDto } from '../types/orderRealtimeDto'
import { fetchRealtimeOrders } from '../services/api/realtime'

export type { OrderLevel, OrderRealtimeDto } from '../types/orderRealtimeDto'

const REALTIME_ORDERS_LIMIT = 50

const MARKET_COLORS: Record<string, string> = {
  TH: '#00E5FF',
  MY: '#FFD54F',
  SG: '#81C784',
  PH: '#FF8A65',
  VN: '#BA68C8',
}

/** @deprecated 使用 OrderRealtimeDto */
export type RealtimeOrderRow = OrderRealtimeDto

function pad2(n: number) {
  return String(Math.floor(Math.max(0, n))).padStart(2, '0')
}

export function formatOrderTimeHms(created: string): string {
  if (!created) return '—'
  const m = created.match(/\b(\d{2}):(\d{2}):(\d{2})\b/)
  if (m) return `${m[1]}:${m[2]}:${m[3]}`
  const t = Date.parse(created)
  if (Number.isFinite(t)) {
    const d = new Date(t)
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
  }
  return created
}

function mergeRealtimeOrderRows(
  prev: OrderRealtimeDto[],
  incoming: OrderRealtimeDto[],
): { next: OrderRealtimeDto[]; newIds: string[] } {
  const prevSet = new Set(prev.map((r) => r.platform_order_id))
  const newIds = incoming.filter((r) => !prevSet.has(r.platform_order_id)).map((r) => r.platform_order_id)
  const seen = new Set<string>()
  const out: OrderRealtimeDto[] = []
  for (const r of incoming) {
    if (seen.has(r.platform_order_id)) continue
    seen.add(r.platform_order_id)
    out.push(r)
    if (out.length >= REALTIME_ORDERS_LIMIT) break
  }
  for (const r of prev) {
    if (out.length >= REALTIME_ORDERS_LIMIT) break
    if (!seen.has(r.platform_order_id)) {
      seen.add(r.platform_order_id)
      out.push(r)
    }
  }
  return { next: out, newIds }
}

function sameRealtimeRows(a: OrderRealtimeDto[], b: OrderRealtimeDto[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const x = a[i]
    const y = b[i]
    if (
      x.platform_order_id !== y.platform_order_id ||
      x.shop_id !== y.shop_id ||
      x.shop_name !== y.shop_name ||
      x.market !== y.market ||
      x.currency !== y.currency ||
      x.amount !== y.amount ||
      x.usd_amount !== y.usd_amount ||
      x.items !== y.items ||
      x.is_large_order !== y.is_large_order ||
      x.is_multi_item !== y.is_multi_item ||
      x.market_color !== y.market_color ||
      x.order_level !== y.order_level ||
      x.created_at_platform !== y.created_at_platform
    ) {
      return false
    }
  }
  return true
}

function orderLevelFromAmount(usd: number): OrderLevel {
  if (usd >= 500) return 'super'
  if (usd >= 200) return 'large'
  if (usd >= 80) return 'medium'
  return 'small'
}

function extractOrdersFromDashboardPayload(j: unknown): Record<string, unknown>[] {
  if (!j || typeof j !== 'object') return []
  const o = j as Record<string, unknown>
  if (Array.isArray(o.orders)) return o.orders as Record<string, unknown>[]
  if (Array.isArray(o.list)) return o.list as Record<string, unknown>[]
  if (Array.isArray(o.data)) return o.data as Record<string, unknown>[]
  return []
}

function mapApiOrderRow(row: Record<string, unknown>): OrderRealtimeDto {
  const amount = Number(row.original_amount ?? row.amount ?? 0)
  const pending = Boolean(row.usd_pending)
  const usdRaw = row.usd_amount ?? row.usdAmount
  const usd = pending ? null : Number(usdRaw ?? 0)
  const itemsRaw = Number(row.items ?? 1)
  const items = Number.isFinite(itemsRaw) && itemsRaw > 0 ? itemsRaw : 1
  const market = String(row.market ?? '')
    .trim()
    .toUpperCase()
  return {
    platform_order_id: String(row.platform_order_id || '').trim(),
    shop_id: row.shop_id != null && Number.isFinite(Number(row.shop_id)) ? Number(row.shop_id) : null,
    shop_name: String(row.shop_name ?? 'TikTok Shop'),
    market: market || '—',
    currency: String(row.original_currency ?? row.currency ?? 'USD')
      .trim()
      .toUpperCase(),
    amount: Number.isFinite(amount) ? amount : 0,
    usd_amount: usd != null && Number.isFinite(usd) ? usd : null,
    usd_pending: pending,
    original_amount: Number.isFinite(amount) ? amount : 0,
    original_currency: String(row.original_currency ?? row.currency ?? 'USD')
      .trim()
      .toUpperCase(),
    cny_amount: Number(row.cny_amount ?? 0) || undefined,
    items,
    is_large_order: Boolean(row.is_large_order),
    is_multi_item: Boolean(row.is_multi_item) || items > 1,
    market_color: String(row.market_color || MARKET_COLORS[market] || '#90A4AE'),
    order_level: (row.order_level as OrderLevel | undefined) || orderLevelFromAmount(usd ?? amount),
    created_at_platform: String(row.created_at_platform ?? ''),
    is_sample: Boolean(row.is_sample) || inferOrderIsSample(row),
  }
}

/** 唯一 HTTP 入口：仅 ordersPollScheduler 回调 */
async function fetchDashboardRealtimeOrders(
  filters: DashboardFilterState,
  resolvedShopId: string,
): Promise<OrderRealtimeDto[]> {
  const query = buildModuleDashboardQuery('orders', filters, [], {
    resolvedShopId,
    extra: { limit: String(REALTIME_ORDERS_LIMIT) },
  })
  const j = await fetchRealtimeOrders(query)
  const list = extractOrdersFromDashboardPayload(j)
  const rows = list
    .map((row) => mapApiOrderRow(row))
    .filter((r) => r.platform_order_id)
    .slice(0, REALTIME_ORDERS_LIMIT)
  return rows
}

type RowViewProps = {
  row: OrderRealtimeDto
  entering: boolean
  multiLabel: string
  onShopClick: (row: OrderRealtimeDto) => void
  onMarketClick: (row: OrderRealtimeDto) => void
}

const RealtimeOrderRowView = memo(
  function RealtimeOrderRowView({ row, entering, multiLabel, onShopClick, onMarketClick }: RowViewProps) {
    const lvl = row.order_level || 'small'
    const mcolor = row.market_color || '#90A4AE'
    const cur = String(row.currency || 'USD').toUpperCase()
    const usdPending = Boolean(row.usd_pending)
    const usd = row.usd_amount != null && Number.isFinite(row.usd_amount) ? row.usd_amount : 0

    const rowClass = [
      'realtime-orders-grid',
      'realtime-order-row',
      entering ? 'realtime-order-row--enter' : '',
      row.is_large_order ? 'realtime-order-row--large-glow' : '',
      lvl === 'super' ? 'realtime-order-row--super-pulse' : '',
      `realtime-order-row--lvl-${lvl}`,
    ]
      .filter(Boolean)
      .join(' ')

    return (
      <div className={rowClass} role="row">
        <span className="realtime-orders-grid__cell realtime-orders-grid__cell--id" title={row.platform_order_id}>
          {row.platform_order_id || '—'}
        </span>
        <div className="realtime-orders-grid__cell realtime-orders-grid__cell--shop">
          <button
            type="button"
            className="realtime-order-shop-link"
            title={row.shop_name || '—'}
            disabled={row.shop_id == null}
            onClick={() => onShopClick(row)}
          >
            {row.shop_name || '—'}
          </button>
        </div>
        <div className="realtime-orders-grid__cell realtime-orders-grid__cell--market">
          <span className="realtime-order-tag-row">
            <button
              type="button"
              className="realtime-order-market-badge"
              style={{ borderColor: mcolor, color: mcolor, boxShadow: `0 0 10px ${mcolor}44` }}
              onClick={() => onMarketClick(row)}
            >
              {row.market || '—'}
            </button>
            {row.is_sample ? <span className="realtime-order-sample-tag">样品</span> : null}
          </span>
        </div>
        <div className="realtime-orders-grid__cell realtime-orders-grid__cell--num realtime-orders-grid__cell--items">
          <span className="realtime-order-items-wrap">
            <span>{row.items}</span>
            {row.is_multi_item ? <span className="realtime-order-multi">{multiLabel}</span> : null}
          </span>
        </div>
        <span className="realtime-orders-grid__cell realtime-orders-grid__cell--num">
          {formatMoneyByCurrency(cur, row.amount)}
        </span>
        <div className="realtime-orders-grid__cell realtime-orders-grid__cell--num realtime-orders-grid__cell--usd">
          {usdPending ? (
            <span className="realtime-order-usd realtime-order-usd--pending">汇率待确认</span>
          ) : (
            <span className="realtime-order-usd">{formatMoneyByCurrency('USD', usd)}</span>
          )}
        </div>
        <div className="realtime-orders-grid__cell realtime-orders-grid__cell--time">{formatOrderTimeHms(row.created_at_platform)}</div>
      </div>
    )
  },
  (a, b) =>
    a.row.platform_order_id === b.row.platform_order_id &&
    a.row.shop_id === b.row.shop_id &&
    a.row.shop_name === b.row.shop_name &&
    a.row.market === b.row.market &&
    a.row.currency === b.row.currency &&
    a.row.amount === b.row.amount &&
    a.row.created_at_platform === b.row.created_at_platform &&
    a.row.usd_amount === b.row.usd_amount &&
    a.row.items === b.row.items &&
    a.row.is_large_order === b.row.is_large_order &&
    a.row.is_multi_item === b.row.is_multi_item &&
    a.row.market_color === b.row.market_color &&
    a.row.order_level === b.row.order_level &&
    a.entering === b.entering,
)

export type RealtimeOrdersPanelProps = {
  title: string
  shop_id: string
  filters: DashboardFilterState
  onMarketFilter: (market: string) => void
  pollSuspendUntil?: number
}

export const RealtimeOrdersPanel = memo(function RealtimeOrdersPanel({
  title,
  shop_id,
  filters,
  onMarketFilter,
  pollSuspendUntil = 0,
}: RealtimeOrdersPanelProps) {
  const t = useT()
  const nav = useNavigate()
  const [rows, setRows] = useState<OrderRealtimeDto[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [enteringIds, setEnteringIds] = useState<Set<string>>(() => new Set())
  const rowsRef = useRef<OrderRealtimeDto[]>([])
  const scrollRef = useRef<HTMLDivElement>(null)
  const hoverPauseRef = useRef(false)
  const latestKeyRef = useRef('')
  const generationRef = useRef(0)
  const filtersRef = useRef(filters)
  const shopIdRef = useRef(shop_id)
  const responseGenerationRef = useRef(0)

  rowsRef.current = rows
  filtersRef.current = filters
  shopIdRef.current = shop_id

  const ordersCanonicalKey = useMemo(
    () => buildOrdersCanonicalKey(shop_id, filters),
    [shop_id, filters.marketRegion, filters.orderFilter, filters.timeRange, filters.customStart, filters.customEnd],
  )

  const onShopClick = useCallback(
    (row: OrderRealtimeDto) => {
      if (row.shop_id == null) return
      nav(`/analytics?shop_id=${encodeURIComponent(String(row.shop_id))}`)
    },
    [nav],
  )

  const onMarketClick = useCallback(
    (row: OrderRealtimeDto) => {
      const m = String(row.market || '').trim().toUpperCase()
      if (!m) return
      onMarketFilter(m)
    },
    [onMarketFilter],
  )

  const applyIncoming = useCallback((incoming: OrderRealtimeDto[]) => {
    const prev = rowsRef.current
    const { next, newIds } = mergeRealtimeOrderRows(prev, incoming)
    if (!newIds.length && sameRealtimeRows(prev, next)) return
    if (newIds.length && !hoverPauseRef.current) {
      const el = scrollRef.current
      if (el) el.scrollTo({ top: 0, behavior: 'smooth' })
    }
    if (newIds.length) {
      setEnteringIds((s) => {
        const x = new Set(s)
        for (const id of newIds) x.add(id)
        return x
      })
      window.setTimeout(() => {
        setEnteringIds((s) => {
          const x = new Set(s)
          for (const id of newIds) x.delete(id)
          return x
        })
      }, 520)
    }
    setRows(next)
  }, [])

  useEffect(() => {
    if (pollSuspendUntil > 0) mergeOrdersPollSuspendUntil(pollSuspendUntil)
  }, [pollSuspendUntil])

  useEffect(() => {
    const key = ordersCanonicalKey
    setRows([])
    setLoading(true)
    setErr(null)
    const hadRows = false
    const { key: requestKey, generation } = beginDashboardQuerySoft(latestKeyRef, generationRef, key)
    responseGenerationRef.current = generation
    setErr(null)
    if (!hadRows) setLoading(true)

    const unbind = bindOrdersPanel({
      filterKey: key,
      fetchFn: () => fetchDashboardRealtimeOrders(filtersRef.current, shopIdRef.current),
      onData: (incoming) => {
        if (!shouldApplyDashboardQueryGeneration(generationRef, generation, requestKey, 'orders')) return
        const prev = rowsRef.current
        const { next, newIds } = mergeRealtimeOrderRows(prev, incoming)
        const signatureChanged =
          next.length !== prev.length ||
          newIds.length > 0 ||
          (next[0]?.platform_order_id ?? '') !== (prev[0]?.platform_order_id ?? '')
        applyIncoming(incoming)
        setLoading(false)
        if (filtersRef.current.timeRange === 'today' && signatureChanged) {
          notifyDashboardOrdersMetricsChanged('orders-changed', key, {
            rowCount: next.length,
            orderIds: next.map((r) => r.platform_order_id),
            force: newIds.length > 0,
          })
        }
      },
      onError: (e) => {
        if (isAbortedFetchError(e)) return
        if (!shouldApplyDashboardQueryGeneration(generationRef, generation, requestKey, 'orders')) return
        setErr(String((e as Error)?.message || e))
        if (!rowsRef.current.length) setRows([])
        setLoading(false)
      },
    })

    return () => {
      unbind()
    }
  }, [ordersCanonicalKey, applyIncoming])

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const iv = window.setInterval(() => {
      if (hoverPauseRef.current) return
      if (el.scrollHeight <= el.clientHeight + 4) return
      el.scrollTop = Math.min(el.scrollTop + 0.9, el.scrollHeight - el.clientHeight)
    }, 140)
    return () => window.clearInterval(iv)
  }, [])

  return (
    <div className="tech-panel table-panel realtime-orders-panel legacy-realtime-orders">
      <h3 className="realtime-orders-panel-title">{title}</h3>
      {err ? <div className="warn-text realtime-orders-panel-err">{err}</div> : null}
      <div className="realtime-orders-table-region">
        <div
          className="realtime-orders-scroll"
          ref={scrollRef}
          onMouseEnter={() => {
            hoverPauseRef.current = true
          }}
          onMouseLeave={() => {
            hoverPauseRef.current = false
          }}
        >
          <div className="realtime-orders-grid-wrap">
            <div className="realtime-orders-grid realtime-orders-grid--header" role="row">
              <div className="realtime-orders-grid__cell realtime-orders-grid__cell--id" role="columnheader">
                {t('table.orderId')}
              </div>
              <div className="realtime-orders-grid__cell realtime-orders-grid__cell--shop" role="columnheader">
                {t('table.shopName')}
              </div>
              <div className="realtime-orders-grid__cell realtime-orders-grid__cell--market" role="columnheader">
                {t('table.market')}
              </div>
              <div
                className="realtime-orders-grid__cell realtime-orders-grid__cell--num realtime-orders-grid__cell--items"
                role="columnheader"
              >
                {t('table.qty')}
              </div>
              <div className="realtime-orders-grid__cell realtime-orders-grid__cell--num" role="columnheader">
                {t('table.originalCurrency')}
              </div>
              <div className="realtime-orders-grid__cell realtime-orders-grid__cell--num realtime-orders-grid__cell--usd" role="columnheader">
                USD
              </div>
              <div className="realtime-orders-grid__cell realtime-orders-grid__cell--time" role="columnheader">
                {t('table.time')}
              </div>
            </div>
            {loading && rows.length === 0 && !err ? (
              <div className="realtime-orders-grid realtime-orders-grid--empty" role="row">
                <div className="realtime-orders-grid__cell realtime-orders-grid__cell--empty-span">{t('common.loading')}</div>
              </div>
            ) : rows.length === 0 && !err ? (
              <div className="realtime-orders-grid realtime-orders-grid--empty" role="row">
                <div className="realtime-orders-grid__cell realtime-orders-grid__cell--empty-span">{t('orders.realtimeEmpty')}</div>
              </div>
            ) : (
              rows.map((row) => (
                <RealtimeOrderRowView
                  key={row.platform_order_id}
                  row={row}
                  entering={enteringIds.has(row.platform_order_id)}
                  multiLabel={t('orders.realtimeMulti')}
                  onShopClick={onShopClick}
                  onMarketClick={onMarketClick}
                />
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  )
})
