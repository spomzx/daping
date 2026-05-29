import type { DashboardFilterState } from './dashboardFilters'
import { buildDashboardFilterContract, contractStableQueryKey } from './dashboardFilterContract'

export type DashboardQueryKeyInput = Pick<
  DashboardFilterState,
  'marketRegion' | 'orderFilter' | 'timeRange' | 'customStart' | 'customEnd'
>

/**
 * 稳定筛选键：shopId + market + orderFilter + timeRange + startDate + endDate
 */
export function buildDashboardStableQueryKey(
  resolvedShopId: string,
  filters: DashboardQueryKeyInput,
): string {
  const contract = buildDashboardFilterContract({
    shopId: 'all',
    marketRegion: filters.marketRegion,
    orderFilter: filters.orderFilter,
    timeRange: filters.timeRange,
    customStart: filters.customStart,
    customEnd: filters.customEnd,
    baseCurrency: 'USD',
    targetCurrency: 'USD',
  })
  contract.shopId = String(resolvedShopId || 'all').trim() || 'all'
  return contractStableQueryKey(contract)
}

/** 左侧店铺排行：固定 shopId=all */
export function buildRankingStableQueryKey(filters: DashboardQueryKeyInput): string {
  return buildDashboardStableQueryKey('all', filters)
}

/** 商品排行：独立 queryKey，避免与 summary 共用去重/abort */
export function buildProductRankingStableQueryKey(
  resolvedShopId: string,
  filters: DashboardQueryKeyInput,
): string {
  return `product-ranking|${buildDashboardStableQueryKey(resolvedShopId, filters)}`
}

export function logDashboardQuery(
  event: 'start' | 'abort' | 'ignore stale' | 'apply',
  key: string,
  detail?: string,
): void {
  const suffix = detail ? ` ${detail}` : ''
  console.log(`[dashboard-query] ${event} key=${key}${suffix}`)
}

export function isAbortedFetchError(e: unknown): boolean {
  const name = String((e as { name?: unknown })?.name ?? '')
  const message = String((e as { message?: unknown })?.message ?? '').toLowerCase()
  return (
    name === 'AbortError' ||
    message.includes('aborted') ||
    message.includes('signal is aborted') ||
    message.includes('the user aborted a request')
  )
}

/** orders / order-volume：不 abort 在途请求，仅用 generation 丢弃过期响应 */
export function beginDashboardQuerySoft(
  latestKeyRef: { current: string },
  generationRef: { current: number },
  newKey: string,
): { key: string; generation: number } {
  generationRef.current += 1
  latestKeyRef.current = newKey
  const generation = generationRef.current
  logDashboardQuery('start', newKey, `gen=${generation}`)
  return { key: newKey, generation }
}

export function discardStaleDashboardResponse(
  responseKey: string,
  endpoint?: DashboardEndpoint,
  detail?: string,
): void {
  const ep = endpoint ? ` endpoint=${endpoint}` : ''
  const extra = detail ? ` ${detail}` : ''
  console.log(`[dashboard-query] discard stale response filterKey=${responseKey}${ep}${extra}`)
}

export function logActiveMarketChanged(market: string): void {
  console.log(`[dashboard-query] active market changed ${market}`)
}

export function shouldApplyDashboardQueryGeneration(
  generationRef: { current: number },
  responseGeneration: number,
  responseKey: string,
  endpoint?: DashboardEndpoint,
): boolean {
  if (generationRef.current !== responseGeneration) {
    discardStaleDashboardResponse(responseKey, endpoint, `gen=${responseGeneration}`)
    return false
  }
  logDashboardQuery('apply', responseKey, `gen=${responseGeneration}`)
  return true
}

export function beginDashboardQuery(
  latestKeyRef: { current: string },
  abortRef: { current: AbortController | null },
  newKey: string,
): { key: string; signal: AbortSignal } {
  if (abortRef.current) {
    logDashboardQuery('abort', latestKeyRef.current || newKey)
    abortRef.current.abort()
  }
  latestKeyRef.current = newKey
  logDashboardQuery('start', newKey)
  const ac = new AbortController()
  abortRef.current = ac
  return { key: newKey, signal: ac.signal }
}

export function shouldApplyDashboardQuery(
  latestKeyRef: { current: string },
  responseKey: string,
  endpoint?: DashboardEndpoint,
): boolean {
  if (latestKeyRef.current !== responseKey) {
    discardStaleDashboardResponse(responseKey, endpoint)
    return false
  }
  logDashboardQuery('apply', responseKey)
  return true
}

/** latestOnly：响应键与当前 latestKeyRef 一致才允许写 UI */
export function shouldApplyLatestDashboardKey(
  latestKeyRef: { current: string },
  responseKey: string,
  endpoint?: DashboardEndpoint,
): boolean {
  if (latestKeyRef.current !== responseKey) {
    discardStaleDashboardResponse(responseKey, endpoint)
    return false
  }
  return true
}

/** 契约 API 端点（兼容 staging 残留模块，不参与 orders/order-volume soft 策略） */
export type DashboardEndpoint =
  | 'summary'
  | 'ranking'
  | 'product-ranking'
  | 'gmv-compare'
  | 'order-volume'
  | 'orders'

const inflightByKey = new Map<string, Promise<unknown>>()
const lastStartedAtByKey = new Map<string, number>()
const endpointScopeSoft = new Map<
  DashboardEndpoint,
  { latestKeyRef: { current: string }; abortRef: { current: AbortController | null } }
>()

function getEndpointScopeSoft(endpoint: DashboardEndpoint) {
  let scope = endpointScopeSoft.get(endpoint)
  if (!scope) {
    scope = { latestKeyRef: { current: '' }, abortRef: { current: null } }
    endpointScopeSoft.set(endpoint, scope)
  }
  return scope
}

/** 兼容：不调用 signal.abort()，仅释放引用，避免 signal is aborted */
export function abortDashboardEndpointQuery(endpoint: DashboardEndpoint): void {
  const scope = getEndpointScopeSoft(endpoint)
  logDashboardQuery('abort', scope.latestKeyRef.current || endpoint, `soft-${endpoint}`)
  scope.abortRef.current = null
}

/** 兼容：仅清理去重 map，不取消在途 fetch */
/** today 首屏：summary + ranking 强制重拉 */
export function clearLiveDashboardPrimaryInflight(): void {
  for (const ep of ['summary', 'ranking'] as const) {
    clearDashboardInflightDedupe(ep)
  }
}

/** 非首屏图表：product-ranking / gmv-compare / order-volume */
export function clearLiveDashboardSecondaryInflight(): void {
  for (const ep of ['product-ranking', 'order-volume', 'gmv-compare'] as const) {
    clearDashboardInflightDedupe(ep)
  }
}

/** @deprecated 优先用 primary/secondary 分拆，避免 orders-changed 打穿全部端点 */
export function clearLiveDashboardMetricsInflight(): void {
  clearLiveDashboardPrimaryInflight()
  clearLiveDashboardSecondaryInflight()
}

export function clearDashboardInflightDedupe(endpoint?: DashboardEndpoint): void {
  if (endpoint) {
    for (const key of [...inflightByKey.keys()]) {
      if (key.startsWith(`${endpoint}|`) || key.startsWith(`${endpoint}:`)) {
        inflightByKey.delete(key)
        lastStartedAtByKey.delete(key)
      }
    }
    return
  }
  inflightByKey.clear()
  lastStartedAtByKey.clear()
}

/** @deprecated orders 轮询见 ordersPollScheduler（10s 间隔 / 1s 去重） */
export const DASHBOARD_ORDERS_MIN_INTERVAL_MS = 1000

export function dashboardInflightKey(endpoint: DashboardEndpoint, filterKey: string): string {
  return `${endpoint}|${filterKey}`
}

export function logDashboardRequestFilter(
  kind: 'orders' | 'ranking',
  query: Record<string, string>,
): void {
  console.log(
    [
      `[${kind} request filter]`,
      `shopId=${query.shopId || 'all'}`,
      `market=${query.market || 'ALL'}`,
      `orderFilter=${query.orderFilter || 'all'}`,
      `timeRange=${query.timeRange || 'today'}`,
      `startDate=${query.startDate || ''}`,
      `endDate=${query.endDate || ''}`,
    ].join(' '),
  )
}

export function logSkipDuplicateRequest(
  filterKey: string,
  endpoint?: DashboardEndpoint,
  detail?: string,
): void {
  const ep = endpoint ? ` endpoint=${endpoint}` : ''
  const extra = detail ? ` ${detail}` : ''
  console.log(`[dashboard-query] skip duplicate request filterKey=${filterKey}${ep}${extra}`)
}

/** @deprecated 使用 logSkipDuplicateRequest */
export const logSkipDuplicateRequestFilterKey = logSkipDuplicateRequest

/**
 * 同一 endpoint + filterKey 在途只保留一个；可选最短发起间隔（orders 节流）。
 */
export async function runDashboardFetchOnce<T>(
  endpoint: DashboardEndpoint,
  filterKey: string,
  fn: () => Promise<T>,
  options?: { minIntervalMs?: number },
): Promise<T | undefined> {
  const fullKey = dashboardInflightKey(endpoint, filterKey)
  const now = Date.now()
  const minInterval = options?.minIntervalMs ?? 0
  const lastStarted = lastStartedAtByKey.get(fullKey) ?? 0
  if (minInterval > 0 && now - lastStarted < minInterval) {
    const existing = inflightByKey.get(fullKey)
    logSkipDuplicateRequest(filterKey, endpoint, `throttle=${minInterval}ms`)
    if (existing) return existing as Promise<T>
    return undefined
  }
  const existing = inflightByKey.get(fullKey)
  if (existing) {
    logSkipDuplicateRequest(filterKey, endpoint, 'inflight')
    return existing as Promise<T>
  }
  lastStartedAtByKey.set(fullKey, now)
  let promise!: Promise<T>
  promise = fn().finally(() => {
    if (inflightByKey.get(fullKey) === promise) {
      inflightByKey.delete(fullKey)
    }
  }) as Promise<T>
  inflightByKey.set(fullKey, promise)
  return promise
}
