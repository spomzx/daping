import { useSyncExternalStore } from 'react'

export type DashboardRange = 'today' | '7d' | '30d'
export type DashboardOrderFilter = 'all' | 'valid' | 'unpaid' | 'sample' | 'cancelled'

export type DashboardQueryState = {
  market: string
  range: DashboardRange
  orderFilter: DashboardOrderFilter
  shopId: string
  timezone: string
  timeWindow: string
  lastUpdatedAt: string
}

type DashboardQueryPatch = Partial<DashboardQueryState>

const QUERY_FIELDS: (keyof DashboardQueryState)[] = [
  'market',
  'range',
  'orderFilter',
  'shopId',
  'timezone',
  'timeWindow',
]

const state: DashboardQueryState = {
  market: 'ALL',
  range: 'today',
  orderFilter: 'all',
  shopId: 'all',
  timezone: 'UTC',
  timeWindow: 'today',
  lastUpdatedAt: new Date().toISOString(),
}

/** useSyncExternalStore 需要稳定引用，避免每次 getSnapshot 都触发重渲染 */
let snapshot: DashboardQueryState = { ...state }

const listeners = new Set<() => void>()

function refreshSnapshot(): void {
  snapshot = { ...state }
}

function emit(): void {
  refreshSnapshot()
  listeners.forEach((listener) => listener())
}

function normalizePatch(patch: DashboardQueryPatch): DashboardQueryPatch {
  const out: DashboardQueryPatch = { ...patch }
  if (out.market != null) {
    const m = String(out.market).trim().toUpperCase()
    out.market = m || 'ALL'
  }
  if (out.shopId != null) {
    const sid = String(out.shopId).trim()
    out.shopId = sid || 'all'
  }
  if (out.range != null) {
    const r = String(out.range).trim().toLowerCase()
    out.range = r === '7d' || r === '30d' ? (r as DashboardRange) : 'today'
  }
  if (out.orderFilter != null) {
    const f = String(out.orderFilter).trim().toLowerCase()
    out.orderFilter =
      f === 'valid' || f === 'unpaid' || f === 'sample' || f === 'cancelled'
        ? (f as DashboardOrderFilter)
        : 'all'
  }
  if (out.timezone != null) {
    out.timezone = String(out.timezone).trim() || 'UTC'
  }
  if (out.timeWindow != null) {
    out.timeWindow = String(out.timeWindow).trim() || out.range || state.range
  }
  return out
}

function queryFieldsEqual(next: DashboardQueryState, prev: DashboardQueryState): boolean {
  for (const key of QUERY_FIELDS) {
    if (next[key] !== prev[key]) return false
  }
  return true
}

export function getDashboardQueryState(): DashboardQueryState {
  return snapshot
}

export function setDashboardQueryState(patch: DashboardQueryPatch): void {
  const normalized = normalizePatch(patch)
  const next: DashboardQueryState = { ...state, ...normalized }
  if (queryFieldsEqual(next, state)) return
  Object.assign(state, normalized)
  state.lastUpdatedAt = new Date().toISOString()
  emit()
}

export function subscribeDashboardQuery(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useDashboardQueryStore(): DashboardQueryState {
  return useSyncExternalStore(subscribeDashboardQuery, getDashboardQueryState, getDashboardQueryState)
}

export type DashboardQueryParams = {
  market?: string
  shop_id?: string
  range: DashboardRange
  timeRange: DashboardRange
  orderFilter: DashboardOrderFilter
  status: DashboardOrderFilter
  hours: '24' | '168' | '720'
  timezone: string
}

function rangeToHours(range: DashboardRange): '24' | '168' | '720' {
  if (range === '7d') return '168'
  if (range === '30d') return '720'
  return '24'
}

/** Legacy `dashboardFilters` 含 `paid`；写入 Query Store 时与 valid 对齐 */
export function orderFilterFromLegacy(filter: string): DashboardOrderFilter {
  const f = String(filter).trim().toLowerCase()
  if (f === 'paid') return 'valid'
  if (f === 'valid' || f === 'unpaid' || f === 'sample' || f === 'cancelled' || f === 'all') {
    return f
  }
  return 'all'
}

export function buildDashboardQueryParams(
  source: DashboardQueryState,
  extra?: Record<string, string | undefined>,
): Record<string, string> {
  const q: DashboardQueryParams = {
    range: source.range,
    timeRange: source.range,
    orderFilter: source.orderFilter,
    status: source.orderFilter,
    hours: rangeToHours(source.range),
    timezone: source.timezone || 'UTC',
    ...(source.market !== 'ALL' ? { market: source.market } : {}),
    ...(source.shopId !== 'all' ? { shop_id: source.shopId } : {}),
  }
  const merged: Record<string, string> = {}
  for (const [k, v] of Object.entries({ ...q, ...(extra || {}) })) {
    if (v == null || String(v) === '') continue
    merged[k] = String(v)
  }
  return merged
}
