import { getDashboardBoundsForQuery } from '../dashboardBounds'
import type { TimeRangePreset } from '../i18n'
import {
  resolveShopApiId,
  type DashboardFilterState,
  type DashboardOrderFilter,
  type ShopCatalogRow,
} from './dashboardFilters'

export type { DashboardFilterState, ShopCatalogRow }

/** 与 backend/modules/dashboard/filterContract.js 对齐 */
export type DashboardFilterContract = {
  tenantId?: number | null
  shopId: string
  market: string
  orderFilter: DashboardOrderFilter
  timeRange: TimeRangePreset
  startDate: string
  endDate: string
}

/** UI marketRegion → API/契约 market（ALL | TH | MY | …） */
/** 大屏默认订单筛选（KPI 主卡片口径 = valid） */
export const DASHBOARD_DEFAULT_ORDER_FILTER: DashboardOrderFilter = 'valid'

/** UI 按钮顺序（固定） */
export const DASHBOARD_ORDER_FILTER_BUTTON_ORDER: readonly DashboardOrderFilter[] = [
  'all',
  'valid',
  'paid',
  'unpaid',
  'sample',
  'cancelled',
] as const

/** UI 按钮文案 i18n key（与 zh.json filter.order.* 对齐） */
export const DASHBOARD_ORDER_FILTER_I18N_KEYS: Record<DashboardOrderFilter, string> = {
  all: 'filter.order.all',
  valid: 'filter.order.valid',
  paid: 'filter.order.paid',
  unpaid: 'filter.order.unpaid',
  sample: 'filter.order.sample',
  cancelled: 'filter.order.cancelled',
}

export function parseDashboardOrderFilterParam(raw: string | null): DashboardOrderFilter | null {
  const v = String(raw ?? '').trim().toLowerCase()
  if (!v) return null
  return DASHBOARD_ORDER_FILTER_BUTTON_ORDER.includes(v as DashboardOrderFilter)
    ? (v as DashboardOrderFilter)
    : null
}

export function readDashboardOrderFilterFromUrl(search?: string): DashboardOrderFilter {
  if (typeof window === 'undefined') return DASHBOARD_DEFAULT_ORDER_FILTER
  try {
    const parsed = parseDashboardOrderFilterParam(
      new URLSearchParams(search ?? window.location.search).get('orderFilter'),
    )
    if (parsed) return parsed
  } catch {
    /* ignore */
  }
  return DASHBOARD_DEFAULT_ORDER_FILTER
}

/** API 传参：保留 paid/valid 独立语义，仅做合法化 */
export function normalizeDashboardOrderFilterForApi(
  orderFilter: DashboardOrderFilter,
): DashboardOrderFilter {
  const s = String(orderFilter || DASHBOARD_DEFAULT_ORDER_FILTER).trim().toLowerCase()
  return DASHBOARD_ORDER_FILTER_BUTTON_ORDER.includes(s as DashboardOrderFilter)
    ? (s as DashboardOrderFilter)
    : DASHBOARD_DEFAULT_ORDER_FILTER
}

/** KPI 锁定路径专用：始终 valid（与 UI paid 筛选视图无关） */
export function kpiLockedOrderFilter(_orderFilter?: DashboardOrderFilter): DashboardOrderFilter {
  return 'valid'
}

/** @deprecated 各模块已统一 contract，不再强制 valid */
export function contractForTrendKpiApi(contract: DashboardFilterContract): DashboardFilterContract {
  return contract
}

export function logDashboardFilterContractDev(
  endpoint: string,
  contract: DashboardFilterContract,
  queryKey: string,
  apiParams: Record<string, string>,
): void {
  if (!import.meta.env.DEV) return
  console.info('[dashboard-filter-contract]', {
    endpoint,
    timeRange: contract.timeRange,
    startDate: contract.startDate,
    endDate: contract.endDate,
    orderFilter: contract.orderFilter,
    market: contract.market,
    shopId: contract.shopId,
    queryKey,
    apiParams,
  })
}

export function normalizeDashboardMarket(marketRegion: string | undefined): string {
  const r = String(marketRegion ?? 'all').trim()
  if (!r || r.toLowerCase() === 'all') return 'ALL'
  return r.toUpperCase()
}

export function buildDashboardFilterContract(
  filters: DashboardFilterState,
  catalog: ShopCatalogRow[] = [],
  tenantId?: number | null,
): DashboardFilterContract {
  const bounds = getDashboardBoundsForQuery(filters.timeRange, filters.customStart, filters.customEnd)
  const shopKey = filters.shopId || 'all'
  const shopId = shopKey === 'all' ? 'all' : resolveShopApiId(shopKey, catalog)
  const market = normalizeDashboardMarket(filters.marketRegion)

  return {
    tenantId: tenantId ?? null,
    shopId,
    market,
    orderFilter: filters.orderFilter,
    timeRange: bounds.range,
    startDate: bounds.startDate,
    endDate: bounds.endDate,
  }
}

/**
 * 契约 → API query（canonical 字段）。
 * shopId 必须为 buildDashboardFilterContract / resolveShopApiId 解析结果，禁止用 UI 原始键覆盖。
 */
export function contractToApiQuery(
  contract: DashboardFilterContract,
  extra?: Record<string, string | number | undefined>,
  _options?: { legacyUiShopKey?: string },
): Record<string, string> {
  const q: Record<string, string> = {
    shopId: contract.shopId,
    market: contract.market,
    orderFilter: contract.orderFilter,
    timeRange: contract.timeRange,
    range: contract.timeRange,
    startDate: contract.startDate,
    endDate: contract.endDate,
  }
  if (contract.tenantId != null && Number.isFinite(contract.tenantId)) {
    q.tenantId = String(contract.tenantId)
  }
  if (extra) {
    for (const [k, v] of Object.entries(extra)) {
      if (v != null && String(v).trim() !== '') q[k] = String(v)
    }
  }
  return q
}

/** 大屏统一 API query：filters + catalog → 解析后的 shopId（与 orders 模块一致） */
export function buildDashboardApiQuery(
  filters: DashboardFilterState,
  catalog: ShopCatalogRow[] = [],
  extra?: Record<string, string | number | undefined>,
  resolvedShopId?: string,
): Record<string, string> {
  const contract = buildDashboardFilterContract(filters, catalog)
  const forced = String(resolvedShopId ?? '').trim()
  if (forced) {
    contract.shopId = forced.toLowerCase() === 'all' ? 'all' : forced
  }
  return contractToApiQuery(contract, extra)
}

/** 左侧店铺销售排行：固定 shopId=all，不受顶部店铺下拉影响 */
export function buildRankingPanelFilters(filters: DashboardFilterState): DashboardFilterState {
  return { ...filters, shopId: 'all' }
}

/** 店铺销售排行 API query（shopId 恒为 all） */
export function buildRankingPanelApiQuery(
  filters: DashboardFilterState,
  catalog: ShopCatalogRow[] = [],
  extra?: Record<string, string | number | undefined>,
): Record<string, string> {
  return buildDashboardApiQuery(buildRankingPanelFilters(filters), catalog, extra, 'all')
}

export function isDashboardTodayLive(timeRange: string | undefined): boolean {
  return String(timeRange || 'today').trim().toLowerCase() === 'today'
}

export type DashboardRefreshSource =
  | 'filter'
  | 'poll'
  | 'manual'
  | 'orders-changed'
  | 'scheduler'

export type DashboardLoadOpts = {
  force?: boolean
  source?: DashboardRefreshSource
}

/** today 大屏：仅显式 filter 变更时绕过服务端缓存（常规轮询/orders-changed 走 TTL） */
export function withTodayLiveQueryParams(
  q: Record<string, string>,
  timeRange: string | undefined,
  opts?: DashboardLoadOpts,
): Record<string, string> {
  if (!isDashboardTodayLive(timeRange)) return q
  if (!opts?.force || opts?.source === 'orders-changed' || opts?.source === 'poll') return q
  return {
    ...q,
    cacheBypass: '1',
    forceRefresh: 'true',
    refreshSource: opts?.source === 'filter' ? 'manual' : 'polling',
  }
}

export type DashboardModuleEndpoint =
  | 'summary'
  | 'ranking'
  | 'orders'
  | 'product-ranking'
  | 'gmv-compare'
  | 'order-volume'

/**
 * 各 dashboard 模块统一 API query（同一 market / shop / orderFilter / timeRange）。
 * 请求前打 `[dashboard-contract] endpoint=… market=…` 日志。
 */
export function buildModuleDashboardQuery(
  endpoint: DashboardModuleEndpoint,
  filters: DashboardFilterState,
  catalog: ShopCatalogRow[] = [],
  options: {
    resolvedShopId?: string
    extra?: Record<string, string | number | undefined>
    loadOpts?: DashboardLoadOpts
  } = {},
): Record<string, string> {
  const resolvedRaw = String(options.resolvedShopId ?? filters.shopId ?? 'all').trim() || 'all'
  const resolved = resolvedRaw.toLowerCase() === 'all' ? 'all' : resolveShopApiId(resolvedRaw, catalog)

  const q =
    endpoint === 'ranking'
      ? buildRankingPanelApiQuery(filters, catalog, options.extra)
      : buildDashboardApiQuery(filters, catalog, options.extra, resolved)

  const out = withTodayLiveQueryParams(q, filters.timeRange, options.loadOpts)

  const contract = buildDashboardFilterContract(filters, catalog)
  contract.shopId = endpoint === 'ranking' ? 'all' : resolved
  const queryKey = contractStableQueryKey(contract)
  logDashboardContract(endpoint, contract, { extra: 'request' })
  logDashboardFilterContractDev(endpoint, contract, queryKey, out)

  return out
}

/** 对比各模块 market 是否一致（staging 排查，不打 request 日志） */
export function logDashboardFilterParity(
  resolvedShopId: string,
  filters: DashboardFilterState,
  _catalog: ShopCatalogRow[] = [],
): void {
  const contract = buildDashboardFilterContract(filters, _catalog)
  contract.shopId = resolvedShopId
  const endpoints: DashboardModuleEndpoint[] = [
    'summary',
    'ranking',
    'orders',
    'product-ranking',
    'gmv-compare',
    'order-volume',
  ]
  const parts = endpoints.map(
    (ep) => `${ep}=m:${contract.market}|of:${contract.orderFilter}|tr:${contract.timeRange}`,
  )
  console.log(`[dashboard-filter-parity] ${parts.join(' ')} shopId=${resolvedShopId}`)
}

export function contractToSearchParams(
  contract: DashboardFilterContract,
  extra?: Record<string, string | number | undefined>,
  options?: { legacyUiShopKey?: string },
): URLSearchParams {
  const q = contractToApiQuery(contract, extra, options)
  const params = new URLSearchParams()
  for (const [k, v] of Object.entries(q)) {
    params.set(k, v)
  }
  return params
}

export function contractStableQueryKey(contract: DashboardFilterContract): string {
  return [
    `shopId=${contract.shopId || 'all'}`,
    `market=${contract.market || 'ALL'}`,
    `orderFilter=${contract.orderFilter}`,
    `timeRange=${contract.timeRange}`,
    `startDate=${contract.startDate}`,
    `endDate=${contract.endDate}`,
  ].join('|')
}

/** GMV 对比图 props → 契约 */
export function buildGmvCompareContractFromProps(props: {
  shopId: string
  market: string
  orderFilter: DashboardOrderFilter
  timeRange: TimeRangePreset
  startDate?: string
  endDate?: string
}): DashboardFilterContract {
  return {
    shopId: props.shopId === 'all' ? 'all' : props.shopId,
    market: normalizeDashboardMarket(props.market),
    orderFilter: props.orderFilter,
    timeRange: props.timeRange,
    startDate: props.startDate || '',
    endDate: props.endDate || '',
  }
}

export function logDashboardContract(
  endpoint: string,
  contract: DashboardFilterContract,
  meta?: { rows?: number; orders?: number; gmv?: number; points?: number; extra?: string },
): void {
  const parts = [
    `[dashboard-contract] endpoint=${endpoint}`,
    `shopId=${contract.shopId}`,
    `market=${contract.market}`,
    `orderFilter=${contract.orderFilter}`,
    `timeRange=${contract.timeRange}`,
    `startDate=${contract.startDate}`,
    `endDate=${contract.endDate}`,
  ]
  if (meta?.rows != null) parts.push(`rows=${meta.rows}`)
  if (meta?.orders != null) parts.push(`orders=${meta.orders}`)
  if (meta?.gmv != null) parts.push(`gmv=${meta.gmv}`)
  if (meta?.points != null) parts.push(`points=${meta.points}`)
  if (meta?.extra) parts.push(meta.extra)
  console.log(parts.join(' '))
}
