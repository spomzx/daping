/**
 * 实时大屏 GMV KPI 唯一数据源：/api/dashboard/summary（dashboard-contract USD）
 */

export type DashboardDataSourceDebug = {
  source?: string
  filter?: string
  orderFilter?: string
  timeRange?: string
  table?: string
  timeField?: string
  dateWindow?: string
  /** 本请求是否在 SQL 中附加了orderFilter 状态条件 */
  orderFilterApplied?: boolean
  /** 契约 API 是否支持按 order_status / raw_json 筛选（MySQL dashboard 为 true） */
  orderFilterStatusSupported?: boolean
  orderFilterWhereSql?: string
  invalidShop?: boolean
  reason?: string
  cacheSource?: string
  stale?: boolean
  refreshPending?: boolean
}

export type DashboardSummaryKpi = {
  currentGmvUsd: number | null
  previousGmvUsd: number | null
  changePercent: number | null
  orders: number | null
  shopCount: number | null
  gmvCurrency: string
  debug?: DashboardDataSourceDebug | null
  reason?: string
}

function readFinite(v: unknown): number | null {
  if (v == null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/** 从 /api/dashboard/summary 响应提取 KPI（禁止静默 0） */
export function parseDashboardSummaryKpi(raw: unknown): DashboardSummaryKpi {
  if (!raw || typeof raw !== 'object') {
    if (import.meta.env.DEV) {
      console.warn('[dashboard-summary-kpi] invalid summary payload', raw)
    }
    return {
      currentGmvUsd: null,
      previousGmvUsd: null,
      changePercent: null,
      orders: null,
      shopCount: null,
      gmvCurrency: 'USD',
    }
  }
  const o = raw as Record<string, unknown>
  const compare =
    o.compare && typeof o.compare === 'object' ? (o.compare as Record<string, unknown>) : null

  const currentGmvUsd = readFinite(o.gmv ?? o.gmv_usd ?? o.today_gmv_usd)
  const previousGmvUsd = readFinite(
    compare?.gmv ?? compare?.previousGmv ?? compare?.yesterdayGmv ?? o.previousGmv ?? o.yesterday_gmv,
  )
  const changeRaw = compare?.changePercent ?? compare?.change_percent ?? o.changePercent
  const changePercent = changeRaw == null ? null : readFinite(changeRaw)

  const debugRaw = o.debug && typeof o.debug === 'object' ? (o.debug as DashboardDataSourceDebug) : null
  const reasonRaw = o.reason ?? debugRaw?.reason

  return {
    currentGmvUsd,
    previousGmvUsd,
    changePercent,
    orders: readFinite(o.orders),
    shopCount: readFinite(o.shop_count ?? o.shopCount),
    gmvCurrency: String(o.gmv_currency ?? 'USD'),
    debug: debugRaw,
    reason: reasonRaw != null ? String(reasonRaw) : debugRaw?.invalidShop ? 'shop_filter_no_match' : undefined,
  }
}

export function formatKpiMoney(
  currency: string,
  value: number | null,
  format: (cur: string, amount: number) => string,
): string {
  if (value == null) return '—'
  return format(currency, value)
}

function normCurrencyCode(code: string): string {
  return String(code || 'USD')
    .trim()
    .toUpperCase()
}

/**
 * 契约 GMV 为 USD；按汇率换算到展示币种（禁止把 USD 数字直接当 THB 显示）
 */
export function convertUsdGmvToCurrency(
  usdGmv: number | null,
  toCurrency: string,
  exchangeRate: number,
  fromCurrency = 'USD',
): number | null {
  if (usdGmv == null || !Number.isFinite(usdGmv)) return null
  const to = normCurrencyCode(toCurrency)
  const from = normCurrencyCode(fromCurrency)
  if (to === from) return Number(usdGmv.toFixed(2))
  const rate = Number(exchangeRate)
  if (!Number.isFinite(rate) || rate <= 0) return null
  return Number((usdGmv * rate).toFixed(2))
}

export type HeroGmvTotals = {
  orders: number
  gmvUsd: number | null
  gmvBaseUsd: number
  gmvTargetConverted: number
  avgBaseUsd: number
  avgTargetConverted: number
}

/** 主卡：大字 USD + 副币种按汇率换算 */
export function buildHeroGmvTotals(
  orders: number,
  gmvUsd: number | null,
  targetCurrency: string,
  exchangeRate: number,
  legacyAvgTarget?: number,
): HeroGmvTotals {
  const count = Number.isFinite(orders) ? orders : 0
  const baseUsd = gmvUsd != null ? Number(gmvUsd.toFixed(2)) : 0
  const converted =
    gmvUsd != null
      ? convertUsdGmvToCurrency(gmvUsd, targetCurrency, exchangeRate, 'USD')
      : null
  const gmvTargetConverted = converted != null ? converted : 0
  const avgBaseUsd =
    count > 0 && baseUsd > 0 ? Number((baseUsd / count).toFixed(2)) : 0
  const avgTargetConverted =
    count > 0 && gmvTargetConverted > 0
      ? Number((gmvTargetConverted / count).toFixed(2))
      : legacyAvgTarget != null && Number.isFinite(legacyAvgTarget)
        ? legacyAvgTarget
        : 0
  return {
    orders: count,
    gmvUsd,
    gmvBaseUsd: baseUsd,
    gmvTargetConverted,
    avgBaseUsd,
    avgTargetConverted,
  }
}

export function yoyPercentFromKpi(current: number | null, previous: number | null): number | null {
  if (current == null || previous == null || previous <= 0) return null
  return ((current - previous) / previous) * 100
}

/** DEV：主卡与趋势卡 GMV 一致性 */
export function warnDashboardUiConsistency(
  summaryGmv: number | null,
  panelGmv: number | null,
  context: string,
): void {
  if (!import.meta.env.DEV) return
  if (summaryGmv == null || panelGmv == null) return
  const diff = Math.abs(summaryGmv - panelGmv)
  if (diff > 0.01) {
    console.warn('[dashboard-ui-consistency]', { summaryGmv, comparePanelGmv: panelGmv, diff, context })
  }
}
