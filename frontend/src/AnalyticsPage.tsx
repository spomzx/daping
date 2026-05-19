import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { apiFetch } from './apiClient'
import { getAuthHeaders } from './authStorage'
import { DashboardShell } from './components/DashboardShell'
import { isPlatformScope, type MeRole, type UserScope } from './authRole'
import { useAppShellHeader } from './hooks/useAppShellHeader'
import { formatMoneyByCurrency } from './currencyDisplay'
import { GmvCompareTrendPanel, type GmvCompareStatusFilter } from './GmvCompareTrendPanel'
import { abbrevPlatformOrderId, analyticsMarketBadgeStyle } from './analyticsUi'
import { useT } from './i18n'
import { formatOrderTimeHms } from './components/RealtimeOrdersPanel'

/** 每页展示条数（与需求「30 条」一致） */
const ANALYTICS_LIST_PAGE_SIZE = 30

/**
 * 接口 limit：拉取上限以便前端 slice 分页（后端 top-products≤200，top-shops/recent≤100）
 * 查询参数仍传 limit=30 时无法分页，故这里取允许的最大值。
 */
const FETCH_LIMIT = {
  products: '200',
  shops: '100',
  recent: '100',
} as const

type ShopRow = {
  id?: number
  platform_shop_id?: string
  shop_name?: string
  market?: string
}

type TopProductRow = {
  product_name: string
  sku_name: string
  qty: number
  gmv: number
  gmv_currency?: string
  orders: number
  market: string
  shop_name: string
}

type TopShopRow = {
  shop_id?: number
  shop_name?: string
  market?: string
  gmv: number
  orders: number
  items: number
}

type OrderStatusFilter = GmvCompareStatusFilter

type RecentOrderRow = {
  platform_order_id: string
  shop_id?: number | null
  shop_name: string
  market: string
  currency?: string
  amount: number
  usd_amount?: number
  cny_amount?: number
  items: number
  is_large_order?: boolean
  is_multi_item?: boolean
  market_color?: string
  order_level?: 'small' | 'medium' | 'large' | 'super'
  created_at_platform: string
}

type SearchSkuRow = {
  sku_id: string
  product_id: string
  sku_name: string
  product_name: string
  quantity: number
  total_amount: number
  market: string
  shop_name: string
  platform_order_id: string
}

const MARKETS = ['ALL', 'TH', 'MY', 'SG', 'PH', 'VN'] as const

function rangeToHours(preset: string): number {
  if (preset === '7d') return 168
  if (preset === '30d') return 720
  return 24
}

async function fetchJson<T>(
  path: string,
  query: Record<string, string | undefined>,
  opts?: { signal?: AbortSignal },
): Promise<T> {
  const qs = new URLSearchParams()
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== '') qs.set(k, v)
  }
  const res = await apiFetch(`${path}?${qs}`, {
    headers: { ...getAuthHeaders() },
    cache: 'no-store',
    signal: opts?.signal,
  })
  if (!res.ok) throw new Error(`${path} ${res.status}`)
  return res.json() as Promise<T>
}

function rankMedalClass(rank: number): string {
  if (rank === 1) return 'analytics-rank-badge analytics-rank-badge--1'
  if (rank === 2) return 'analytics-rank-badge analytics-rank-badge--2'
  if (rank === 3) return 'analytics-rank-badge analytics-rank-badge--3'
  return 'analytics-rank-badge analytics-rank-badge--n'
}

function totalPages(totalItems: number, pageSize: number): number {
  return Math.max(1, Math.ceil(Math.max(0, totalItems) / pageSize))
}

type ProductSortKey = 'qty' | 'gmv' | 'orders'
type ShopSortKey = 'gmv' | 'orders' | 'items'

const AnalyticsSeg = memo(function AnalyticsSeg({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: string
  options: { value: string; label: string }[]
  onChange: (v: string) => void
}) {
  return (
    <div className="analytics-inline-seg" role="group" aria-label={label}>
      <span className="analytics-inline-seg__label">{label}</span>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          className={`analytics-inline-seg__btn${value === o.value ? ' analytics-inline-seg__btn--active' : ''}`}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
})

const AnalyticsPager = memo(function AnalyticsPager({
  page,
  totalItems,
  pageSize,
  onPage,
}: {
  page: number
  totalItems: number
  pageSize: number
  onPage: (p: number) => void
}) {
  const t = useT()
  const tp = totalPages(totalItems, pageSize)
  const prev = () => onPage(Math.max(1, page - 1))
  const next = () => onPage(Math.min(tp, page + 1))
  return (
    <div className="analytics-pager" role="navigation" aria-label={t('analytics.pagerAria')}>
      <button type="button" className="analytics-pager-btn" disabled={page <= 1} onClick={prev}>
        {t('analytics.pagerPrev')}
      </button>
      <span className="analytics-pager-status">
        {page} / {tp}
      </span>
      <button type="button" className="analytics-pager-btn" disabled={page >= tp} onClick={next}>
        {t('analytics.pagerNext')}
      </button>
    </div>
  )
})

const AnalyticsProductsSection = memo(function AnalyticsProductsSection({
  rows,
  rankOffset,
  page,
  totalItems,
  onPage,
  sortProducts,
  onSortProductsChange,
  busy,
  emptyLabel,
}: {
  rows: TopProductRow[]
  rankOffset: number
  page: number
  totalItems: number
  onPage: (p: number) => void
  sortProducts: ProductSortKey
  onSortProductsChange: (v: ProductSortKey) => void
  busy?: boolean
  emptyLabel?: string
}) {
  const t = useT()
  const empty = emptyLabel ?? t('empty.noData')
  return (
    <section
      className={`tech-panel table-panel analytics-card analytics-card--products analytics-table-card-h${busy ? ' analytics-card--module-busy' : ''}`}
    >
      <div className="analytics-card-title-row">
        <h3 className="analytics-card-title">{t('analytics.productsTitle')}</h3>
        <AnalyticsSeg
          label={t('analytics.sort')}
          value={sortProducts}
          options={[
            { value: 'qty', label: t('analytics.sortQty') },
            { value: 'gmv', label: t('analytics.sortGmv') },
            { value: 'orders', label: t('analytics.sortOrders') },
          ]}
          onChange={(v) => onSortProductsChange(v as ProductSortKey)}
        />
      </div>
      <div className="analytics-card-stack">
        <div className="analytics-table-scroll-y">
          <table className="analytics-table analytics-table--products">
            <thead>
              <tr>
                <th className="analytics-th-rank">#</th>
                <th>{t('analytics.productSkuCol')}</th>
                <th className="num">{t('table.salesQty')}</th>
                <th className="num">{t('analytics.gmvUsdCol')}</th>
                <th className="num">{t('analytics.sortOrders')}</th>
                <th className="analytics-th-market">{t('table.market')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={6} className="analytics-empty-cell">
                    {empty}
                  </td>
                </tr>
              ) : (
                rows.map((r, i) => {
                  const rank = rankOffset + i + 1
                  const m = String(r.market || '').trim().toUpperCase()
                  return (
                    <tr key={`${page}-${rank}-${r.product_name}-${r.sku_name}`} className="analytics-tr-fixed">
                      <td className="analytics-td-rank">
                        <span className={rankMedalClass(rank)}>{rank}</span>
                      </td>
                      <td className="analytics-td-product">
                        <div className="analytics-product-name" title={r.product_name || ''}>
                          {r.product_name || '—'}
                        </div>
                        <div className="analytics-sku-sub" title={r.sku_name || ''}>
                          {r.sku_name || '—'}
                        </div>
                      </td>
                      <td className="num analytics-td-num">{r.qty}</td>
                      <td className="num analytics-td-num">{formatMoneyByCurrency('USD', r.gmv)}</td>
                      <td className="num analytics-td-num">{r.orders}</td>
                      <td className="analytics-td-market">
                        {m ? (
                          <span className="analytics-market-pill" style={analyticsMarketBadgeStyle(m)}>
                            {m}
                          </span>
                        ) : (
                          '—'
                        )}
                      </td>
                    </tr>
                  )
                })
              )}
            </tbody>
          </table>
        </div>
        {totalItems > 0 ? (
          <AnalyticsPager page={page} totalItems={totalItems} pageSize={ANALYTICS_LIST_PAGE_SIZE} onPage={onPage} />
        ) : null}
      </div>
    </section>
  )
})

const AnalyticsShopsSection = memo(function AnalyticsShopsSection({
  rows,
  rankOffset,
  page,
  totalItems,
  onPage,
  sortShops,
  onSortShopsChange,
  busy,
  emptyLabel,
}: {
  rows: TopShopRow[]
  rankOffset: number
  page: number
  totalItems: number
  onPage: (p: number) => void
  sortShops: ShopSortKey
  onSortShopsChange: (v: ShopSortKey) => void
  busy?: boolean
  emptyLabel?: string
}) {
  const t = useT()
  const showPager = totalItems > ANALYTICS_LIST_PAGE_SIZE
  const empty = emptyLabel ?? t('empty.noData')
  return (
    <section
      className={`tech-panel table-panel analytics-card analytics-card--shops analytics-table-card-h${busy ? ' analytics-card--module-busy' : ''}`}
    >
      <div className="analytics-card-title-row">
        <h3 className="analytics-card-title">{t('analytics.shopsTitle')}</h3>
        <AnalyticsSeg
          label={t('analytics.sort')}
          value={sortShops}
          options={[
            { value: 'gmv', label: 'GMV' },
            { value: 'orders', label: t('analytics.sortOrder') },
            { value: 'items', label: t('analytics.sortItems') },
          ]}
          onChange={(v) => onSortShopsChange(v as ShopSortKey)}
        />
      </div>
      <div className="analytics-card-stack">
        <div className="analytics-table-scroll-y">
          <table className="analytics-table analytics-table--shops">
            <thead>
              <tr>
                <th className="analytics-th-rank">#</th>
                <th>{t('table.shopName')}</th>
                <th className="analytics-th-market">{t('table.market')}</th>
                <th className="num">{t('analytics.gmvUsdCol')}</th>
                <th className="num">{t('analytics.sortOrder')}</th>
                <th className="num">{t('analytics.sortItems')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={6} className="analytics-empty-cell">
                    {empty}
                  </td>
                </tr>
              ) : (
                rows.map((r, i) => {
                  const rank = rankOffset + i + 1
                  const m = String(r.market || '').trim().toUpperCase()
                  return (
                    <tr key={`${page}-${rank}-${r.shop_id ?? i}`} className="analytics-tr-fixed">
                      <td className="analytics-td-rank">
                        <span className={rankMedalClass(rank)}>{rank}</span>
                      </td>
                      <td className="analytics-td-shop">
                        <span className="analytics-shop-ellipsis" title={r.shop_name || ''}>
                          {r.shop_name || '—'}
                        </span>
                      </td>
                      <td className="analytics-td-market">
                        {m ? (
                          <span className="analytics-market-pill" style={analyticsMarketBadgeStyle(m)}>
                            {m}
                          </span>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td className="num analytics-td-num analytics-td-gmv">{formatMoneyByCurrency('USD', r.gmv)}</td>
                      <td className="num analytics-td-num">{r.orders}</td>
                      <td className="num analytics-td-num">{r.items}</td>
                    </tr>
                  )
                })
              )}
            </tbody>
          </table>
        </div>
        {totalItems === 0 ? null : showPager ? (
          <AnalyticsPager page={page} totalItems={totalItems} pageSize={ANALYTICS_LIST_PAGE_SIZE} onPage={onPage} />
        ) : (
          <div className="analytics-pager analytics-pager--layout-only" aria-hidden>
            <button type="button" className="analytics-pager-btn" tabIndex={-1} disabled>
              {t('analytics.pagerPrev')}
            </button>
            <span className="analytics-pager-status">&nbsp;</span>
            <button type="button" className="analytics-pager-btn" tabIndex={-1} disabled>
              {t('analytics.pagerNext')}
            </button>
          </div>
        )}
      </div>
    </section>
  )
})

const AnalyticsRecentOrdersSection = memo(function AnalyticsRecentOrdersSection({
  rows,
  page,
  totalItems,
  onPage,
  emptyLabel,
}: {
  rows: RecentOrderRow[]
  page: number
  totalItems: number
  onPage: (p: number) => void
  emptyLabel?: string
}) {
  const t = useT()
  const empty = emptyLabel ?? t('empty.noData')
  return (
    <section className="tech-panel table-panel analytics-card analytics-card--recent analytics-table-card-h">
      <h3 className="analytics-card-title">{t('analytics.recentOrdersTitle')}</h3>
      <div className="analytics-card-stack">
        <div className="analytics-recent-card-inner">
          <div className="analytics-recent-grid analytics-recent-grid--head" role="row">
            <div className="analytics-recent-cell" role="columnheader">
              {t('table.orderId')}
            </div>
            <div className="analytics-recent-cell" role="columnheader">
              {t('table.shopName')}
            </div>
            <div className="analytics-recent-cell analytics-recent-cell--market" role="columnheader">
              {t('table.market')}
            </div>
            <div className="analytics-recent-cell analytics-recent-cell--stack" role="columnheader">
              {t('analytics.amountCol')}
            </div>
            <div className="analytics-recent-cell analytics-recent-cell--num" role="columnheader">
              {t('table.qty')}
            </div>
            <div className="analytics-recent-cell analytics-recent-cell--time" role="columnheader">
              {t('table.time')}
            </div>
          </div>
          <div className="analytics-recent-rows-scroll">
            <div className="analytics-recent-grid-wrap">
            {rows.length === 0 ? (
              <div className="analytics-recent-grid analytics-recent-grid--empty" role="row">
                <div className="analytics-recent-cell analytics-recent-cell--empty-span">{empty}</div>
              </div>
            ) : (
              rows.map((r) => {
                const cur = String(r.currency || 'USD').toUpperCase()
                const usd = r.usd_amount != null && Number.isFinite(r.usd_amount) ? r.usd_amount : null
                const m = String(r.market || '').trim().toUpperCase()
                const rowCls = [
                  'analytics-recent-grid',
                  'analytics-recent-row',
                  r.is_large_order ? 'analytics-recent-row--large' : '',
                ]
                  .filter(Boolean)
                  .join(' ')
                return (
                  <div className={rowCls} key={r.platform_order_id} role="row">
                    <div className="analytics-recent-cell analytics-recent-cell--id" title={r.platform_order_id}>
                      {abbrevPlatformOrderId(r.platform_order_id)}
                    </div>
                    <div className="analytics-recent-cell analytics-recent-cell--shop">
                      <span className="analytics-shop-ellipsis" title={r.shop_name || ''}>
                        {r.shop_name || '—'}
                      </span>
                    </div>
                    <div className="analytics-recent-cell analytics-recent-cell--market">
                      {m ? (
                        <span className="analytics-market-pill analytics-market-pill--static" style={analyticsMarketBadgeStyle(m)}>
                          {m}
                        </span>
                      ) : (
                        '—'
                      )}
                    </div>
                    <div className="analytics-recent-cell analytics-recent-cell--stack">
                      <div className="analytics-amt-native">{formatMoneyByCurrency(cur, r.amount)}</div>
                      <div className="analytics-amt-usd">{usd != null ? formatMoneyByCurrency('USD', usd) : '—'}</div>
                    </div>
                    <div className="analytics-recent-cell analytics-recent-cell--num">
                      <span className="analytics-items-inline">
                        <span>{r.items}</span>
                        {r.is_multi_item ? <span className="analytics-multi-tag">{t('orders.realtimeMulti')}</span> : null}
                      </span>
                    </div>
                    <div className="analytics-recent-cell analytics-recent-cell--time">{formatOrderTimeHms(r.created_at_platform)}</div>
                  </div>
                )
              })
            )}
            </div>
          </div>
        </div>
        {totalItems > 0 ? (
          <AnalyticsPager page={page} totalItems={totalItems} pageSize={ANALYTICS_LIST_PAGE_SIZE} onPage={onPage} />
        ) : null}
      </div>
    </section>
  )
})

const AnalyticsSearchSection = memo(function AnalyticsSearchSection({
  searchRows,
}: {
  searchRows: SearchSkuRow[]
}) {
  const t = useT()
  if (searchRows.length === 0) return null
  return (
    <div className="tech-panel analytics-card analytics-search-panel">
      <h4 className="analytics-search-title">{t('analytics.searchResultsTitle')}</h4>
      <div className="analytics-table-wrap">
        <table className="analytics-table analytics-table--search">
          <thead>
            <tr>
              <th>{t('analytics.searchSkuCol')}</th>
              <th>{t('table.product')}</th>
              <th className="num">{t('table.qty')}</th>
              <th>{t('analytics.searchOrderCol')}</th>
            </tr>
          </thead>
          <tbody>
            {searchRows.slice(0, 15).map((r) => (
              <tr key={`${r.platform_order_id}-${r.sku_id}-${r.product_id}`}>
                <td>{r.sku_name}</td>
                <td className="analytics-td-product">
                  <div className="analytics-product-name analytics-product-name--1l">{r.product_name}</div>
                </td>
                <td className="num analytics-td-num">{r.quantity}</td>
                <td className="analytics-td-mono">{r.platform_order_id}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
})

export function AnalyticsPage({
  appUsername,
  appRole,
  appUserScope = 'tenant',
  onLogout,
  saasMode = false,
}: {
  appUsername: string
  appRole: MeRole
  appUserScope?: UserScope
  onLogout: () => void
  /** 嵌入 SaasLayout 时不渲染 DashboardHeader 顶栏 */
  saasMode?: boolean
}) {
  const t = useT()
  const nav = useNavigate()
  const platformScope = isPlatformScope({ scope: appUserScope, role: appRole })
  const { nowText, shopSummary, summaryError, fetchShopSummary, authConnected } = useAppShellHeader()
  const [searchParams] = useSearchParams()
  const [shops, setShops] = useState<ShopRow[]>([])
  const [market, setMarket] = useState<string>('ALL')
  const [shopId, setShopId] = useState<string>('all')
  const [rangePreset, setRangePreset] = useState<'24h' | '7d' | '30d'>('24h')
  const [sortProducts, setSortProducts] = useState<ProductSortKey>('qty')
  const [sortShops, setSortShops] = useState<ShopSortKey>('gmv')
  const [groupBy, setGroupBy] = useState<'hour' | 'day'>('hour')
  const [status, setStatus] = useState<OrderStatusFilter>('all')
  const [debouncedStatus, setDebouncedStatus] = useState<OrderStatusFilter>('all')

  const [topProducts, setTopProducts] = useState<TopProductRow[]>([])
  const [topShops, setTopShops] = useState<TopShopRow[]>([])
  const [recentOrders, setRecentOrders] = useState<RecentOrderRow[]>([])
  const [productPage, setProductPage] = useState(1)
  const [shopPage, setShopPage] = useState(1)
  const [orderPage, setOrderPage] = useState(1)

  const [searchQ, setSearchQ] = useState('')
  const [searchRows, setSearchRows] = useState<SearchSkuRow[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [productsBusy, setProductsBusy] = useState(false)
  const [shopsBusy, setShopsBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const loadedOnceRef = useRef(false)
  const analyticsListAbortRef = useRef<AbortController | null>(null)
  const listFilterKeyRef = useRef<string>('')

  const sortProductsRef = useRef(sortProducts)
  const sortShopsRef = useRef(sortShops)
  sortProductsRef.current = sortProducts
  sortShopsRef.current = sortShops

  const fetchTopProductsRef = useRef<() => Promise<TopProductRow[]>>(async () => [])
  const fetchTopShopsRef = useRef<() => Promise<TopShopRow[]>>(async () => [])

  const hours = useMemo(() => rangeToHours(rangePreset), [rangePreset])
  const listFilterKey = useMemo(
    () => `${market}|${shopId}|${rangePreset}|${hours}`,
    [market, shopId, rangePreset, hours],
  )
  const analyticsListEmptyLabel = useMemo(
    () => (debouncedStatus === 'sample' ? t('empty.sampleOrders') : t('empty.noData')),
    [debouncedStatus, t],
  )

  useEffect(() => {
    const t = window.setTimeout(() => setDebouncedStatus(status), 150)
    return () => window.clearTimeout(t)
  }, [status])

  useEffect(() => {
    const sid = searchParams.get('shop_id')
    if (sid != null && String(sid).trim() !== '') {
      setShopId(String(sid).trim())
    }
  }, [searchParams])

  useEffect(() => {
    let alive = true
    apiFetch('/api/shops', { headers: { ...getAuthHeaders() } })
      .then((r) => r.json())
      .then((j) => {
        if (!alive) return
        setShops(Array.isArray(j?.shops) ? j.shops : [])
      })
      .catch(() => {
        if (alive) setShops([])
      })
    return () => {
      alive = false
    }
  }, [])

  const shopQueryParam = shopId === 'all' ? undefined : shopId

  useEffect(() => {
    document.documentElement.classList.add('analytics-route')
    return () => {
      document.documentElement.classList.remove('analytics-route')
    }
  }, [])

  const fetchTopProducts = useCallback(
    async (signal?: AbortSignal): Promise<TopProductRow[]> => {
      const mkt = market === 'ALL' ? undefined : market
      const tp = await fetchJson<TopProductRow[]>(
        '/api/analytics/top-products',
        {
          market: mkt,
          shop_id: shopQueryParam,
          hours: String(hours),
          limit: FETCH_LIMIT.products,
          sort: sortProductsRef.current,
          status: debouncedStatus,
        },
        { signal },
      )
      return Array.isArray(tp) ? tp : []
    },
    [hours, market, shopQueryParam, debouncedStatus],
  )

  const fetchTopShops = useCallback(
    async (signal?: AbortSignal): Promise<TopShopRow[]> => {
      const mkt = market === 'ALL' ? undefined : market
      const ts = await fetchJson<TopShopRow[]>(
        '/api/analytics/top-shops',
        {
          range: rangePreset === '24h' ? '24h' : rangePreset === '7d' ? '7d' : '30d',
          sort: sortShopsRef.current,
          limit: FETCH_LIMIT.shops,
          market: mkt,
          shop_id: shopQueryParam,
          hours: String(hours),
          status: debouncedStatus,
        },
        { signal },
      )
      return Array.isArray(ts) ? ts : []
    },
    [hours, market, rangePreset, shopQueryParam, debouncedStatus],
  )

  const fetchRecentOrders = useCallback(
    async (signal?: AbortSignal): Promise<RecentOrderRow[]> => {
      const mkt = market === 'ALL' ? undefined : market
      const ro = await fetchJson<RecentOrderRow[]>(
        '/api/analytics/recent-orders',
        {
          market: mkt,
          shop_id: shopQueryParam,
          hours: String(hours),
          limit: FETCH_LIMIT.recent,
          status: debouncedStatus,
        },
        { signal },
      )
      return Array.isArray(ro) ? ro : []
    },
    [hours, market, shopQueryParam, debouncedStatus],
  )

  useEffect(() => {
    fetchTopProductsRef.current = fetchTopProducts
  }, [fetchTopProducts])

  useEffect(() => {
    fetchTopShopsRef.current = fetchTopShops
  }, [fetchTopShops])

  const loadAllFromGlobalFilters = useCallback(async () => {
    analyticsListAbortRef.current?.abort()
    const ac = new AbortController()
    analyticsListAbortRef.current = ac
    const signal = ac.signal

    const initial = !loadedOnceRef.current
    if (initial) setLoading(true)
    else setRefreshing(true)
    setErr(null)
    try {
      const [tp, ts, ro] = await Promise.all([
        fetchTopProducts(signal),
        fetchTopShops(signal),
        fetchRecentOrders(signal),
      ])
      if (signal.aborted) return
      setTopProducts(tp)
      setTopShops(ts)
      setRecentOrders(ro)
      void fetchShopSummary()
      if (listFilterKeyRef.current !== listFilterKey) {
        listFilterKeyRef.current = listFilterKey
        setProductPage(1)
        setShopPage(1)
        setOrderPage(1)
      }
    } catch (e) {
      const name = (e as Error)?.name || (e as DOMException)?.name
      if (name === 'AbortError') return
      setErr(String((e as Error)?.message || e))
    } finally {
      setLoading(false)
      setRefreshing(false)
      if (!signal.aborted) {
        loadedOnceRef.current = true
      }
    }
  }, [fetchTopProducts, fetchTopShops, fetchRecentOrders, listFilterKey, fetchShopSummary])

  useEffect(() => {
    void loadAllFromGlobalFilters()
  }, [loadAllFromGlobalFilters])

  useEffect(() => {
    return () => {
      analyticsListAbortRef.current?.abort()
    }
  }, [])

  /** 开发环境：选择「样品」时拉取各状态计数，便于与 MySQL 口径对照（生产可忽略） */
  useEffect(() => {
    if (!import.meta.env.DEV || debouncedStatus !== 'sample' || loading || refreshing) return
    const qs = new URLSearchParams()
    if (market !== 'ALL') qs.set('market', market)
    if (shopQueryParam) qs.set('shop_id', shopQueryParam)
    qs.set('range', rangePreset === '24h' ? '24h' : rangePreset === '7d' ? '7d' : '30d')
    void apiFetch(`/api/analytics/status-debug?${qs}`, { headers: { ...getAuthHeaders() }, cache: 'no-store' })
      .then((r) => r.json())
      .then((j) => console.log('[analytics-status-debug]', j))
      .catch(() => {})
  }, [debouncedStatus, market, shopQueryParam, rangePreset, loading, refreshing])

  const skipInitialProductSortRef = useRef(true)
  useEffect(() => {
    if (skipInitialProductSortRef.current) {
      skipInitialProductSortRef.current = false
      return
    }
    let cancelled = false
    void (async () => {
      setProductsBusy(true)
      setErr(null)
      try {
        const tp = await fetchTopProductsRef.current()
        if (!cancelled) {
          setTopProducts(tp)
          setProductPage(1)
        }
      } catch (e) {
        if (!cancelled) setErr(String((e as Error)?.message || e))
      } finally {
        if (!cancelled) setProductsBusy(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [sortProducts])

  const skipInitialShopSortRef = useRef(true)
  useEffect(() => {
    if (skipInitialShopSortRef.current) {
      skipInitialShopSortRef.current = false
      return
    }
    let cancelled = false
    void (async () => {
      setShopsBusy(true)
      setErr(null)
      try {
        const ts = await fetchTopShopsRef.current()
        if (!cancelled) {
          setTopShops(ts)
          setShopPage(1)
        }
      } catch (e) {
        if (!cancelled) setErr(String((e as Error)?.message || e))
      } finally {
        if (!cancelled) setShopsBusy(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [sortShops])

  useEffect(() => {
    if (hours > 168 && groupBy === 'hour') setGroupBy('day')
  }, [hours, groupBy])

  const runSearch = useCallback(async () => {
    const q = searchQ.trim()
    if (!q) {
      setSearchRows([])
      return
    }
    try {
      const rows = await fetchJson<SearchSkuRow[]>('/api/analytics/search-sku', {
        sku: q,
        product_name: q,
        limit: '40',
      })
      setSearchRows(rows)
    } catch {
      setSearchRows([])
    }
  }, [searchQ])

  const productSlice = useMemo(() => {
    const start = (productPage - 1) * ANALYTICS_LIST_PAGE_SIZE
    return topProducts.slice(start, start + ANALYTICS_LIST_PAGE_SIZE)
  }, [topProducts, productPage])

  const shopSlice = useMemo(() => {
    const start = (shopPage - 1) * ANALYTICS_LIST_PAGE_SIZE
    return topShops.slice(start, start + ANALYTICS_LIST_PAGE_SIZE)
  }, [topShops, shopPage])

  const orderSlice = useMemo(() => {
    const start = (orderPage - 1) * ANALYTICS_LIST_PAGE_SIZE
    return recentOrders.slice(start, start + ANALYTICS_LIST_PAGE_SIZE)
  }, [recentOrders, orderPage])

  useEffect(() => {
    const tp = totalPages(topProducts.length, ANALYTICS_LIST_PAGE_SIZE)
    if (productPage > tp) setProductPage(tp)
  }, [topProducts.length, productPage])

  useEffect(() => {
    const tp = totalPages(topShops.length, ANALYTICS_LIST_PAGE_SIZE)
    if (shopPage > tp) setShopPage(tp)
  }, [topShops.length, shopPage])

  useEffect(() => {
    const tp = totalPages(recentOrders.length, ANALYTICS_LIST_PAGE_SIZE)
    if (orderPage > tp) setOrderPage(tp)
  }, [recentOrders.length, orderPage])

  const productRankOffset = (productPage - 1) * ANALYTICS_LIST_PAGE_SIZE
  const shopRankOffset = (shopPage - 1) * ANALYTICS_LIST_PAGE_SIZE

  const showBlockingLoader = loading && !topProducts.length && !recentOrders.length && !err
  const showListRefreshOverlay = !loading && refreshing
  const listOrderCount = recentOrders.length

  const metaSlot = summaryError ? (
    <p className="warn-text">{t('analytics.summaryApiError')}</p>
  ) : err ? (
    <p className="warn-text">{t('analytics.dataApiError', { detail: err })}</p>
  ) : (
    <div className="debug-meta-hint">
      {t('analytics.metaLine', {
        orders: listOrderCount,
        shops: shopSummary.totalAuthorized,
        hours,
        range: rangePreset,
      })}
      <span className="analytics-meta-note"> · {t('analytics.dataSource')}</span>
    </div>
  )

  const pageContent = (
      <div className="analytics-page analytics-page-root">
      <div className="tech-panel filter-panel analytics-page__filters">
        <div className="analytics-filter-grid">
          <label className="analytics-filter-item">
            <span className="filter-cluster-title">{t('analytics.filterMarket')}</span>
            <select value={market} onChange={(e) => setMarket(e.target.value)} className="locale-select analytics-uni-select">
              {MARKETS.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </label>
          <label className="analytics-filter-item">
            <span className="filter-cluster-title">{t('analytics.filterShop')}</span>
            <select value={shopId} onChange={(e) => setShopId(e.target.value)} className="locale-select analytics-uni-select">
              <option value="all">{t('analytics.all')}</option>
              {shops.map((s) => (
                <option key={String(s.id ?? s.platform_shop_id)} value={String(s.id ?? s.platform_shop_id ?? '')}>
                  {s.shop_name || s.platform_shop_id || s.id}
                </option>
              ))}
            </select>
          </label>
          <label className="analytics-filter-item">
            <span className="filter-cluster-title">{t('analytics.filterTimeRange')}</span>
            <select
              value={rangePreset}
              onChange={(e) => setRangePreset(e.target.value as '24h' | '7d' | '30d')}
              className="locale-select analytics-uni-select"
            >
              <option value="24h">{t('analytics.range24h')}</option>
              <option value="7d">{t('analytics.range7d')}</option>
              <option value="30d">{t('analytics.range30d')}</option>
            </select>
          </label>
          <label className="analytics-filter-item">
            <span className="filter-cluster-title">{t('analytics.filterOrderStatus')}</span>
            <select
              value={status}
              onChange={(e) => setStatus(e.target.value as OrderStatusFilter)}
              className="locale-select analytics-uni-select"
            >
              <option value="all">{t('filter.order.all')}</option>
              <option value="valid">{t('filter.order.validShort')}</option>
              <option value="unpaid">{t('filter.order.unpaid')}</option>
              <option value="sample">{t('filter.order.sample')}</option>
              <option value="cancelled">{t('filter.order.cancelledShort')}</option>
            </select>
          </label>
          <div className="analytics-filter-item analytics-filter-item--action">
            <span className="filter-cluster-title analytics-filter-spacer" aria-hidden>
              {'\u00a0'}
            </span>
            <button
              type="button"
              className="refresh-btn analytics-refresh-btn"
              disabled={refreshing}
              onClick={() => void loadAllFromGlobalFilters()}
            >
              {refreshing ? t('common.refreshing') : t('btn.refresh')}
            </button>
          </div>
        </div>
        <div className="analytics-search-row">
          <input
            type="search"
            placeholder={t('analytics.searchPlaceholder')}
            value={searchQ}
            onChange={(e) => setSearchQ(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void runSearch()}
            className="analytics-search-input"
          />
          <button type="button" className="refresh-btn analytics-search-btn" onClick={() => void runSearch()}>
            {t('analytics.searchBtn')}
          </button>
        </div>
      </div>

      {err ? <div className="warn-text analytics-page-err">{err}</div> : null}
      {showBlockingLoader ? <div className="analytics-page-loading">{t('common.loading')}</div> : null}

      <div className="analytics-page-content">
        {showListRefreshOverlay ? (
          <div className="analytics-data-refresh-overlay" aria-busy="true" aria-live="polite">
            <span className="analytics-data-refresh-overlay__text">{t('common.loading')}</span>
          </div>
        ) : null}
        <main className="analytics-main-grid">
          <div className="analytics-main-col analytics-main-col--products">
            <AnalyticsProductsSection
              rows={productSlice}
              rankOffset={productRankOffset}
              page={productPage}
              totalItems={topProducts.length}
              onPage={setProductPage}
              sortProducts={sortProducts}
              onSortProductsChange={setSortProducts}
              busy={productsBusy}
              emptyLabel={analyticsListEmptyLabel}
            />
          </div>
          <div className="analytics-main-col analytics-main-col--shops">
            <AnalyticsShopsSection
              rows={shopSlice}
              rankOffset={shopRankOffset}
              page={shopPage}
              totalItems={topShops.length}
              onPage={setShopPage}
              sortShops={sortShops}
              onSortShopsChange={setSortShops}
              busy={shopsBusy}
              emptyLabel={analyticsListEmptyLabel}
            />
          </div>
          <div className="analytics-main-col analytics-main-col--recent">
            <AnalyticsRecentOrdersSection
              rows={orderSlice}
              page={orderPage}
              totalItems={recentOrders.length}
              onPage={setOrderPage}
              emptyLabel={analyticsListEmptyLabel}
            />
          </div>
        </main>

        <AnalyticsSearchSection searchRows={searchRows} />

        <section className="tech-panel chart-panel analytics-trend-block analytics-card analytics-card--trend">
          <GmvCompareTrendPanel
            market={market}
            shopId={shopId}
            status={debouncedStatus}
            hours={hours}
            groupBy={groupBy}
            showGranularityControl
            onGroupByChange={setGroupBy}
            emptyTrendLabel={debouncedStatus === 'sample' ? t('empty.sampleOrders') : undefined}
          />
        </section>
      </div>
      </div>
  )

  if (saasMode) {
    return (
      <div className="war-room analytics-saas-embed dashboard-shell app-shell-page--analytics">
        <div className="analytics-saas-meta">{metaSlot}</div>
        <main className="dashboard-main app-shell-main analytics-page-main">
          <section className="tech-panel analytics-page-card">{pageContent}</section>
        </main>
      </div>
    )
  }

  return (
    <DashboardShell
      pageContext="analytics"
      appRole={appRole}
      appUserScope={appUserScope}
      appUsername={appUsername}
      appAccess="full"
      platformScope={platformScope}
      authConnected={authConnected}
      shopSummary={shopSummary}
      activeShopCount={shopSummary.todayOrderShopCount}
      nowText={nowText}
      marketStatsTimezoneHeadline={t('meta.timezoneHint')}
      displayBase="USD"
      displayTarget="CNY"
      displayRate={1}
      rateUpdatedAt="—"
      baseCurrency="USD"
      targetCurrency="CNY"
      onBaseCurrencyChange={() => {}}
      onTargetCurrencyChange={() => {}}
      onRefreshRate={async () => {}}
      onLogout={onLogout}
      onOpenShops={() => nav('/shops')}
      metaSlot={metaSlot}
      mainClassName="dashboard-main app-shell-main analytics-page-main"
      cardClassName="tech-panel analytics-page-card"
    >
      {pageContent}
    </DashboardShell>
  )
}
