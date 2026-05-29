import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import './styles/legacy-app.css'
import { RealtimeOrdersPanel } from '../components/RealtimeOrdersPanel'
import {
  isAdminLike,
  isViewerLike,
  isPlatformScope,
  type MeRole,
  type AuthSession,
  type AccountAccess,
} from '../authRole'
import { AUTH_TOKEN_KEY, getAuthHeaders } from '../authStorage'
import { TikTokOAuthMarketButtons } from '../components/TikTokOAuthMarketButtons'
import { tiktokOAuthStartUrl } from '../tiktokOAuth'
import { resolveApiRequestInput } from '../apiClient'
import { usePlatformViewTenant } from '../context/PlatformViewTenantContext'
import { TenantViewSelector } from '../components/TenantViewSelector'
import { getPlatformViewTenantId } from '../lib/platformViewTenant'
import { apiFetch } from '../apiClient'
import {
  LS_TIME_RANGE,
  LS_CUSTOM_START,
  LS_CUSTOM_END,
  readInitialTimeRange,
  useI18n,
  type TimeRangePreset,
} from '../i18n'
import { getDashboardBoundsForQuery } from '../dashboardBounds'
import {
  mergeShopCatalog,
  realtimeOrdersPanelTitleKey,
  resolveShopApiId,
  type DashboardFilterState,
  type DashboardOrderFilter,
  type ShopCatalogRow,
} from '../lib/dashboardFilters'
import {
  beginDashboardQuery,
  buildDashboardStableQueryKey,
  buildRankingStableQueryKey,
  buildProductRankingStableQueryKey,
  discardStaleDashboardResponse,
  isAbortedFetchError,
  logActiveMarketChanged,
  runDashboardFetchOnce,
  clearLiveDashboardPrimaryInflight,
  clearLiveDashboardSecondaryInflight,
} from '../lib/dashboardQueryGuard'
import { subscribeDashboardMetricsRefresh } from '../lib/ordersPollScheduler'
import {
  DASHBOARD_POLL_SUMMARY_MS,
  DASHBOARD_POLL_RANKING_MS,
  DASHBOARD_POLL_PRODUCT_RANKING_MS,
  DASHBOARD_POLL_TREND_MS,
  DASHBOARD_RANKING_AFTER_PRIMARY_MS,
  scheduleStaggeredPoll,
} from '../lib/dashboardPollSchedule'
import { formatMoneyByCurrency } from '../currencyDisplay'
import { GmvCompareTrendPanel } from '../GmvCompareTrendPanel'
import {
  isDashboardTodayLive,
  logDashboardFilterParity,
  parseDashboardOrderFilterParam,
  readDashboardOrderFilterFromUrl,
  type DashboardLoadOpts,
} from '../lib/dashboardFilterContract'
import { DashboardOrderFilterButtons } from '../components/dashboard/DashboardOrderFilterButtons'
import {
  buildHeroGmvTotals,
  parseDashboardSummaryKpi,
  warnDashboardUiConsistency,
  type DashboardDataSourceDebug,
  type DashboardSummaryKpi,
} from '../lib/dashboardSummaryKpi'
import {
  fetchDashboardSummary,
  fetchDashboardRanking,
  fetchDashboardProductRanking,
} from '../services/api/dashboard'
import {
  buildDashboardQueryParams,
  orderFilterFromLegacy,
  setDashboardQueryState,
  useDashboardQueryStore,
} from '../stores/dashboardQueryStore'
import { buildWarRoomPayloadFromContract } from '../lib/warRoomContractPayload'
import './styles/legacy-dashboard.css'
import './styles/legacy-realtime-orders.css'
import './styles/legacy-filters.css'
import './styles/legacy-charts.css'
import './styles/legacy-dashboard-layout.css'
import './styles/tenant-view-selector.legacy.css'
import {
  buildFallbackExchangeRate,
  buildLoadingExchangeRate,
  isSoftRateStatus,
  readExchangeRateCache,
  writeExchangeRateCache,
  isMissingRateStatus,
} from '../lib/exchangeRateFallback'
import { DashboardHeader } from '../components/DashboardHeader'
import { OrderVolumeChart } from '../components/OrderVolumeChart'
const PRODUCT_RANK_CARD_ROWS = 20
const FETCH_TIMEOUT_MS = 60000
/** 排行面板最长 loading；超时后展示错误 reason，禁止无限「图表加载中」 */
const RANKING_PANEL_TIMEOUT_MS = 5000
/** 首屏后延迟加载商品排行（不阻塞 summary/ranking/orders） */
const PRODUCT_RANKING_LOAD_DEFER_MS = 3000
/** 市场筛选按钮固定顺序（不受当前 dashboard 筛选结果影响） */
const MARKET_FILTER_CODES = ['TH', 'PH', 'MY', 'SG', 'VN'] as const

/** 已授权店铺明细弹窗分页 */
const SHOPS_PANEL_PAGE_SIZE = 7

/** 历史上 URL 常自动写入 orderFilter=paid；首次进入迁移为 valid */
const LS_ORDER_FILTER_DEFAULT_VALID = 'dashboard_order_filter_default_valid_v1'

/** 显式开启后才显示顶部 DATA/FILTER 调试条（正式环境默认隐藏） */
const LS_DASHBOARD_DEBUG = 'dashboardDebug'

function isLegacyDashboardDebugEnabled(): boolean {
  if (typeof window === 'undefined') return false
  try {
    const q = new URLSearchParams(window.location.search)
    const debugParam = q.get('debug')
    if (debugParam === '1' || debugParam === 'true') return true
    if (localStorage.getItem(LS_DASHBOARD_DEBUG) === '1') return true
  } catch {
    /* ignore */
  }
  return false
}

type TrendPoint = {
  time: string
  gmvBase: number
  gmvTarget: number
  orders: number
}

/** 作战室 GMV payload 店铺指标（camelCase）；非 GET /api/shops 列表契约 */
type WarRoomShopMetric = {
  shopId: string
  shopName: string
  shop_name?: string
  region: string
  market?: string
  todayOrders: number
  todayGmvBase: number
  todayGmvTarget: number
  /** 与 todayGmvTarget 一致：目标币种下的店铺 GMV（订单汇总） */
  shop_gmv?: number
  gmv?: number
  status: string
  ordersAll?: number
  ordersValid?: number
  ordersUnpaid?: number
}

type GmvMeta = {
  dataSource: string
  updatedAt: string
  refreshInterval: number
  /** orders-cache 原始条数；>0 表示同步正常，空列表多为筛选所致 */
  ordersLoadedCount?: number
  /** 今日自然日（按区域日界）内的订单条数，未应用订单类型筛选 */
  ordersTodayCount?: number
  trendMessage?: string
  status?: string
  error?: string
  lastCollectAt?: string
  lastCollectDuration?: number
  cacheAgeSeconds?: number
  collectWarning?: string
  collectError?: string
  insightsProductRankings?: boolean
  insightsProductRankingsSource?: string
  insightsProductRankingsUpdatedAt?: string
  insightsProductRankingsCurrency?: string
  insightsOverview?: boolean
  insightsOverviewSource?: string
  insightsOverviewUpdatedAt?: string
  insightsOverviewCurrency?: string
  /** 后端时间筛选回显 */
  timeRange?: string
  rangeStartEpoch?: number
  rangeEndEpoch?: number
  startDate?: string
  endDate?: string
  customInvalid?: boolean
}

/** P3 锁定：主 KPI 仅来自 /api/dashboard/summary（dashboard-contract），禁止 legacy 聚合字段 */
type GmvPayload = {
  selectedShopId: string
  baseCurrency: string
  targetCurrency: string
  exchangeRate: number
  summary: {
    todayOrders: number
    todayGmvBase: number
    todayGmvTarget: number
    avgOrderValueBase: number
    avgOrderValueTarget: number
    status: string
    updatedAt: string
    itemSoldCount?: number
    skuOrderCount?: number
  }
  shops: WarRoomShopMetric[]
  orders: Array<{
    id: string
    shopId: string
    shopName: string
    orderStatus: string
    platform: string
    region: string
    customerName: string
    orderAmountBase: number
    orderAmountTarget: number
    /** 与后端 currency.js 一致：usd = raw / rate(1USD=x本币) */
    usdAmount?: number
    cnyAmount?: number
    /** 订单支付/标价原币种（接口 currency） */
    currency?: string
    orderTime: string
    /** 样品订单：来自接口 _raw.is_sample_order / isSample */
    isSample?: boolean
    isCancelled?: boolean
  }>
  productRankings: Array<{
    rank: number
    productId: string
    skuId?: string
    sellerSku?: string
    sku?: string
    productName: string
    product_name?: string
    todayQuantity?: number
    soldQuantity: number | null
    todaySales?: number
    orderCount?: number
    todayAmount?: number
    quantity?: number
    sales_amount?: number
    gmv?: number
    region?: string
    market?: string
    shopName?: string
    shop_name?: string
    salesAmountBase: number
    salesAmountTarget: number
    salesAmountFormatted?: string
    conversionRate: number
    productStatus: 'Active' | 'Low Stock' | 'Out of Stock'
    targetCurrency: string
    skuName?: string
    currency?: string
    shopId?: string
  }>
  trend: TrendPoint[]
  meta: GmvMeta
}

type ExchangeRatePayload = {
  baseCurrency: string
  targetCurrency: string
  rate: number
  updatedAt: string
  source: string
  status: string
}

const TARGET_OPTIONS = ['USD', 'CNY', 'THB', 'SGD', 'MYR', 'PHP', 'VND'] as const

const LS_BASE_CURRENCY = 'daping_base_currency'
const LS_TARGET_CURRENCY = 'daping_target_currency'

function readInitialCurrencies(): { base: string; target: string } {
  const supported = new Set(TARGET_OPTIONS as readonly string[])
  if (typeof window === 'undefined') return { base: 'USD', target: 'USD' }
  try {
    const u = new URLSearchParams(window.location.search)
    const qb = u.get('baseCurrency') || u.get('base')
    const qt = u.get('targetCurrency') || u.get('target')
    if (qb && supported.has(qb.toUpperCase()) && qt && supported.has(qt.toUpperCase())) {
      return { base: qb.toUpperCase(), target: qt.toUpperCase() }
    }
  } catch {
    /* ignore */
  }
  try {
    const b = localStorage.getItem(LS_BASE_CURRENCY)?.trim().toUpperCase()
    const t = localStorage.getItem(LS_TARGET_CURRENCY)?.trim().toUpperCase()
    if (b && supported.has(b) && t && supported.has(t)) return { base: b, target: t }
  } catch {
    /* ignore */
  }
  return { base: 'USD', target: 'USD' }
}

/** 市场列：展示 TH / VN 等简称 */
function formatMarket(v: string | undefined): string {
  const raw = String(v || '')
    .trim()
    .toUpperCase()
  if (!raw || raw === '--') return '--'
  const known = new Set(['TH', 'MY', 'SG', 'PH', 'VN'])
  if (known.has(raw)) return raw
  if (raw.length >= 2) return raw.slice(0, 2)
  return raw
}

function safeNum(value: number | undefined, digits = 2) {
  if (!Number.isFinite(value ?? NaN)) return 0
  return Number((value ?? 0).toFixed(digits))
}

/** 大屏「统计日界」展示：与当前筛选市场一致（仅文案/时钟展示，接口不变）。 */
function getMarketStatsTimezoneDisplay(region: string) {
  const r = String(region || 'all').trim().toUpperCase()
  if (r === 'ALL') return { headline: 'Multi Timezone', clockIana: null as string | null }
  if (r === 'TH' || r === 'VN') {
    const clockIana = r === 'VN' ? 'Asia/Ho_Chi_Minh' : 'Asia/Bangkok'
    return { headline: 'UTC+7', clockIana }
  }
  if (r === 'MY') return { headline: 'UTC+8', clockIana: 'Asia/Kuala_Lumpur' }
  if (r === 'SG') return { headline: 'UTC+8', clockIana: 'Asia/Singapore' }
  if (r === 'PH') return { headline: 'UTC+8', clockIana: 'Asia/Manila' }
  return { headline: 'UTC+8', clockIana: 'Asia/Singapore' }
}

function formatClockInIanaZone(date: Date, iana: string) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: iana,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date)
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? ''
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')}`
}

function formatBrowserLocalClock(date: Date) {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

function formatAmount(currency: string, value: number) {
  return formatMoneyByCurrency(currency, value)
}

const formatCurrency = formatAmount

function shopGmvDisplayValue(s: WarRoomShopMetric): number {
  const v = s.shop_gmv ?? s.todayGmvTarget ?? s.gmv
  return Number.isFinite(Number(v)) ? Number(v) : 0
}

async function fetchWithTimeout(input: RequestInfo | URL, init: RequestInit = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController()
  const timer = window.setTimeout(() => controller.abort(), timeoutMs)
  const externalSignal = init.signal
  const forwardExternalAbort = () => {
    try {
      controller.abort()
    } catch {
      /* ignore */
    }
  }
  if (externalSignal) {
    if (externalSignal.aborted) forwardExternalAbort()
    else externalSignal.addEventListener('abort', forwardExternalAbort)
  }
  try {
    const { signal: _sig, headers: inHeaders, ...rest } = init
    const mergedHeaders: Record<string, string> = {
      ...getAuthHeaders(),
      ...(typeof inHeaders === 'object' && inHeaders != null && !Array.isArray(inHeaders)
        ? (inHeaders as Record<string, string>)
        : {}),
    }
    return await fetch(resolveApiRequestInput(input), {
      ...rest,
      headers: mergedHeaders,
      signal: controller.signal,
    })
  } finally {
    window.clearTimeout(timer)
    if (externalSignal) {
      externalSignal.removeEventListener('abort', forwardExternalAbort)
    }
  }
}

function truncateProductTitle(name: string, maxLen: number) {
  if (name.length <= maxLen) return name
  return `${name.slice(0, Math.max(0, maxLen - 3))}...`
}

function isRequestAbortedError(err: unknown) {
  const name = String((err as { name?: unknown })?.name ?? '')
  const message = String((err as { message?: unknown })?.message ?? '').toLowerCase()
  return (
    name === 'AbortError' ||
    message.includes('aborted') ||
    message.includes('signal is aborted') ||
    message.includes('the user aborted a request')
  )
}

const SHOP_NAME_FALLBACK_ID: Record<string, string> = {
  'TIKTOK MY': 'my',
  'TIKTOK PH': 'ph',
  'TIKTOK SG': 'sg',
  'TIKTOK TH': 'th',
  'TIKTOK VN': 'vn',
}

function normalizeShopId(shopId: unknown, shopName?: string) {
  const id = String(shopId || '')
    .trim()
    .toLowerCase()
  if (id) return id
  const key = String(shopName || '')
    .trim()
    .toUpperCase()
  return SHOP_NAME_FALLBACK_ID[key] || ''
}

/** 订单数以 summary（后端 orderId 去重）为准，不再用店铺累加覆盖，避免与排行「全部店铺」不一致 */
function reconcileSummaryFromShops(payload: GmvPayload): GmvPayload {
  return payload
}

function patchGmvStatus(payload: GmvPayload): GmvPayload {
  const keepCollectWarning = payload.summary?.status === 'warning'
  const ok = (payload.summary?.todayOrders ?? 0) > 0
  return {
    ...payload,
    summary: {
      ...payload.summary,
      status: keepCollectWarning ? 'warning' : ok ? 'normal' : payload.summary.status || 'normal',
    },
    shops: (payload.shops ?? []).map((s) => ({
      ...s,
      status: keepCollectWarning
        ? s.status === 'warning'
          ? 'warning'
          : s.status || 'normal'
        : (s.todayOrders ?? 0) > 0 || ok
          ? 'normal'
          : s.status || 'normal',
    })),
  }
}

export function LegacyDashboardPage({
  appRole,
  appUserScope,
  appUsername,
  appAccess,
  onLogout,
}: {
  appRole: MeRole
  appUserScope: AuthSession['scope']
  appUsername: string
  appAccess: AccountAccess
  onLogout: () => void
}) {
  const nav = useNavigate()
  const platformScope = isPlatformScope({ scope: appUserScope, role: appRole })
  const viewCtx = usePlatformViewTenant()
  const queryStore = useDashboardQueryStore()
  const [data, setData] = useState<GmvPayload | null>(null)
  const [shops, setShops] = useState<
    Array<{
      id?: number
      shopId?: string
      shopName?: string
      region?: string
      currency?: string
      enabled?: boolean
      status?: string
      tokenStatus?: string
      lastSyncAt?: string
      lastSyncOk?: boolean
      lastSyncError?: string
    }>
  >([])
  const [ordersPollSuspendUntil, setOrdersPollSuspendUntil] = useState(0)
  const [summarySlowHint, setSummarySlowHint] = useState(false)
  const [rankingSlowHint, setRankingSlowHint] = useState(false)
  const [productSlowHint, setProductSlowHint] = useState(false)
  const [rankingData, setRankingData] = useState<GmvPayload | null>(null)
  const [shopsPanelOpen, setShopsPanelOpen] = useState(false)
  const [shopsPanelPage, setShopsPanelPage] = useState(1)
  const [baseCurrency, setBaseCurrency] = useState(() => readInitialCurrencies().base)
  const [targetCurrency, setTargetCurrency] = useState(() => readInitialCurrencies().target)

  useEffect(() => {
    if (shopsPanelOpen) setShopsPanelPage(1)
  }, [shopsPanelOpen])

  useEffect(() => {
    const maxPage = Math.max(1, Math.ceil(shops.length / SHOPS_PANEL_PAGE_SIZE))
    setShopsPanelPage((p) => Math.min(Math.max(1, p), maxPage))
  }, [shops.length])
  /** yesterday/custom 不在统一 Query Store 字段内，临时保留局部状态。 */
  const [specialTimeRange, setSpecialTimeRange] = useState<'yesterday' | 'custom' | null>(null)
  const [customStart, setCustomStart] = useState(() => readInitialTimeRange().start)
  const [customEnd, setCustomEnd] = useState(() => readInitialTimeRange().end)
  const selectedShopId = queryStore.shopId || 'all'
  const selectedRegion = queryStore.market === 'ALL' ? 'all' : queryStore.market
  const orderFilter = (queryStore.orderFilter || 'all') as DashboardOrderFilter
  const timeRange: TimeRangePreset =
    specialTimeRange ?? (queryStore.range === '7d' ? 'last7' : queryStore.range === '30d' ? 'last30' : 'today')
  const { t: tx } = useI18n()
  const [customApplyNonce, setCustomApplyNonce] = useState(0)
  const [gmvLoading, setGmvLoading] = useState(true)
  const [gmvError, setGmvError] = useState(false)
  const [gmvErrorText, setGmvErrorText] = useState<string | null>(null)
  const [rateData, setRateData] = useState<ExchangeRatePayload | null>(null)
  const [rateError, setRateError] = useState(false)
  const [nowText, setNowText] = useState('')
  const rateRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const summaryControllerRef = useRef<AbortController | null>(null)
  const shopRankingControllerRef = useRef<AbortController | null>(null)
  const productRankingControllerRef = useRef<AbortController | null>(null)
  const summaryLoadingRef = useRef(false)
  const loadGmvFnRef = useRef<((opts?: DashboardLoadOpts) => Promise<void>) | null>(null)
  const loadShopRankingFnRef = useRef<((opts?: DashboardLoadOpts) => Promise<void>) | null>(null)
  const loadProductRankingFnRef = useRef<((opts?: { force?: boolean }) => Promise<void>) | null>(null)
  const [dashboardLiveRefreshNonce, setDashboardLiveRefreshNonce] = useState(0)
  /** 实时大屏 GMV KPI 唯一来源：/api/dashboard/summary（dashboard-contract USD） */
  const [contractSummaryKpi, setContractSummaryKpi] = useState<DashboardSummaryKpi | null>(null)
  const [orderVolumeDebug, setOrderVolumeDebug] = useState<DashboardDataSourceDebug | null>(null)
  const showDashboardDebugBanner = useMemo(() => isLegacyDashboardDebugEnabled(), [])
  const [contractSummaryLoading, setContractSummaryLoading] = useState(false)
  const [rankingPanelLoading, setRankingPanelLoading] = useState(false)
  const [productPanelLoading, setProductPanelLoading] = useState(false)
  const rankingEverShownRef = useRef(false)
  const productEverShownRef = useRef(false)
  /** 当前 statsQueryKey 下商品排行是否已成功返回 */
  const [rankingFetched, setRankingFetched] = useState(false)
  const [productRankingFetched, setProductRankingFetched] = useState(false)
  const [rankingError, setRankingError] = useState<string | null>(null)
  const [productRankingError, setProductRankingError] = useState<string | null>(null)
  const [shopSummary, setShopSummary] = useState({
    totalAuthorized: 0,
    enabledCount: 0,
    todayOrderShopCount: 0,
    abnormalCount: 0,
  })
  const queryStoreInitRef = useRef(false)

  /** 首次进入：从 URL/localStorage 回填到 Query Store（legacy paid -> valid），仅执行一次。 */
  useEffect(() => {
    if (queryStoreInitRef.current) return
    queryStoreInitRef.current = true

    const initial = readInitialTimeRange().preset
    const initialRange = initial === 'last7' ? '7d' : initial === 'last30' ? '30d' : 'today'
    if (initial === 'yesterday' || initial === 'custom') setSpecialTimeRange(initial)

    let nextOrderFilter = queryStore.orderFilter
    try {
      const migrated = localStorage.getItem(LS_ORDER_FILTER_DEFAULT_VALID)
      const parsed = parseDashboardOrderFilterParam(
        new URLSearchParams(window.location.search).get('orderFilter'),
      )
      if (!migrated) localStorage.setItem(LS_ORDER_FILTER_DEFAULT_VALID, '1')
      nextOrderFilter = orderFilterFromLegacy(parsed || readDashboardOrderFilterFromUrl())
    } catch {
      nextOrderFilter = orderFilterFromLegacy(readDashboardOrderFilterFromUrl())
    }

    setDashboardQueryState({
      range: initialRange,
      orderFilter: nextOrderFilter,
    })
  }, [])

  const normalizedMarketRegion = useMemo(() => {
    const r = String(selectedRegion || '').trim()
    if (!r || r.toLowerCase() === 'all') return 'all'
    return r.toUpperCase()
  }, [selectedRegion])

  const dashboardFilters: DashboardFilterState = useMemo(
    () => ({
      shopId: selectedShopId,
      marketRegion: normalizedMarketRegion,
      orderFilter,
      timeRange,
      customStart,
      customEnd,
      baseCurrency,
      targetCurrency,
    }),
    [selectedShopId, normalizedMarketRegion, orderFilter, timeRange, customStart, customEnd, baseCurrency, targetCurrency],
  )

  const moduleTimeRange = useMemo(
    () => (timeRange === 'last7' ? '7d' : timeRange === 'last30' ? '30d' : timeRange),
    [timeRange],
  )

  const buildAuthorityQuery = useCallback(
    (extra?: Record<string, string | undefined>) =>
      buildDashboardQueryParams(queryStore, {
        orderFilter: orderFilterFromLegacy(orderFilter),
        status: orderFilterFromLegacy(orderFilter),
        timeRange: moduleTimeRange,
        range: moduleTimeRange,
        startDate: customStart || undefined,
        endDate: customEnd || undefined,
        ...extra,
      }),
    [queryStore, orderFilter, moduleTimeRange, customStart, customEnd],
  )

  useEffect(() => {
    const tz = getMarketStatsTimezoneDisplay(selectedRegion).clockIana ?? 'UTC'
    if (queryStore.timezone === tz && queryStore.timeWindow === timeRange) return
    setDashboardQueryState({ timezone: tz, timeWindow: timeRange })
  }, [selectedRegion, timeRange, queryStore.timezone, queryStore.timeWindow])

  const selectMarket = useCallback((market: string) => {
    const next = !market || market.toLowerCase() === 'all' ? 'all' : market.toUpperCase()
    if (next === normalizedMarketRegion) return
    logActiveMarketChanged(next)
    setDashboardQueryState({ market: next === 'all' ? 'ALL' : next, shopId: 'all' })
    setOrdersPollSuspendUntil(Date.now() + 10_000)
    setSummarySlowHint(false)
    setRankingSlowHint(false)
    setProductSlowHint(false)
  }, [normalizedMarketRegion])

  const handleMarketFilter = selectMarket

  const shopCatalog: ShopCatalogRow[] = useMemo(
    () =>
      mergeShopCatalog(
        shops.map((s) => ({
          id: s.id,
          shopId: s.shopId,
          shopName: s.shopName,
        })),
        data?.shops?.map((s) => ({
          shopId: s.shopId,
          shopName: s.shopName,
        })),
        rankingData?.shops?.map((s) => ({
          shopId: s.shopId,
          shopName: s.shopName,
        })),
      ),
    [shops, data?.shops, rankingData?.shops],
  )

  const resolvedShopId = useMemo(
    () => resolveShopApiId(selectedShopId, shopCatalog),
    [selectedShopId, shopCatalog],
  )

  const statsQueryKey = useMemo(
    () => buildDashboardStableQueryKey(resolvedShopId, dashboardFilters),
    [
      resolvedShopId,
      normalizedMarketRegion,
      orderFilter,
      timeRange,
      customStart,
      customEnd,
      customApplyNonce,
    ],
  )

  /** 店铺销售排行：仅 market + 时间 + 订单状态，shopId 固定 all */
  const shopRankingQueryKey = useMemo(
    () => buildRankingStableQueryKey(dashboardFilters),
    [normalizedMarketRegion, orderFilter, timeRange, customStart, customEnd, customApplyNonce],
  )

  const productRankingQueryKey = useMemo(
    () => buildProductRankingStableQueryKey(resolvedShopId, dashboardFilters),
    [
      resolvedShopId,
      normalizedMarketRegion,
      orderFilter,
      timeRange,
      customStart,
      customEnd,
      customApplyNonce,
    ],
  )

  const dashboardFiltersRef = useRef(dashboardFilters)
  const shopCatalogRef = useRef(shopCatalog)
  const selectedShopIdRef = useRef(selectedShopId)
  const resolvedShopIdRef = useRef(resolvedShopId)
  const orderFilterRef = useRef(orderFilter)
  const dataRef = useRef(data)
  const rankingDataRef = useRef(rankingData)
  dashboardFiltersRef.current = dashboardFilters
  shopCatalogRef.current = shopCatalog
  selectedShopIdRef.current = selectedShopId
  resolvedShopIdRef.current = resolvedShopId
  orderFilterRef.current = orderFilter
  dataRef.current = data
  rankingDataRef.current = rankingData

  const statsLatestKeyRef = useRef('')
  const shopRankingLatestKeyRef = useRef('')
  const productRankingLatestKeyRef = useRef('')
  const contractSummaryKpiRef = useRef(contractSummaryKpi)
  contractSummaryKpiRef.current = contractSummaryKpi

  const fetchShopSummary = useCallback(() => {
    const token = typeof localStorage !== 'undefined' ? localStorage.getItem(AUTH_TOKEN_KEY) : null
    if (!token) return Promise.resolve()
    return apiFetch('/api/shops/summary', { headers: { ...getAuthHeaders() }, cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (!j || typeof j !== 'object') return
        setShopSummary({
          totalAuthorized: Number((j as { totalAuthorized?: number }).totalAuthorized ?? 0),
          enabledCount: Number((j as { enabledCount?: number }).enabledCount ?? 0),
          todayOrderShopCount: Number((j as { todayOrderShopCount?: number }).todayOrderShopCount ?? 0),
          abnormalCount: Number((j as { abnormalCount?: number }).abnormalCount ?? 0),
        })
      })
      .catch(() => {})
  }, [])

  useEffect(() => {
    void fetchShopSummary()
  }, [fetchShopSummary, data?.meta?.updatedAt])

  useEffect(() => {
    const u = new URL(window.location.href)
    const urlFilter = parseDashboardOrderFilterParam(u.searchParams.get('orderFilter'))
    const storeFilter = orderFilterFromLegacy(orderFilter)
    const urlComparable = urlFilter ? orderFilterFromLegacy(urlFilter) : null
    if (urlComparable === storeFilter) return
    u.searchParams.set('orderFilter', storeFilter)
    window.history.replaceState({}, '', `${u.pathname}${u.search}${u.hash}`)
  }, [orderFilter])

  useEffect(() => {
    try {
      localStorage.setItem(LS_BASE_CURRENCY, baseCurrency)
      localStorage.setItem(LS_TARGET_CURRENCY, targetCurrency)
    } catch {
      /* ignore */
    }
  }, [baseCurrency, targetCurrency])

  useEffect(() => {
    try {
      localStorage.setItem(LS_TIME_RANGE, timeRange)
    } catch {
      /* ignore */
    }
  }, [timeRange])

  useEffect(() => {
    try {
      localStorage.setItem(LS_CUSTOM_START, customStart)
      localStorage.setItem(LS_CUSTOM_END, customEnd)
    } catch {
      /* ignore */
    }
  }, [customStart, customEnd])

  useEffect(() => {
    const updateNow = () => {
      const now = new Date()
      const { clockIana } = getMarketStatsTimezoneDisplay(selectedRegion)
      if (!clockIana) {
        setNowText(tx('clock.browserLocal', { time: formatBrowserLocalClock(now) }))
      } else {
        setNowText(tx('clock.marketLocal', { time: formatClockInIanaZone(now, clockIana) }))
      }
    }
    updateNow()
    const timer = window.setInterval(updateNow, 1000)
    return () => window.clearInterval(timer)
  }, [selectedRegion, tx])

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const auth = params.get('shop_auth')
    if (!auth) return

    const stripAuthParams = () => {
      params.delete('shop_auth')
      params.delete('reason')
      params.delete('imported')
      params.delete('updated')
      params.delete('skipped')
      const qs = params.toString()
      const next = `${window.location.pathname}${qs ? `?${qs}` : ''}${window.location.hash}`
      window.history.replaceState({}, '', next)
    }

    if (auth === 'ok') {
      const imported = params.get('imported') || '0'
      const skipped = params.get('skipped') || '0'
      if (Number(skipped) > 0) {
        try {
          alert(`${tx('auth.alertPrefix')}imported=${imported}, skipped=${skipped} (max_shops)`)
        } catch {
          /* ignore */
        }
      }
      void fetchShopSummary()
      void handleOpenShopsPanel()
    } else if (auth === 'error') {
      const reason = params.get('reason') || 'unknown'
      try {
        alert(`${tx('auth.alertPrefix')}${decodeURIComponent(reason)}`)
      } catch {
        alert(`${tx('auth.alertPrefix')}${reason}`)
      }
    }
    stripAuthParams()
  }, [tx])

  useEffect(() => {
    void fetchShopSummary()
  }, [fetchShopSummary])

  useEffect(() => {
    const token = typeof localStorage !== 'undefined' ? localStorage.getItem(AUTH_TOKEN_KEY) : null
    if (!token) return
    void (async () => {
      try {
        const res = await apiFetch('/api/shops?page=1&page_size=100', {
          headers: { ...getAuthHeaders() },
          cache: 'no-store',
        })
        const payload = await res.json().catch(() => ({}))
        if (!res.ok) return
        const rawList = Array.isArray((payload as { list?: unknown[] }).list)
          ? (payload as { list: Record<string, unknown>[] }).list
          : Array.isArray((payload as { shops?: unknown[] }).shops)
            ? (payload as { shops: Record<string, unknown>[] }).shops
            : []
        const rows = rawList.map(mapMysqlShopForPanel)
        if (rows.length) setShops(rows)
      } catch {
        /* ignore */
      }
    })()
  }, [])

  useEffect(() => {
    const onTenantView = () => {
      void fetchShopSummary()
      void loadGmvFnRef.current?.({ force: true })
      void loadShopRankingFnRef.current?.({ force: true })
    }
    window.addEventListener('daping:platform-view-tenant', onTenantView)
    return () => window.removeEventListener('daping:platform-view-tenant', onTenantView)
  }, [fetchShopSummary])

  useEffect(() => {
    if (!isDashboardTodayLive(timeRange)) return
    const unsub = subscribeDashboardMetricsRefresh((_reason, _filterKey, meta) => {
      if (meta.primaryDue) {
        clearLiveDashboardPrimaryInflight()
        void loadGmvFnRef.current?.()
        window.setTimeout(() => {
          void loadShopRankingFnRef.current?.()
        }, DASHBOARD_RANKING_AFTER_PRIMARY_MS)
      }
      if (meta.secondaryDue) {
        void loadProductRankingFnRef.current?.()
        setDashboardLiveRefreshNonce((n) => n + 1)
      }
    })
    return unsub
  }, [timeRange])

  useEffect(() => {
    let isAlive = true

    const buildStatsQuery = (opts?: DashboardLoadOpts) => {
      logDashboardFilterParity(
        resolvedShopIdRef.current,
        dashboardFiltersRef.current,
        shopCatalogRef.current,
      )
      return buildAuthorityQuery({
        shop_id: resolvedShopIdRef.current === 'all' ? undefined : resolvedShopIdRef.current,
        shopId: resolvedShopIdRef.current,
        ...(opts?.force ? { cacheBypass: '1', forceRefresh: 'true' } : {}),
      })
    }

    const buildProductRankingQuery = (opts?: DashboardLoadOpts) =>
      buildAuthorityQuery({
        shop_id: resolvedShopIdRef.current === 'all' ? undefined : resolvedShopIdRef.current,
        shopId: resolvedShopIdRef.current,
        limit: '20',
        ...(opts?.force ? { cacheBypass: '1', forceRefresh: 'true' } : {}),
      })

    const finishProductRankingLoad = (opts?: {
      fetched?: boolean
      err?: string | null
    }) => {
      if (!isAlive) return
      setProductPanelLoading(false)
      if (opts?.fetched !== undefined) setProductRankingFetched(opts.fetched)
      if (opts?.err !== undefined) setProductRankingError(opts.err)
    }

    const loadProductRankingPanel = async (opts?: { force?: boolean }) => {
      if (opts?.force) clearLiveDashboardSecondaryInflight()
      if (platformScope && !getPlatformViewTenantId()) {
        finishProductRankingLoad({ fetched: true, err: null })
        return
      }

      const key = productRankingQueryKey
      const { key: requestKey } = beginDashboardQuery(
        productRankingLatestKeyRef,
        productRankingControllerRef,
        key,
      )
      setProductPanelLoading(true)
      setProductRankingError(null)
      setProductSlowHint(false)

      const slowTimer = window.setTimeout(() => {
        if (isAlive && productRankingLatestKeyRef.current === requestKey) setProductSlowHint(true)
      }, RANKING_PANEL_TIMEOUT_MS)
      const timeoutTimer = window.setTimeout(
        () => productRankingControllerRef.current?.abort(),
        FETCH_TIMEOUT_MS,
      )
      const isCurrent = () => {
        if (!isAlive || productRankingLatestKeyRef.current !== requestKey) {
          discardStaleDashboardResponse(requestKey, 'product-ranking')
          return false
        }
        return true
      }

      try {
        const q = buildProductRankingQuery(opts)
        const productRows = await runDashboardFetchOnce('product-ranking', requestKey, () =>
          fetchDashboardProductRanking(q),
        )
        if (productRows === undefined) {
          if (isCurrent()) finishProductRankingLoad({ fetched: true, err: null })
          return
        }
        const result = productRows
        if (!isCurrent()) return
        const products = Array.isArray(result?.items) ? result.items : []
        const kpi = contractSummaryKpiRef.current
        if (kpi) {
          const payload = buildWarRoomPayloadFromContract(
            kpi,
            [],
            products,
            baseCurrency,
            targetCurrency,
          ) as unknown as GmvPayload
          setData((prev) =>
            prev ? { ...prev, productRankings: payload.productRankings } : prev,
          )
        }
        finishProductRankingLoad({ fetched: true, err: null })
      } catch (err) {
        if (!isCurrent()) return
        if (!isAbortedFetchError(err) && !isRequestAbortedError(err)) {
          console.error('[dashboard-contract] product-ranking load failed', err)
          finishProductRankingLoad({
            fetched: true,
            err: String((err as Error)?.message || err) || tx('chart.loadTimeout'),
          })
        } else if (isCurrent()) {
          finishProductRankingLoad({ fetched: true, err: tx('chart.loadTimeout') })
        }
      } finally {
        window.clearTimeout(slowTimer)
        window.clearTimeout(timeoutTimer)
        if (isCurrent()) {
          setProductPanelLoading(false)
          setProductSlowHint(false)
        }
      }
    }

    const loadContractSummary = async (opts?: DashboardLoadOpts) => {
      if (opts?.force) clearLiveDashboardPrimaryInflight()
      if (platformScope && !getPlatformViewTenantId()) {
        if (isAlive) {
          setGmvLoading(false)
          setContractSummaryLoading(false)
          setProductPanelLoading(false)
          setProductRankingFetched(true)
          setData(null)
          setContractSummaryKpi(null)
        }
        return
      }

      const key = statsQueryKey
      const { key: requestKey } = beginDashboardQuery(statsLatestKeyRef, summaryControllerRef, key)
      summaryLoadingRef.current = true
      setContractSummaryLoading(true)
      setSummarySlowHint(false)

      const hadSummary = Boolean(contractSummaryKpiRef.current)
      if (isAlive && !hadSummary) {
        setGmvLoading(true)
        setGmvError(false)
        setGmvErrorText(null)
      }

      const slowTimer = window.setTimeout(() => {
        if (isAlive && statsLatestKeyRef.current === requestKey) setSummarySlowHint(true)
      }, RANKING_PANEL_TIMEOUT_MS)
      const timeoutTimer = window.setTimeout(() => summaryControllerRef.current?.abort(), FETCH_TIMEOUT_MS)
      const isCurrent = () => {
        if (!isAlive || statsLatestKeyRef.current !== requestKey) {
          discardStaleDashboardResponse(requestKey, 'summary')
          return false
        }
        return true
      }

      try {
        const summaryRaw = await runDashboardFetchOnce('summary', requestKey, () =>
          fetchDashboardSummary(buildStatsQuery(opts)),
        )
        if (summaryRaw === undefined) {
          if (isCurrent()) {
            setContractSummaryLoading(false)
            setGmvLoading(false)
          }
          summaryLoadingRef.current = false
          return
        }
        if (!isCurrent()) return

        const kpi = parseDashboardSummaryKpi(summaryRaw)
        contractSummaryKpiRef.current = kpi
        setContractSummaryKpi(kpi)
        const summaryOnlyPayload = buildWarRoomPayloadFromContract(
          kpi,
          [],
          [],
          baseCurrency,
          targetCurrency,
        ) as unknown as GmvPayload
        setData((prev) =>
          patchGmvStatus(
            reconcileSummaryFromShops({
              ...(prev ?? summaryOnlyPayload),
              ...summaryOnlyPayload,
              shops: prev?.shops ?? [],
              productRankings: prev?.productRankings ?? [],
            }),
          ),
        )
        setGmvError(false)
        setGmvErrorText(null)
        if (isAlive) {
          setContractSummaryLoading(false)
          setGmvLoading(false)
          setSummarySlowHint(false)
        }
      } catch (err) {
        if (isAbortedFetchError(err) || isRequestAbortedError(err)) return
        if (!isCurrent()) return
        console.error('[dashboard-contract] summary load failed', err)
        setGmvError(true)
        setGmvErrorText(String((err as Error)?.message || err))
        setProductPanelLoading(false)
        setProductRankingFetched(true)
      } finally {
        window.clearTimeout(slowTimer)
        window.clearTimeout(timeoutTimer)
        if (statsLatestKeyRef.current === requestKey) {
          summaryLoadingRef.current = false
          if (isAlive) {
            setContractSummaryLoading(false)
            setGmvLoading(false)
          }
        }
      }
    }

    loadGmvFnRef.current = (opts) => loadContractSummary(opts)
    loadProductRankingFnRef.current = (opts) => loadProductRankingPanel(opts)

    const cachedRate = readExchangeRateCache(baseCurrency, targetCurrency)
    if (cachedRate) {
      setRateData({ ...cachedRate, source: 'cache', status: 'cached' })
      setRateError(false)
    } else {
      setRateData(buildLoadingExchangeRate(baseCurrency, targetCurrency))
      setRateError(false)
    }

    const fetchRate = async (force = false, isAutoRetry = false) => {
      try {
        const rateUrl = `/api/exchange-rate?base=${baseCurrency}&target=${targetCurrency}${force ? '&force=1' : ''}`
        const rateResponse = await fetchWithTimeout(rateUrl)
        const payload = (await rateResponse.json().catch(() => ({}))) as ExchangeRatePayload & {
          error?: string
          currency?: string
        }
        if (!rateResponse.ok || payload?.error === 'MISSING_EXCHANGE_RATE') {
          throw new Error(payload?.currency ? `缺少 ${payload.currency} 汇率` : 'rate request failed')
        }
        const rate = Number(payload.rate)
        if (!Number.isFinite(rate) || rate <= 0) throw new Error('empty rate')
        writeExchangeRateCache(baseCurrency, targetCurrency, payload)
        if (isAlive) {
          setRateData(payload)
          setRateError(payload.status !== 'normal' && payload.status !== 'warning')
        }
      } catch {
        if (!isAlive) return
        setRateData({
          ...buildFallbackExchangeRate(baseCurrency, targetCurrency),
          source: 'error',
          status: 'missing_rate',
        })
        setRateError(true)
        if (!isAutoRetry && rateRetryTimerRef.current == null) {
          rateRetryTimerRef.current = setTimeout(() => {
            rateRetryTimerRef.current = null
            void fetchRate(true, true)
          }, 30000)
        }
      }
    }

    void loadContractSummary({ force: true, source: 'filter' })
    void fetchRate(false)
    const stopSummaryPoll = isDashboardTodayLive(timeRange)
      ? scheduleStaggeredPoll(DASHBOARD_POLL_SUMMARY_MS, 0, () => {
          if (!isAlive) return
          void loadContractSummary({ source: 'poll' })
        })
      : (() => {
          const statsTimer = window.setInterval(
            () => void loadContractSummary({ source: 'poll' }),
            300_000,
          )
          return () => window.clearInterval(statsTimer)
        })()
    const rateTimer = window.setInterval(() => fetchRate(false), 10 * 60 * 1000)
    return () => {
      isAlive = false
      stopSummaryPoll()
      window.clearInterval(rateTimer)
      if (rateRetryTimerRef.current != null) {
        clearTimeout(rateRetryTimerRef.current)
        rateRetryTimerRef.current = null
      }
      summaryControllerRef.current?.abort()
      productRankingControllerRef.current?.abort()
      summaryLoadingRef.current = false
    }
  }, [statsQueryKey, baseCurrency, targetCurrency, platformScope, viewCtx?.viewingTenantId, timeRange])

  useEffect(() => {
    let isAlive = true

    const buildRankingPanelQuery = (opts?: DashboardLoadOpts) =>
      buildAuthorityQuery({
        shopId: 'all',
        ...(opts?.force ? { cacheBypass: '1', forceRefresh: 'true' } : {}),
      })

    const finishShopRankingLoad = (opts?: { fetched?: boolean; err?: string | null }) => {
      if (!isAlive) return
      setRankingPanelLoading(false)
      if (opts?.fetched !== undefined) setRankingFetched(opts.fetched)
      if (opts?.err !== undefined) setRankingError(opts.err)
    }

    const loadShopRankingPanel = async (opts?: DashboardLoadOpts) => {
      if (opts?.force) clearLiveDashboardPrimaryInflight()
      if (platformScope && !getPlatformViewTenantId()) {
        finishShopRankingLoad({ fetched: true, err: null })
        return
      }

      const key = shopRankingQueryKey
      const { key: requestKey } = beginDashboardQuery(
        shopRankingLatestKeyRef,
        shopRankingControllerRef,
        key,
      )
      setRankingPanelLoading(true)
      setRankingError(null)
      setRankingSlowHint(false)

      const slowTimer = window.setTimeout(() => {
        if (isAlive && shopRankingLatestKeyRef.current === requestKey) setRankingSlowHint(true)
      }, RANKING_PANEL_TIMEOUT_MS)
      const timeoutTimer = window.setTimeout(
        () => shopRankingControllerRef.current?.abort(),
        FETCH_TIMEOUT_MS,
      )
      const isCurrent = () => {
        if (!isAlive || shopRankingLatestKeyRef.current !== requestKey) {
          discardStaleDashboardResponse(requestKey, 'ranking')
          return false
        }
        return true
      }

      try {
        const q = buildRankingPanelQuery(opts)
        const rankingRows = await runDashboardFetchOnce('ranking', requestKey, () =>
          fetchDashboardRanking({ ...q, limit: '100' }),
        )
        if (rankingRows === undefined) {
          if (isCurrent()) finishShopRankingLoad({ fetched: true, err: null })
          return
        }
        if (!isCurrent()) return

        const kpi = contractSummaryKpiRef.current ?? {
          orders: 0,
          currentGmvUsd: 0,
          previousGmvUsd: null,
          changePercent: null,
          shopCount: null,
          gmvCurrency: 'USD',
        }
        const payload = buildWarRoomPayloadFromContract(
          kpi,
          rankingRows,
          [],
          baseCurrency,
          targetCurrency,
        ) as unknown as GmvPayload

        setRankingData({
          shops: payload.shops,
          meta: payload.meta,
        } as GmvPayload)
        if (import.meta.env.DEV) {
          console.log(
            `[shop-ranking] apply rows=${payload.shops.length} shopId=all market=${buildRankingPanelQuery().market}`,
          )
        }
        finishShopRankingLoad({ fetched: true, err: null })
        setRankingSlowHint(false)
      } catch (err) {
        if (!isCurrent()) return
        if (!isAbortedFetchError(err) && !isRequestAbortedError(err)) {
          console.error('[dashboard-contract] shop-ranking load failed', err)
          finishShopRankingLoad({
            fetched: true,
            err: String((err as Error)?.message || err) || tx('chart.loadTimeout'),
          })
        } else if (isCurrent()) {
          finishShopRankingLoad({ fetched: true, err: tx('chart.loadTimeout') })
        }
      } finally {
        window.clearTimeout(slowTimer)
        window.clearTimeout(timeoutTimer)
        if (isCurrent()) {
          setRankingPanelLoading(false)
          setRankingSlowHint(false)
        }
      }
    }

    loadShopRankingFnRef.current = (opts) => loadShopRankingPanel(opts)
    void loadShopRankingPanel({ force: true, source: 'filter' })
    const stopRankingPoll =
      isDashboardTodayLive(timeRange)
        ? scheduleStaggeredPoll(DASHBOARD_POLL_RANKING_MS, 20_000, () => {
            if (!isAlive) return
            void loadShopRankingPanel({ source: 'poll' })
          })
        : () => {}

    return () => {
      isAlive = false
      stopRankingPoll()
      shopRankingControllerRef.current?.abort()
    }
  }, [shopRankingQueryKey, baseCurrency, targetCurrency, platformScope, viewCtx?.viewingTenantId, timeRange])

  useEffect(() => {
    let alive = true
    const productTimer = window.setTimeout(() => {
      if (!alive) return
      void loadProductRankingFnRef.current?.()
    }, PRODUCT_RANKING_LOAD_DEFER_MS)
    const stopProductPoll =
      isDashboardTodayLive(timeRange)
        ? scheduleStaggeredPoll(DASHBOARD_POLL_PRODUCT_RANKING_MS, 60_000, () => {
            if (!alive) return
            void loadProductRankingFnRef.current?.()
          })
        : () => {}
    const stopTrendPoll =
      isDashboardTodayLive(timeRange)
        ? scheduleStaggeredPoll(DASHBOARD_POLL_TREND_MS, 40_000, () => {
            if (!alive) return
            setDashboardLiveRefreshNonce((n) => n + 1)
          })
        : () => {}
    return () => {
      alive = false
      window.clearTimeout(productTimer)
      stopProductPoll()
      stopTrendPoll()
    }
  }, [productRankingQueryKey, statsQueryKey, timeRange, orderFilter])

  const gmvCompareQueryBounds = useMemo(
    () => getDashboardBoundsForQuery(timeRange, customStart, customEnd),
    [timeRange, customStart, customEnd],
  )

  const resolvedGmvErrorText = useMemo(() => {
    if (!gmvErrorText) return null
    if (gmvErrorText === 'PAYLOAD_NULL') return tx('app.gmvPayloadError')
    return gmvErrorText
  }, [gmvErrorText, tx])

  const orderFilterLabel = useMemo(() => {
    switch (orderFilter) {
      case 'all':
        return tx('filter.order.all')
      case 'unpaid':
        return tx('filter.order.unpaid')
      case 'sample':
        return tx('filter.order.sample')
      case 'cancelled':
        return tx('filter.order.cancelled')
      case 'paid':
        return tx('filter.order.paid')
      default:
        return tx('filter.order.valid')
    }
  }, [tx, orderFilter])

  const shopScopeLabel = useMemo(() => {
    if (selectedShopId === 'all') return tx('table.allShops')
    const hit =
      shops.find((s) => normalizeShopId(s.shopId, s.shopName) === selectedShopId) ??
      rankingData?.shops?.find((s) => normalizeShopId(s.shopId, s.shopName) === selectedShopId)
    return hit?.shopName ?? selectedShopId
  }, [shops, rankingData?.shops, selectedShopId, tx])

  const regionScopeLabel =
    normalizedMarketRegion === 'all' ? tx('market.all') : normalizedMarketRegion
  const marketStatsTimezoneHeadline = useMemo(() => {
    const { headline } = getMarketStatsTimezoneDisplay(selectedRegion)
    return headline === 'Multi Timezone' ? tx('ui.multiTimezone') : headline
  }, [selectedRegion, tx])
  const chartScopeSuffix = useMemo(() => {
    const sep = tx('chart.scopeSep')
    return [orderFilterLabel, shopScopeLabel, regionScopeLabel].join(sep)
  }, [tx, orderFilterLabel, shopScopeLabel, regionScopeLabel])

  const regionsWithAuthorizedShop = useMemo(() => {
    const set = new Set<string>()
    for (const s of shops) {
      const r = String(s?.region || '').trim().toUpperCase()
      if (r) set.add(r)
    }
    return set
  }, [shops])

  /** 固定五国 + 已授权但不在固定列表中的 region（排序追加），不读取 dashboard shops */
  const marketFilterButtons = useMemo(() => {
    const fixed = [...MARKET_FILTER_CODES]
    const extra = [...regionsWithAuthorizedShop]
      .filter((r) => !(MARKET_FILTER_CODES as readonly string[]).includes(r))
      .sort()
    return [...fixed, ...extra]
  }, [regionsWithAuthorizedShop])


  /** 店铺销售排行：仅来自 /api/dashboard/ranking（shopId=all），禁止用 data.shops / selectedShopId 过滤 */
  const rankingShops = useMemo(() => {
    const shopSource = rankingData?.shops ?? []
    const rows = [...shopSource].map((s) => ({
      ...s,
      shopId: normalizeShopId(s.shopId, s.shopName),
    }))
    rows.sort((a, b) => {
      if (b.todayOrders !== a.todayOrders) return b.todayOrders - a.todayOrders
      return a.shopName.localeCompare(b.shopName, 'en')
    })
    return rows.map((item, index) => ({ ...item, rank: index + 1 }))
  }, [rankingData?.shops])

  /** 排行首行「全部店铺」：当前 market/时间/订单筛选下的全局 GMV/订单（与 ranking shopId=all 一致） */
  const rankingAllShopsTotals = useMemo(() => {
    let gmv = 0
    let orders = 0
    for (const s of rankingShops) {
      gmv += shopGmvDisplayValue(s)
      orders += Number(s.todayOrders || 0)
    }
    return { gmv, orders }
  }, [rankingShops])

  const shopOrdersById = useMemo(() => {
    const m = new Map<string, number>()
    for (const s of rankingShops) {
      m.set(normalizeShopId(s.shopId, s.shopName), Number(s.todayOrders || 0))
    }
    return m
  }, [rankingShops])

  const activeShopCount = useMemo(
    () => rankingShops.filter((s) => Number(s.todayOrders || 0) > 0).length,
    [rankingShops],
  )

  const shopsPanelTotalPages = Math.max(1, Math.ceil(shops.length / SHOPS_PANEL_PAGE_SIZE))
  const shopsPanelPagedList = useMemo(() => {
    const start = (shopsPanelPage - 1) * SHOPS_PANEL_PAGE_SIZE
    return shops.slice(start, start + SHOPS_PANEL_PAGE_SIZE)
  }, [shops, shopsPanelPage])

  useEffect(() => {
    if (normalizedMarketRegion === 'all') return
    if (!marketFilterButtons.includes(normalizedMarketRegion)) {
      if (queryStore.market === 'ALL' && queryStore.shopId === 'all') return
      setDashboardQueryState({ market: 'ALL', shopId: 'all' })
    }
  }, [marketFilterButtons, normalizedMarketRegion, queryStore.market, queryStore.shopId])

  const handleSelectShop = (shopId: string, shopName?: string) => {
    const raw = String(shopId || '').trim().toLowerCase()
    if (!raw || raw === 'all') {
      if (queryStore.shopId === 'all') return
      setDashboardQueryState({ shopId: 'all' })
      return
    }
    const next = normalizeShopId(shopId, shopName) || raw
    if (queryStore.shopId === next) return
    setDashboardQueryState({ shopId: next })
  }

  /** 仅切换核心看板店铺；不修改 rankingData / 不过滤排行列表 */
  const handleRankingRowClick = (shopId: string, shopName?: string) => {
    handleSelectShop(shopId, shopName)
  }

  const effectiveRate = useMemo(() => {
    if (isMissingRateStatus(rateData?.status)) return 0
    const rawRate = rateData?.rate ?? data?.exchangeRate
    return Number.isFinite(Number(rawRate)) && Number(rawRate) > 0 ? Number(rawRate) : 0
  }, [rateData?.rate, rateData?.status, data?.exchangeRate, baseCurrency, targetCurrency])

  const totals = useMemo(() => {
    const s = data?.summary
    const orders =
      contractSummaryKpi?.orders != null
        ? contractSummaryKpi.orders
        : s
          ? s.todayOrders
          : 0
    const gmvUsd =
      contractSummaryKpi?.currentGmvUsd != null
        ? contractSummaryKpi.currentGmvUsd
        : s?.todayGmvBase != null && Number.isFinite(Number(s.todayGmvBase))
          ? Number(s.todayGmvBase)
          : null
    const hero = buildHeroGmvTotals(
      orders,
      gmvUsd,
      targetCurrency,
      effectiveRate,
      s?.avgOrderValueTarget,
    )
    return {
      count: hero.orders,
      gmvUsd: hero.gmvUsd,
      gmvBase: hero.gmvBaseUsd,
      gmvTarget: hero.gmvTargetConverted,
      avgBase: hero.avgBaseUsd,
      avgTarget: hero.avgTargetConverted,
    }
  }, [data, contractSummaryKpi, targetCurrency, effectiveRate])

  useEffect(() => {
    if (!import.meta.env.DEV || contractSummaryLoading) return
    warnDashboardUiConsistency(
      contractSummaryKpi?.currentGmvUsd ?? null,
      totals.gmvBase,
      `legacy-hero-${timeRange}-${orderFilter}`,
    )
  }, [contractSummaryKpi, contractSummaryLoading, totals.gmvBase, timeRange, orderFilter])

  const displayTarget = rateData?.targetCurrency ?? data?.targetCurrency ?? targetCurrency
  const displayBase = rateData?.baseCurrency ?? data?.baseCurrency ?? baseCurrency

  useEffect(() => {
    document.documentElement.classList.add('legacy-dashboard-route')
    return () => {
      document.documentElement.classList.remove('legacy-dashboard-route')
    }
  }, [])

  const collectWarning =
    data?.summary?.status === 'warning' &&
    (data?.meta?.dataSource === 'seller_center' || data?.meta?.dataSource === 'seller_center_stale')
  const statusText = useMemo(() => {
    if (gmvError) return tx('kpi.status.dataError')
    if (collectWarning) return tx('kpi.status.collectWarning')
    if (data?.summary?.status === 'normal') return tx('kpi.status.normal')
    return tx('kpi.status.abnormal')
  }, [gmvError, collectWarning, data?.summary?.status, tx])
  const statusClass = gmvError
    ? 'danger'
    : collectWarning
      ? 'warn'
      : data?.summary?.status !== 'normal'
        ? 'danger'
        : 'normal'
  const rawRate = rateData?.rate ?? data?.exchangeRate ?? effectiveRate
  const rateStatusClass =
    isMissingRateStatus(rateData?.status)
      ? 'danger'
      : isSoftRateStatus(rateData?.status)
        ? 'normal'
        : rateError || rateData?.status !== 'normal' || !Number.isFinite(rawRate) || rawRate <= 0
          ? 'danger'
          : 'normal'
  const displayRate = safeNum(effectiveRate, 4)
  const rateUpdatedAt =
    rateData?.status === 'loading'
      ? tx('rate.loading')
      : rateData?.updatedAt ?? data?.meta?.updatedAt ?? nowText
  const authConnected = shopSummary.totalAuthorized > 0
  const dataSourceKey = String(data?.meta?.dataSource || '').toLowerCase()
  const collectAtText = String(data?.meta?.lastCollectAt || data?.meta?.updatedAt || '--')
  const isOverviewSource = dataSourceKey === 'tiktok_overview'
  const isOpenApiOrdersSource = dataSourceKey === 'tiktok_open_api_orders'
  /** order-volume 契约 API 已支持 orderFilter SQL 时不再提示「缺少订单状态维度」 */
  const orderVolumeStatusFilterOk = orderVolumeDebug?.orderFilterStatusSupported === true
  const hasOrderStatusDimension =
    orderVolumeStatusFilterOk ||
    isOpenApiOrdersSource ||
    dataSourceKey.includes('order_detail') ||
    dataSourceKey.includes('tiktok_orders') ||
    (Array.isArray(data?.orders) && data.orders.some((o) => String(o?.orderStatus || '').trim() !== ''))
  const ordersCacheHasRows = Number(data?.meta?.ordersLoadedCount ?? 0) > 0

  const productRankingEmptyMessage = useMemo(() => {
    if (isOpenApiOrdersSource && ordersCacheHasRows) return tx('empty.products.filtered')
    return tx('empty.products.noData')
  }, [isOpenApiOrdersSource, ordersCacheHasRows, tx])

  const productRankings = data?.productRankings ?? []

  useEffect(() => {
    if (rankingShops.length > 0) rankingEverShownRef.current = true
  }, [rankingShops.length])

  useEffect(() => {
    if (productRankings.length > 0) productEverShownRef.current = true
  }, [productRankings.length])

  const showRankingTableLoading =
    rankingPanelLoading && !rankingEverShownRef.current && rankingShops.length === 0 && !rankingError
  const showRankingTableEmpty =
    !rankingPanelLoading && !rankingError && rankingShops.length === 0 && rankingFetched
  const showProductPanelLoading =
    productPanelLoading && !productEverShownRef.current && productRankings.length === 0 && !productRankingError
  const showProductPanelEmpty =
    !productPanelLoading && !productRankingError && productRankings.length === 0 && productRankingFetched

  const handleAuth = () => {
    const m =
      normalizedMarketRegion && normalizedMarketRegion !== 'all'
        ? normalizedMarketRegion
        : 'TH'
    window.location.href = tiktokOAuthStartUrl('local', m)
  }

  function mapMysqlShopForPanel(row: Record<string, unknown>) {
    const st = String(row.status || '').toLowerCase()
    const syncOn = !(row.sync_enabled === 0 || row.sync_enabled === false)
    return {
      id: Number(row.id),
      shopId: String(row.platform_shop_id || ''),
      shopName: String(row.display_name || row.shop_name || row.platform_shop_id || ''),
      region: String(row.region || row.market || '').toUpperCase(),
      enabled: st === 'active' && syncOn,
      tokenStatus: String(row.auth_status || row.last_health_status || 'unknown'),
      lastSyncAt: String(row.last_sync_at || row.last_authorized_at || row.updated_at || ''),
      status: st,
    }
  }

  const handleOpenShopsPanel = async () => {
    try {
      const res = await apiFetch('/api/shops?page=1&page_size=100', {
        headers: { ...getAuthHeaders() },
        cache: 'no-store',
      })
      const payload = await res.json().catch(() => ({}))
      if (res.ok) {
        const rawList = Array.isArray((payload as { list?: unknown[] }).list)
          ? (payload as { list: Record<string, unknown>[] }).list
          : Array.isArray((payload as { shops?: unknown[] }).shops)
            ? (payload as { shops: Record<string, unknown>[] }).shops
            : []
        setShops(rawList.map(mapMysqlShopForPanel))
      }
    } catch {
      // keep previous rows
    } finally {
      setShopsPanelOpen(true)
    }
  }

  const handleHeaderOpenShops = () => {
    if (authConnected) {
      if (isAdminLike(appRole)) nav('/shops')
      else void handleOpenShopsPanel()
    } else {
      handleAuth()
    }
  }

  const handleRefreshRate = async () => {
    try {
      const rateResp = await fetchWithTimeout(
        `/api/exchange-rate?base=${baseCurrency}&target=${targetCurrency}&force=1`,
      )
      if (!rateResp.ok) throw new Error('rate refresh failed')
      const ratePayload: ExchangeRatePayload = await rateResp.json()
      const rate = Number(ratePayload.rate)
      if (!Number.isFinite(rate) || rate <= 0) throw new Error('empty rate')
      writeExchangeRateCache(baseCurrency, targetCurrency, ratePayload)
      setRateData(ratePayload)
      setRateError(ratePayload.status !== 'normal' && ratePayload.status !== 'warning')
    } catch {
      setRateData(buildFallbackExchangeRate(baseCurrency, targetCurrency))
      setRateError(false)
    }
  }

  return (
    <div className="legacy-dashboard">
    <div className="war-room war-room--viewport">
      {summarySlowHint && contractSummaryLoading ? (
        <div className="warn-text legacy-summary-slow-hint" style={{ padding: '8px 16px' }}>
          {tx('chart.loadSlow')}
        </div>
      ) : null}
      {gmvError && resolvedGmvErrorText ? (
        <div className="warn-text" style={{ padding: 16 }}>
          {tx('app.gmvErrorDetail', { prefix: tx('app.gmvErrorPrefix'), detail: resolvedGmvErrorText })}
        </div>
      ) : null}
      {platformScope && !viewCtx?.viewingTenantId ? (
        <div className="warn-text" style={{ padding: '12px 16px', marginBottom: 8 }}>
          请选择租户查看数据
        </div>
      ) : null}
      {!platformScope && !authConnected && !gmvLoading ? (
        <div className="warn-text" style={{ padding: '12px 16px', marginBottom: 8 }}>
          {tx('dashboard.authorizeShopsFirst')}
        </div>
      ) : null}
      <DashboardHeader
        appRole={appRole}
        appUserScope={appUserScope}
        appUsername={appUsername}
        appAccess={appAccess}
        platformScope={platformScope}
        authConnected={authConnected}
        shopSummary={shopSummary}
        activeShopCount={activeShopCount}
        nowText={nowText}
        marketStatsTimezoneHeadline={marketStatsTimezoneHeadline}
        displayBase={displayBase}
        displayTarget={displayTarget}
        displayRate={displayRate}
        rateUpdatedAt={rateUpdatedAt}
        baseCurrency={baseCurrency}
        targetCurrency={targetCurrency}
        onBaseCurrencyChange={setBaseCurrency}
        onTargetCurrencyChange={setTargetCurrency}
        onRefreshRate={handleRefreshRate}
        onLogout={onLogout}
        onOpenShops={handleHeaderOpenShops}
        metaSlot={
          <>
            {showDashboardDebugBanner ? (
              <div
                className="data-source-debug-banner"
                style={{
                  fontSize: 11,
                  fontFamily: 'monospace',
                  color: '#7ee787',
                  background: 'rgba(0,40,30,0.85)',
                  border: '1px solid #1a4a3a',
                  padding: '4px 8px',
                  borderRadius: 4,
                  marginBottom: 6,
                }}
                title="dashboard-contract debug（?debug=1 或 localStorage.dashboardDebug=1）"
              >
                DATA: {String(contractSummaryKpi?.debug?.source || 'MYSQL').toUpperCase()}
                {' | '}
                FILTER:{' '}
                {String(
                  contractSummaryKpi?.debug?.filter ||
                    contractSummaryKpi?.debug?.orderFilter ||
                    orderFilter,
                ).toUpperCase()}
              </div>
            ) : null}
            {platformScope ? <TenantViewSelector /> : null}
            <div className="debug-meta-hint">
              {tx('meta.dataLine', {
                label: tx('meta.dataCollectAt'),
                collectAt: collectAtText,
                orders: data?.summary?.todayOrders ?? 0,
                shops: shopSummary.totalAuthorized,
                trend: data?.trend?.length ?? 0,
              })}
            </div>
            {data?.meta?.collectWarning ? <div className="warn-text">{data.meta.collectWarning}</div> : null}
            {import.meta.env.DEV ? (
              <div className="debug-meta-hint">
                {`meta: dataSource=${String(data?.meta?.dataSource ?? '∅')} | insightsOverview=${String(data?.meta?.insightsOverview)} | insightsProductRankings=${String(data?.meta?.insightsProductRankings)} | timeRange=${String(data?.meta?.timeRange ?? '')}`}
              </div>
            ) : null}
          </>
        }
      />
      

      {shopsPanelOpen ? (
        <div
          role="dialog"
          aria-modal="true"
          onClick={() => setShopsPanelOpen(false)}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.55)',
            zIndex: 1000,
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'center',
            padding: 24,
            overflowX: 'hidden',
            boxSizing: 'border-box',
          }}
        >
          <div
            className="shops-authorized-modal"
            onClick={(e) => e.stopPropagation()}
            style={{
              width: '100%',
              maxWidth: 960,
              boxSizing: 'border-box',
              background: '#0E1B2C',
              border: '1px solid #1A2A41',
              borderRadius: 12,
              padding: 16,
              overflowX: 'hidden',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
              <div>
                <div style={{ fontSize: 16, fontWeight: 700 }}>{tx('shops.panelTitle')}</div>
                <div className="debug-meta-hint">{tx('shops.connectedCount', { n: shopSummary.totalAuthorized })}</div>
              </div>
              <button
                type="button"
                className="refresh-btn"
                onClick={() => {
                  setShopsPanelOpen(false)
                }}
              >
                {tx('shops.close')}
              </button>
            </div>

            <div style={{ marginTop: 12 }}>
              {isAdminLike(appRole) ? (
                <TikTokOAuthMarketButtons />
              ) : (
                <span className="debug-meta-hint">{tx('dashboard.viewerReadonlyHint')}</span>
              )}
            </div>

            <div className="table-wrap" style={{ marginTop: 12 }}>
              <table>
                <thead>
                  <tr>
                    <th>{tx('shops.thShopName')}</th>
                    <th>{tx('shops.thMarket')}</th>
                    <th>{tx('shops.thShopId')}</th>
                    <th>{tx('shops.thEnabled')}</th>
                    <th>{tx('shops.thToken')}</th>
                    <th>{tx('shops.thSync')}</th>
                    <th>{tx('shops.thAction')}</th>
                  </tr>
                </thead>
                <tbody>
                  {shops.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="empty-cell">
                        {tx('shops.emptyList')}
                      </td>
                    </tr>
                  ) : (
                    shopsPanelPagedList.map((s) => {
                      const shopId = String(s.shopId || '')
                      const shopName = String(s.shopName || shopId || 'TikTok Shop')
                      const region = String(s.region || '').toUpperCase() || '--'
                      const tokenStatus = String(s.tokenStatus || s.status || '--')
                      const lastSyncAt = String(s.lastSyncAt || (s as { updatedAt?: string })?.updatedAt || '--')
                      const enabled = s.enabled !== false
                      const normalizedShopId = normalizeShopId(shopId, shopName)
                      const todayOrders = shopOrdersById.get(normalizedShopId) ?? 0
                      return (
                        <tr key={shopId || shopName}>
                          <td>{shopName}</td>
                          <td>{region}</td>
                          <td>{shopId || '--'}</td>
                          <td>{enabled ? 'enabled' : 'disabled'}</td>
                          <td>{todayOrders > 0 ? tokenStatus : tx('shops.noOrdersToday', { status: tokenStatus })}</td>
                          <td>{lastSyncAt}</td>
                          <td>
                            {isViewerLike(appRole) ? (
                              '—'
                            ) : (
                              <button
                                type="button"
                                className="refresh-btn"
                                onClick={async () => {
                                  const mysqlId = Number((s as { id?: number }).id)
                                  if (!Number.isFinite(mysqlId)) return
                                  await apiFetch(`/api/shops/${mysqlId}/status`, {
                                    method: 'PATCH',
                                    headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
                                    body: JSON.stringify({ status: enabled ? 'disabled' : 'active' }),
                                  }).catch(() => null)
                                  const latest = await apiFetch('/api/shops', {
                                    headers: { ...getAuthHeaders() },
                                    cache: 'no-store',
                                  })
                                    .then((r) => r.json())
                                    .catch(() => null)
                                  const rows = Array.isArray((latest as { shops?: Record<string, unknown>[] })?.shops)
                                    ? (latest as { shops: Record<string, unknown>[] }).shops.map(mapMysqlShopForPanel)
                                    : []
                                  setShops(rows)
                                  void fetchShopSummary()
                                }}
                              >
                                {enabled ? tx('shops.disable') : tx('shops.enable')}
                              </button>
                            )}
                          </td>
                        </tr>
                      )
                    })
                  )}
                </tbody>
              </table>
            </div>
            {shops.length > 0 ? (
              <div className="shops-panel-pager">
                <button
                  type="button"
                  className="refresh-btn"
                  disabled={shopsPanelPage <= 1}
                  onClick={() => setShopsPanelPage((p) => Math.max(1, p - 1))}
                >
                  {tx('shops.prev')}
                </button>
                <span className="shops-panel-pager-info">{`${shopsPanelPage} / ${shopsPanelTotalPages}`}</span>
                <button
                  type="button"
                  className="refresh-btn"
                  disabled={shopsPanelPage >= shopsPanelTotalPages}
                  onClick={() => setShopsPanelPage((p) => Math.min(shopsPanelTotalPages, p + 1))}
                >
                  {tx('shops.next')}
                </button>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      <main className="legacy-war-room-grid three-column war-room-grid">
        <section className="col left-col left-column">
          <div className="tech-panel filter-panel filter-panel--stacked">
            <div className="filter-cluster-title">{tx('market.heading')}</div>
            <div className="filter-buttons">
              <button type="button" className={normalizedMarketRegion === 'all' ? 'active' : ''} onClick={() => selectMarket('all')}>
                {tx('market.all')}
              </button>
              {marketFilterButtons.map((r) => {
                const hasAuth = regionsWithAuthorizedShop.has(r)
                return (
                  <button
                    type="button"
                    key={r}
                    className={`${normalizedMarketRegion === r ? 'active' : ''}${!hasAuth ? ' market-filter-muted' : ''}`}
                    onClick={() => selectMarket(r)}
                  >
                    {r}
                  </button>
                )
              })}
            </div>
          </div>
          <div className="tech-panel table-panel ranking-panel rank-panel">
            <h3 className="ranking-panel-heading">
              <span>{tx('shop.rankTitle')}</span>
              {rankingSlowHint && rankingPanelLoading ? (
                <small className="ranking-panel-slow warn-text">{tx('chart.loadSlow')}</small>
              ) : null}
              {rankingError ? (
                <small className="ranking-panel-err warn-text">{rankingError}</small>
              ) : null}
              {data?.meta?.dataSource === 'tiktok_insights' && selectedShopId === 'all' ? (
                <small className="ranking-mock-hint">{tx('ranking.mockHint')}</small>
              ) : null}
            </h3>
            <div className="table-wrap">
              <table className="shop-ranking-table">
                <colgroup>
                  <col className="shop-ranking-col-rank" />
                  <col className="shop-ranking-col-name" />
                  <col className="shop-ranking-col-region" />
                  <col className="shop-ranking-col-gmv" />
                  <col className="shop-ranking-col-orders" />
                </colgroup>
                <thead>
                  <tr>
                    <th>{tx('table.rank')}</th>
                    <th>{tx('table.shopName')}</th>
                    <th>{tx('table.market')}</th>
                    <th className="num">{tx('table.shopGmv')}</th>
                    <th className="num">{tx(`table.ordersCount.${timeRange}`)}</th>
                  </tr>
                </thead>
                <tbody>
                  {showRankingTableLoading ? (
                    <tr>
                      <td colSpan={5} className="table-empty table-skeleton">
                        {tx('chart.loading')}
                      </td>
                    </tr>
                  ) : rankingError ? (
                    <tr>
                      <td colSpan={5} className="table-empty warn-text">
                        {rankingError}
                      </td>
                    </tr>
                  ) : (
                    <>
                      <tr
                        key="shop-ranking-all"
                        className={`shop-ranking-row shop-ranking-row--all${
                          selectedShopId === 'all' ? ' shop-ranking-row--active' : ''
                        }`}
                        onClick={() => handleRankingRowClick('all')}
                        role="button"
                        tabIndex={0}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault()
                            handleRankingRowClick('all')
                          }
                        }}
                      >
                        <td className="rank-all">—</td>
                        <td className="cell-shop">{tx('table.allShops')}</td>
                        <td>{tx('market.all')}</td>
                        <td className="num">
                          {formatCurrency(displayTarget, rankingAllShopsTotals.gmv)}
                        </td>
                        <td className="num">{rankingAllShopsTotals.orders}</td>
                      </tr>
                      {rankingShops.map((item) => {
                        const rowShopId = normalizeShopId(item.shopId, item.shopName)
                        const isActive =
                          selectedShopId !== 'all' && rowShopId === selectedShopId
                        return (
                          <tr
                            key={item.shopId || item.shopName}
                            className={`shop-ranking-row${isActive ? ' shop-ranking-row--active' : ''}`}
                            onClick={() => handleRankingRowClick(item.shopId, item.shopName)}
                            role="button"
                            tabIndex={0}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter' || e.key === ' ') {
                                e.preventDefault()
                                handleRankingRowClick(item.shopId, item.shopName)
                              }
                            }}
                          >
                            <td
                              className={
                                item.rank === 1
                                  ? 'rank-1'
                                  : item.rank === 2
                                    ? 'rank-2'
                                    : item.rank === 3
                                      ? 'rank-3'
                                      : ''
                              }
                            >
                              {item.rank}
                            </td>
                            <td className="cell-shop">{item.shopName}</td>
                            <td>{formatMarket(item.market || item.region)}</td>
                            <td className="num">{formatCurrency(displayTarget, shopGmvDisplayValue(item))}</td>
                            <td className="num">{item.todayOrders}</td>
                          </tr>
                        )
                      })}
                      {showRankingTableEmpty ? (
                        <tr>
                          <td colSpan={5} className="table-empty">
                            {tx('empty.shops')}
                          </td>
                        </tr>
                      ) : null}
                    </>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          <div className="tech-panel table-panel product-ranking-panel product-panel">
            <h3 className="product-ranking-panel-heading">
              <span>{tx(`product.rankTitle.${timeRange}`)}</span>
              {productSlowHint && productPanelLoading ? (
                <small className="product-ranking-panel-slow warn-text">{tx('chart.loadSlow')}</small>
              ) : null}
            </h3>
            {productRankingError ? (
              <div className="warn-text product-ranking-panel-err">{productRankingError}</div>
            ) : null}
            <div className="table-wrap product-ranking-wrap product-ranking-table-wrap">
              {showProductPanelLoading ? (
                <table className="product-ranking-table product-ranking-table--skeleton">
                  <colgroup>
                    <col className="pr-col-rank" />
                    <col className="pr-col-name-col" />
                    <col className="pr-col-qty" />
                  </colgroup>
                  <thead>
                    <tr>
                      <th className="pr-col-rank">#</th>
                      <th className="pr-col-name-head">{tx('table.productName')}</th>
                      <th className="num pr-col-qty">{tx(`table.qty.${timeRange}`)}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {Array.from({ length: PRODUCT_RANK_CARD_ROWS }, (_, i) => (
                      <tr key={`pr-skel-${i}`}>
                        <td colSpan={3} className="table-skeleton product-ranking-skeleton-row">
                          {i === 0 ? tx('chart.loading') : '\u00a0'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : showProductPanelEmpty ? (
                <div className="empty-cell product-ranking-empty">{productRankingEmptyMessage}</div>
              ) : (
                <table className="product-ranking-table">
                  <colgroup>
                    <col className="pr-col-rank" />
                    <col className="pr-col-name-col" />
                    <col className="pr-col-qty" />
                  </colgroup>
                  <thead>
                    <tr>
                      <th className="pr-col-rank">#</th>
                      <th className="pr-col-name-head">{tx('table.productName')}</th>
                      <th className="num pr-col-qty">{tx(`table.qty.${timeRange}`)}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {productRankings.slice(0, PRODUCT_RANK_CARD_ROWS).map((item) => {
                      const shopLabel = String(item.shop_name || item.shopName || '—')
                      const marketCode = formatMarket(item.market || item.region)
                      const metaLine = tx('product.metaLine', { market: marketCode, shop: shopLabel })
                      const qty = item.soldQuantity ?? item.todaySales ?? item.quantity ?? item.todayQuantity
                      const titleMain = `${item.productName} (${item.productId})`
                      return (
                        <tr key={`${String(item.shopId || '')}-${item.productId}-${item.rank}`}>
                          <td className="pr-col-rank">{item.rank}</td>
                          <td className="pr-col-name">
                            <div className="pr-name-stack">
                              <div className="pr-name-line1" title={titleMain}>
                                {truncateProductTitle(item.productName, 42)}
                              </div>
                              <div className="pr-name-line2" title={metaLine}>
                                {metaLine}
                              </div>
                            </div>
                          </td>
                          <td className="num pr-col-qty">{qty == null ? '—' : String(qty)}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              )}
            </div>
          </div>

        </section>

        <section className="col center-col center-column">
          <div className="tech-panel hero-panel">
            <h3>{tx('kpi.coreTitle', { shop: shopScopeLabel })}</h3>
            <div className="hero-kpi">
              <div>
                <span>{tx(`kpi.ordersCount.${timeRange}`)}</span>
                <strong className="glow-num hero-kpi-num">{totals.count}</strong>
              </div>
              <div>
                <span>{tx(`kpi.gmvBase.${timeRange}`, { base: displayBase })}</span>
                <strong className="gold-num hero-kpi-num gmv-value">
                  {formatAmount(displayBase, totals.gmvBase)}
                </strong>
                {displayTarget !== displayBase ? (
                  <small>{formatAmount(displayTarget, totals.gmvTarget)}</small>
                ) : null}
              </div>
            </div>
            <div className="core-grid core-grid--quad">
              <div>
                <span>{tx(`kpi.gmvBase.${timeRange}`, { base: displayBase })}</span>
                <strong>{formatAmount(displayBase, totals.gmvBase)}</strong>
              </div>
              <div>
                <span>{tx('kpi.aov', { target: displayTarget })}</span>
                <strong>{formatAmount(displayTarget, totals.avgTarget)}</strong>
              </div>
              <div>
                <span>{tx('kpi.fxPair', { base: displayBase, target: displayTarget })}</span>
                <strong className={rateStatusClass}>{displayRate.toFixed(4)}</strong>
              </div>
              <div>
                <span>{tx('kpi.collectStatus')}</span>
                <strong className={statusClass}>{statusText}</strong>
              </div>
            </div>
            {data?.meta?.insightsOverview && (
              <div className="core-grid core-grid--pair insights-mini-kpi">
                <div>
                  <span>{tx('kpi.itemSold')}</span>
                  <strong className="glow-num">{Math.round(data.summary.itemSoldCount ?? 0).toLocaleString('en-US')}</strong>
                </div>
                <div>
                  <span>{tx('kpi.skuOrders')}</span>
                  <strong className="glow-num">{Math.round(data.summary.skuOrderCount ?? 0).toLocaleString('en-US')}</strong>
                </div>
              </div>
            )}
            <div className="core-grid core-grid--pair">
              <div>
                <span>{tx('meta.rateUpdatedAt')}</span>
                <strong>{rateUpdatedAt}</strong>
              </div>
              <div>
                <span>{tx('meta.dataUpdatedAt')}</span>
                <strong>{data?.summary?.updatedAt ?? '--'}</strong>
              </div>
            </div>
            {isMissingRateStatus(rateData?.status) ? (
              <div className="warn-text danger">
                {tx('rate.missingWarn', { currency: displayTarget })}
              </div>
            ) : null}
            {rateData?.status === 'warning' &&
            rateData?.source !== 'fallback' &&
            rateData?.source !== 'cache' &&
            rateData?.source !== 'loading' &&
            !isMissingRateStatus(rateData?.status) ? (
              <div className="warn-text">{tx('rate.fallbackWarn')}</div>
            ) : null}
          </div>

          <RealtimeOrdersPanel
            title={tx(realtimeOrdersPanelTitleKey(timeRange))}
            shop_id={resolvedShopId}
            filters={dashboardFilters}
            onMarketFilter={handleMarketFilter}
            pollSuspendUntil={ordersPollSuspendUntil}
          />
          {orderFilter === 'unpaid' && String(data?.meta?.dataSource || '').toLowerCase() === 'tiktok_overview' ? (
            <div className="warn-text">{tx('warn.overviewUnpaid')}</div>
          ) : null}
        </section>

        <section className="col right-col right-column">
          <div className="right-col-filters-stack">
            <div className="tech-panel filter-panel filter-panel--stacked right-col-filter-block">
              <div className="filter-cluster-title">{tx('time.heading')}</div>
              <div className="filter-buttons time-filter">
                <button
                  type="button"
                  className={timeRange === 'today' ? 'active' : ''}
                  onClick={() => {
                    setSpecialTimeRange(null)
                    setDashboardQueryState({ range: 'today' })
                  }}
                >
                  {tx('time.today')}
                </button>
                <button
                  type="button"
                  className={timeRange === 'yesterday' ? 'active' : ''}
                  onClick={() => {
                    setSpecialTimeRange('yesterday')
                    setDashboardQueryState({ range: 'today' })
                  }}
                >
                  {tx('time.yesterday')}
                </button>
                <button
                  type="button"
                  className={timeRange === 'last7' ? 'active' : ''}
                  onClick={() => {
                    setSpecialTimeRange(null)
                    setDashboardQueryState({ range: '7d' })
                  }}
                >
                  {tx('time.last7')}
                </button>
                <button
                  type="button"
                  className={timeRange === 'last30' ? 'active' : ''}
                  onClick={() => {
                    setSpecialTimeRange(null)
                    setDashboardQueryState({ range: '30d' })
                  }}
                >
                  {tx('time.last30')}
                </button>
                <button
                  type="button"
                  className={timeRange === 'custom' ? 'active' : ''}
                  onClick={() => {
                    setSpecialTimeRange('custom')
                    setDashboardQueryState({ range: 'today' })
                  }}
                >
                  {tx('time.custom')}
                </button>
              </div>
              {timeRange === 'custom' ? (
                <div className="custom-range-row date-range">
                  <label>
                    {tx('time.customStart')}
                    <input type="date" value={customStart} onChange={(e) => setCustomStart(e.target.value)} />
                  </label>
                  <label>
                    {tx('time.customEnd')}
                    <input type="date" value={customEnd} onChange={(e) => setCustomEnd(e.target.value)} />
                  </label>
                  <button type="button" className="refresh-btn" onClick={() => setCustomApplyNonce((n) => n + 1)}>
                    {tx('time.apply')}
                  </button>
                </div>
              ) : null}
            </div>
            <div className="tech-panel filter-panel filter-panel--stacked right-col-filter-block">
              <div className="filter-cluster-title">{tx('filter.order.heading')}</div>
              <DashboardOrderFilterButtons
                value={orderFilter}
                onChange={(next) => setDashboardQueryState({ orderFilter: orderFilterFromLegacy(next) })}
              />
            </div>
          </div>
          <div className="tech-panel chart-panel chart-panel--tall chart-panel--responsive-chart">
            <GmvCompareTrendPanel
              filters={dashboardFilters}
              resolvedShopId={resolvedShopId}
              status={orderFilter}
              groupBy="hour"
              title={tx('chart.gmvTrendTitle')}
              shopScopeLabel={shopScopeLabel}
              range={gmvCompareQueryBounds.range}
              startDate={gmvCompareQueryBounds.startDate}
              endDate={gmvCompareQueryBounds.endDate}
              summaryKpi={contractSummaryKpi}
              summaryKpiLoading={contractSummaryLoading && contractSummaryKpi == null}
              fetchEnabled
              liveRefreshNonce={dashboardLiveRefreshNonce}
            />
            {/* 趋势卡：今日 GMV=summary；昨日同期/曲线=gmv-compare（见 GmvCompareTrendPanel） */}
            {isOverviewSource && orderFilter === 'valid' ? (
              <div className="warn-text">{tx('warn.overviewValid')}</div>
            ) : null}
            {isOverviewSource && orderFilter === 'unpaid' ? (
              <div className="warn-text">{tx('warn.overviewUnpaidDetail')}</div>
            ) : null}
            {!isOverviewSource && !hasOrderStatusDimension ? (
              <div className="warn-text">{tx('warn.noOrderStatusDim')}</div>
            ) : null}
          </div>
          <div className="tech-panel chart-panel chart-panel--tall chart-panel--responsive-chart">
            <h3>
              {chartScopeSuffix
                ? tx('chart.titleWithScope', { title: tx('chart.ordersTrend'), scope: chartScopeSuffix })
                : tx('chart.ordersTrend')}
            </h3>
            <OrderVolumeChart
              filters={dashboardFilters}
              resolvedShopId={resolvedShopId}
              seriesName={tx('chart.orderVolume')}
              loadingLabel={tx('chart.loading')}
              emptyLabel={tx('chart.volumeEmpty')}
              errorLabel={tx('chart.volumeError')}
              onVolumeDebug={setOrderVolumeDebug}
              fetchEnabled
              liveRefreshNonce={dashboardLiveRefreshNonce}
            />
          </div>
        </section>
      </main>
    </div>
    </div>
  )
}
