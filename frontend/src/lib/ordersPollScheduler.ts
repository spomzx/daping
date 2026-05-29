/**
 * 实时 orders 唯一调度入口（模块级单例）
 * - 全项目 dashboard /orders 自动轮询只能经此文件发起
 * - 同 canonical filterKey：10s 内不重复；在途不重复
 * - filter 变更：立即 1 次 + suspend 自动轮询 10s
 */

import { buildDashboardApiQuery } from './dashboardFilterContract'
import type { DashboardFilterState } from './dashboardFilters'
import {
  DASHBOARD_PRIMARY_METRICS_REFRESH_MIN_MS,
  DASHBOARD_SECONDARY_METRICS_REFRESH_MIN_MS,
} from './dashboardPollSchedule'

export const ORDERS_POLL_INTERVAL_MS = 10_000
export const ORDERS_FILTER_SUSPEND_MS = 10_000
/** orders-changed → summary/ranking 强制刷新最短间隔 */
export { DASHBOARD_PRIMARY_METRICS_REFRESH_MIN_MS, DASHBOARD_SECONDARY_METRICS_REFRESH_MIN_MS }
/** @deprecated 使用 DASHBOARD_PRIMARY_METRICS_REFRESH_MIN_MS */
export const DASHBOARD_METRICS_REFRESH_MIN_MS = DASHBOARD_PRIMARY_METRICS_REFRESH_MIN_MS

export type OrdersFetchSource = 'filter' | 'poll'

export function buildOrdersCanonicalKey(
  resolvedShopId: string,
  filters: Pick<
    DashboardFilterState,
    'marketRegion' | 'orderFilter' | 'timeRange' | 'customStart' | 'customEnd'
  >,
): string {
  const q = buildDashboardApiQuery(
    {
      shopId: 'all',
      marketRegion: filters.marketRegion,
      orderFilter: filters.orderFilter,
      timeRange: filters.timeRange,
      customStart: filters.customStart,
      customEnd: filters.customEnd,
      baseCurrency: 'USD',
      targetCurrency: 'USD',
    },
    [],
    { limit: '50' },
    resolvedShopId,
  )
  return [
    `shopId=${q.shopId || 'all'}`,
    `market=${q.market || 'ALL'}`,
    `orderFilter=${q.orderFilter || 'all'}`,
    `timeRange=${q.timeRange || 'today'}`,
    `startDate=${q.startDate || ''}`,
    `endDate=${q.endDate || ''}`,
  ].join('|')
}

export function logOrdersRequest(source: OrdersFetchSource, filterKey: string): void {
  console.log(`[orders] request source=${source} filterKey=${filterKey}`)
}

export function logOrdersSkipped(reason: string, filterKey: string): void {
  console.log(`[orders] request skipped reason=${reason} filterKey=${filterKey}`)
}

/** @deprecated */
export function logOrdersPollSkipped(reason: string, filterKey: string): void {
  logOrdersSkipped(reason, filterKey)
}

let activeCanonicalKey = ''
let lastFetchStartedAt = 0
let pollSuspendUntilMs = 0
let inflightCanonicalKey = ''
let inflightPromise: Promise<unknown> | null = null
let pollTimer: ReturnType<typeof setTimeout> | null = null
let panelBound = false
let lastPrimaryMetricsRefreshAt = 0
let lastSecondaryMetricsRefreshAt = 0
let lastOrdersMetricsSignature = ''

export type DashboardMetricsRefreshMeta = {
  primaryDue: boolean
  secondaryDue: boolean
}

type DashboardMetricsRefreshListener = (
  reason: string,
  filterKey: string,
  meta: DashboardMetricsRefreshMeta,
) => void
const metricsRefreshListeners = new Set<DashboardMetricsRefreshListener>()

export function subscribeDashboardMetricsRefresh(listener: DashboardMetricsRefreshListener): () => void {
  metricsRefreshListeners.add(listener)
  return () => {
    metricsRefreshListeners.delete(listener)
  }
}

function buildOrdersMetricsSignature(rowCount: number, orderIds: string[]): string {
  const head = orderIds.slice(0, 3).join(',')
  const tail = orderIds.length > 3 ? orderIds.slice(-2).join(',') : ''
  return `${rowCount}|${head}|${tail}`
}

/**
 * orders 轮询检测到列表/订单数变化 → 联动刷新 summary / ranking / trend 等
 */
export function notifyDashboardOrdersMetricsChanged(
  reason: string,
  filterKey: string,
  meta?: { rowCount?: number; orderIds?: string[]; force?: boolean },
): void {
  const ids = meta?.orderIds ?? []
  const sig = buildOrdersMetricsSignature(meta?.rowCount ?? ids.length, ids)
  const signatureChanged = sig !== lastOrdersMetricsSignature
  if (!meta?.force && !signatureChanged) return
  if (!meta?.force && lastOrdersMetricsSignature === '') {
    lastOrdersMetricsSignature = sig
    return
  }
  lastOrdersMetricsSignature = sig

  const now = Date.now()
  const primaryDue =
    meta?.force || now - lastPrimaryMetricsRefreshAt >= DASHBOARD_PRIMARY_METRICS_REFRESH_MIN_MS
  const secondaryDue =
    meta?.force || now - lastSecondaryMetricsRefreshAt >= DASHBOARD_SECONDARY_METRICS_REFRESH_MIN_MS
  if (!primaryDue && !secondaryDue) return
  if (primaryDue) lastPrimaryMetricsRefreshAt = now
  if (secondaryDue) lastSecondaryMetricsRefreshAt = now

  if (reason === 'orders-changed' && primaryDue) {
    console.log(`ranking refresh reason=orders-changed`)
  }
  for (const listener of metricsRefreshListeners) {
    try {
      listener(reason, filterKey, { primaryDue, secondaryDue })
    } catch {
      /* ignore */
    }
  }
}

type OrdersPanelBinding<T> = {
  filterKey: string
  fetchFn: () => Promise<T>
  onData: (rows: T) => void
  onError?: (err: unknown) => void
}

function clearPollTimer(): void {
  if (pollTimer != null) {
    window.clearTimeout(pollTimer)
    pollTimer = null
  }
}

export function mergeOrdersPollSuspendUntil(externalUntilMs: number): void {
  if (externalUntilMs > pollSuspendUntilMs) pollSuspendUntilMs = externalUntilMs
}

export function suspendOrdersPollAfterFilterChange(untilMs?: number): void {
  pollSuspendUntilMs = Math.max(pollSuspendUntilMs, untilMs ?? Date.now() + ORDERS_FILTER_SUSPEND_MS)
}

export function msUntilNextOrdersPollAllowed(): number {
  const now = Date.now()
  const afterSuspend = Math.max(0, pollSuspendUntilMs - now)
  if (lastFetchStartedAt <= 0) {
    return Math.max(afterSuspend, ORDERS_POLL_INTERVAL_MS)
  }
  const afterInterval = Math.max(0, ORDERS_POLL_INTERVAL_MS - (now - lastFetchStartedAt))
  return Math.max(afterSuspend, afterInterval)
}

function shouldSkipPoll(canonicalKey: string): string | null {
  const now = Date.now()
  if (typeof document !== 'undefined' && document.hidden) return 'page-hidden'
  if (now < pollSuspendUntilMs) return 'poll-suspended-after-filter'
  if (now - lastFetchStartedAt < ORDERS_POLL_INTERVAL_MS) return 'duplicate'
  if (inflightCanonicalKey === canonicalKey && inflightPromise) return 'duplicate'
  return null
}

function shouldSkipFilter(canonicalKey: string): string | null {
  const now = Date.now()
  const keyChanged = canonicalKey !== activeCanonicalKey
  if (!keyChanged && now - lastFetchStartedAt < ORDERS_POLL_INTERVAL_MS) return 'duplicate'
  if (inflightCanonicalKey === canonicalKey && inflightPromise) return 'duplicate'
  return null
}

async function executeOrdersFetch<T>(
  canonicalKey: string,
  source: OrdersFetchSource,
  fetchFn: () => Promise<T>,
): Promise<T | undefined> {
  if (inflightCanonicalKey === canonicalKey && inflightPromise) {
    logOrdersSkipped('duplicate', canonicalKey)
    return inflightPromise as Promise<T>
  }

  const skip = source === 'filter' ? shouldSkipFilter(canonicalKey) : shouldSkipPoll(canonicalKey)
  if (skip) {
    logOrdersSkipped(skip, canonicalKey)
    return undefined
  }

  if (source === 'filter') {
    activeCanonicalKey = canonicalKey
    pollSuspendUntilMs = Date.now() + ORDERS_FILTER_SUSPEND_MS
  }

  logOrdersRequest(source, canonicalKey)
  lastFetchStartedAt = Date.now()
  inflightCanonicalKey = canonicalKey

  let promise!: Promise<T>
  promise = fetchFn().finally(() => {
    if (inflightCanonicalKey === canonicalKey && inflightPromise === promise) {
      inflightCanonicalKey = ''
      inflightPromise = null
    }
  }) as Promise<T>
  inflightPromise = promise
  return promise
}

function schedulePollLoop<T>(binding: OrdersPanelBinding<T>): void {
  clearPollTimer()
  const delay = msUntilNextOrdersPollAllowed()
  pollTimer = window.setTimeout(() => {
    pollTimer = null
    void (async () => {
      if (!panelBound) return
      const result = await executeOrdersFetch(binding.filterKey, 'poll', binding.fetchFn)
      if (result !== undefined) {
        try {
          binding.onData(result)
        } catch (e) {
          binding.onError?.(e)
        }
      }
      if (panelBound) schedulePollLoop(binding)
    })()
  }, delay)
}

/**
 * 绑定实时订单面板：唯一 filter 触发 + 唯一 poll 循环（禁止组件内第二套 setInterval / filter effect fetch）
 */
export function bindOrdersPanel<T>(binding: OrdersPanelBinding<T>): () => void {
  panelBound = true
  const runFilter = () => {
    void (async () => {
      const result = await executeOrdersFetch(binding.filterKey, 'filter', binding.fetchFn)
      if (result !== undefined) {
        try {
          binding.onData(result)
        } catch (e) {
          binding.onError?.(e)
        }
      }
      if (panelBound) schedulePollLoop(binding)
    })()
  }

  runFilter()

  return () => {
    panelBound = false
    clearPollTimer()
  }
}

/** @deprecated 请使用 bindOrdersPanel；保留兼容 */
export async function runOrdersPollFetch<T>(
  filterKey: string,
  source: OrdersFetchSource,
  fn: () => Promise<T>,
): Promise<T | undefined> {
  return executeOrdersFetch(filterKey, source, fn)
}
