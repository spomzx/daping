import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { fetchWithAuth } from '../apiClient'
import { appendDashboardTimeQuery } from '../dashboardBounds'
import { formatMoneyByCurrency } from '../currencyDisplay'
import { useT, type TimeRangePreset } from '../i18n'

const REALTIME_ORDERS_LIMIT = 50

const MARKET_COLORS: Record<string, string> = {
  TH: '#00E5FF',
  MY: '#FFD54F',
  SG: '#81C784',
  PH: '#FF8A65',
  VN: '#BA68C8',
}

export type RealtimeOrderRow = {
  platform_order_id: string
  shop_id: number | null
  shop_name: string
  market: string
  currency?: string
  original_currency?: string
  original_amount?: number
  amount: number
  usd_amount?: number | null
  usd_pending?: boolean
  exchange_rate?: number | null
  cny_amount?: number
  items: number
  is_large_order?: boolean
  is_multi_item?: boolean
  market_color?: string
  order_level?: 'small' | 'medium' | 'large' | 'super'
  created_at_platform: string
}

function pad2(n: number) {
  return String(Math.floor(Math.max(0, n))).padStart(2, '0')
}

/** 展示为 HH:mm:ss（原字符串多为 MySQL datetime） */
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
  prev: RealtimeOrderRow[],
  incoming: RealtimeOrderRow[],
): { next: RealtimeOrderRow[]; newIds: string[] } {
  const prevSet = new Set(prev.map((r) => r.platform_order_id))
  const newIds = incoming.filter((r) => !prevSet.has(r.platform_order_id)).map((r) => r.platform_order_id)
  const seen = new Set<string>()
  const out: RealtimeOrderRow[] = []
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

function sameRealtimeRows(a: RealtimeOrderRow[], b: RealtimeOrderRow[]): boolean {
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

function orderLevelFromAmount(usd: number): RealtimeOrderRow['order_level'] {
  if (usd >= 500) return 'super'
  if (usd >= 200) return 'large'
  if (usd >= 80) return 'medium'
  return 'small'
}

function extractOrdersFromDashboardPayload(j: unknown): Record<string, unknown>[] {
  if (!j || typeof j !== 'object') return []
  const o = j as Record<string, unknown>
  if (Array.isArray(o.orders)) return o.orders as Record<string, unknown>[]
  if (Array.isArray(o.realtimeOrders)) return o.realtimeOrders as Record<string, unknown>[]
  if (Array.isArray(o.recentOrders)) return o.recentOrders as Record<string, unknown>[]
  if (Array.isArray(o.list)) return o.list as Record<string, unknown>[]
  return []
}

function mapDashboardOrderToRealtimeRow(o: Record<string, unknown>, idx: number): RealtimeOrderRow {
  const amount = Number(o.orderAmountBase ?? o.amount ?? 0)
  const usd = Number(o.usdAmount ?? o.usd_amount ?? 0)
  const itemsRaw = Number(o.itemCount ?? o.items ?? o.lineItemCount ?? 1)
  const items = Number.isFinite(itemsRaw) && itemsRaw > 0 ? itemsRaw : 1
  const market = String(o.region ?? o.market ?? '')
    .trim()
    .toUpperCase()
  const platformOrderId = String(o.orderId ?? o.id ?? `order-${idx}`).trim()
  return {
    platform_order_id: platformOrderId,
    shop_id: typeof o.shopMysqlId === 'number' ? o.shopMysqlId : null,
    shop_name: String(o.shopName ?? 'TikTok Shop'),
    market: market || '—',
    currency: String(o.currency ?? 'USD')
      .trim()
      .toUpperCase(),
    amount: Number.isFinite(amount) ? amount : 0,
    usd_amount: Number.isFinite(usd) ? usd : 0,
    original_amount: Number.isFinite(amount) ? amount : 0,
    original_currency: String(o.currency ?? o.original_currency ?? 'USD')
      .trim()
      .toUpperCase(),
    cny_amount: Number(o.cnyAmount ?? o.cny_amount ?? 0) || undefined,
    items,
    is_large_order: usd >= 200 || amount >= 200,
    is_multi_item: items > 1,
    market_color: MARKET_COLORS[market] || '#90A4AE',
    order_level: orderLevelFromAmount(usd > 0 ? usd : amount),
    created_at_platform: String(o.orderTime ?? o.paidTime ?? o.createTime ?? ''),
  }
}

export type DashboardRealtimeOrdersQuery = {
  shopId: string
  marketRegion: string
  orderFilter: string
  timeRange: TimeRangePreset
  customStart: string
  customEnd: string
  baseCurrency: string
  targetCurrency: string
}

/** 与 GMV 主接口同源：orders-cache + orderFilter + 时间范围（默认 today / all） */
async function fetchDashboardRealtimeOrders(q: DashboardRealtimeOrdersQuery): Promise<RealtimeOrderRow[]> {
  const region = q.marketRegion === 'all' ? 'all' : q.marketRegion.toUpperCase()
  const market = q.marketRegion === 'all' ? 'ALL' : q.marketRegion.toUpperCase()
  const params = new URLSearchParams({
    shopId: q.shopId || 'all',
    region,
    market,
    orderFilter: q.orderFilter || 'all',
    baseCurrency: q.baseCurrency,
    targetCurrency: q.targetCurrency,
  })
  appendDashboardTimeQuery(params, q.timeRange, q.customStart, q.customEnd)
  params.set('_t', String(Date.now()))
  const res = await fetchWithAuth(`/api/dashboard/orders?${params.toString()}`, { cache: 'no-store' })
  if (!res.ok) throw new Error(`dashboard-orders ${res.status}`)
  const j = await res.json()
  const list = extractOrdersFromDashboardPayload(j)
  if (list.length > 0 && list[0] && typeof list[0] === 'object' && 'platform_order_id' in list[0]) {
    return (list as Record<string, unknown>[])
      .map((row) => {
        const r = row as unknown as RealtimeOrderRow
        const pending = Boolean((r as { usd_pending?: boolean }).usd_pending)
        const usdRaw = r.usd_amount ?? (r as { usdAmount?: number }).usdAmount
        const usd = pending ? null : Number(usdRaw ?? 0)
        return {
          ...r,
          usd_pending: pending,
          usd_amount: usd != null && Number.isFinite(usd) ? usd : null,
          amount: Number(r.original_amount ?? r.amount ?? 0),
          currency: String(r.original_currency ?? r.currency ?? 'USD').toUpperCase(),
        }
      })
      .filter((r) => r.platform_order_id)
      .slice(0, REALTIME_ORDERS_LIMIT)
  }
  return list
    .map((row, i) => mapDashboardOrderToRealtimeRow(row, i))
    .filter((r) => r.platform_order_id)
    .slice(0, REALTIME_ORDERS_LIMIT)
}

type RowViewProps = {
  row: RealtimeOrderRow
  entering: boolean
  multiLabel: string
  onShopClick: (row: RealtimeOrderRow) => void
  onMarketClick: (row: RealtimeOrderRow) => void
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
        <div className="realtime-orders-grid__cell realtime-orders-grid__cell--id" title={row.platform_order_id}>
          {row.platform_order_id || '—'}
        </div>
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
          <button
            type="button"
            className="realtime-order-market-badge"
            style={{ borderColor: mcolor, color: mcolor, boxShadow: `0 0 10px ${mcolor}44` }}
            onClick={() => onMarketClick(row)}
          >
            {row.market || '—'}
          </button>
        </div>
        <div className="realtime-orders-grid__cell realtime-orders-grid__cell--num realtime-orders-grid__cell--items">
          <span className="realtime-order-items-wrap">
            <span>{row.items}</span>
            {row.is_multi_item ? <span className="realtime-order-multi">{multiLabel}</span> : null}
          </span>
        </div>
        <div className="realtime-orders-grid__cell realtime-orders-grid__cell--num">{formatMoneyByCurrency(cur, row.amount)}</div>
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
  /** 大屏市场筛选：'all' | 'TH' | 'MY' | … */
  marketRegion: string
  shopId: string
  orderFilter: string
  timeRange: TimeRangePreset
  customStart: string
  customEnd: string
  baseCurrency: string
  targetCurrency: string
  /** 主 GMV 请求已返回的订单（首屏即时展示） */
  seedOrders?: Array<Record<string, unknown>>
  onMarketFilter: (market: string) => void
  /** 轮询间隔（默认 12s，避免高频全表重绘） */
  pollMs?: number
}

export const RealtimeOrdersPanel = memo(function RealtimeOrdersPanel({
  title,
  marketRegion,
  shopId,
  orderFilter,
  timeRange,
  customStart,
  customEnd,
  baseCurrency,
  targetCurrency,
  seedOrders,
  onMarketFilter,
  pollMs = 12000,
}: RealtimeOrdersPanelProps) {
  const t = useT()
  const nav = useNavigate()
  const [rows, setRows] = useState<RealtimeOrderRow[]>([])
  const [err, setErr] = useState<string | null>(null)
  const [enteringIds, setEnteringIds] = useState<Set<string>>(() => new Set())
  const rowsRef = useRef<RealtimeOrderRow[]>([])
  const scrollRef = useRef<HTMLDivElement>(null)
  const hoverPauseRef = useRef(false)

  rowsRef.current = rows

  const dashboardQuery = useMemo(
    (): DashboardRealtimeOrdersQuery => ({
      shopId,
      marketRegion,
      orderFilter: orderFilter || 'all',
      timeRange,
      customStart,
      customEnd,
      baseCurrency,
      targetCurrency,
    }),
    [shopId, marketRegion, orderFilter, timeRange, customStart, customEnd, baseCurrency, targetCurrency],
  )

  const seedRows = useMemo(() => {
    if (!seedOrders?.length) return []
    return seedOrders
      .map((row, i) => mapDashboardOrderToRealtimeRow(row, i))
      .filter((r) => r.platform_order_id)
      .slice(0, REALTIME_ORDERS_LIMIT)
  }, [seedOrders])

  const onShopClick = useCallback(
    (row: RealtimeOrderRow) => {
      if (row.shop_id == null) return
      nav(`/analytics?shop_id=${encodeURIComponent(String(row.shop_id))}`)
    },
    [nav],
  )

  const onMarketClick = useCallback(
    (row: RealtimeOrderRow) => {
      const m = String(row.market || '').trim().toUpperCase()
      if (!m) return
      onMarketFilter(m)
    },
    [onMarketFilter],
  )

  const poll = useCallback(async () => {
    try {
      setErr(null)
      const incoming = await fetchDashboardRealtimeOrders(dashboardQuery)
      const prev = rowsRef.current
      const { next, newIds } = mergeRealtimeOrderRows(prev, incoming)
      if (!newIds.length && sameRealtimeRows(prev, next)) {
        return
      }
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
    } catch (e) {
      setErr(String((e as Error)?.message || e))
    }
  }, [dashboardQuery])

  useEffect(() => {
    setRows(seedRows.length ? seedRows : [])
    setEnteringIds(new Set())
    // 仅筛选变更时重置；避免父组件 GMV 刷新用无 USD 的 seed 覆盖轮询结果
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dashboardQuery])

  useEffect(() => {
    let alive = true
    const tick = async () => {
      if (!alive) return
      await poll()
    }
    void tick()
    const id = window.setInterval(() => void tick(), pollMs)
    return () => {
      alive = false
      window.clearInterval(id)
    }
  }, [poll, pollMs])

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
            <div className="realtime-orders-grid__cell realtime-orders-grid__cell--num realtime-orders-grid__cell--items" role="columnheader">
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
          {rows.length === 0 && !err ? (
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
