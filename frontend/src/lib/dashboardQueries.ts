import type { DashboardFilterContract } from './dashboardFilterContract'
import { contractStableQueryKey } from './dashboardFilterContract'

export type DashboardTrendEndpoint = 'gmv-compare' | 'order-volume'

/** 与后端 snapshot TTL 对齐（ms） */
export function dashboardSnapshotStaleTimeMs(timeRange: string | undefined): number {
  const tr = String(timeRange || 'today').trim().toLowerCase()
  if (tr === 'today') return 90_000
  if (tr === 'yesterday') return 300_000
  if (tr === 'last7') return 600_000
  if (tr === 'last30') return 1_800_000
  if (tr === 'custom') return 600_000
  return 600_000
}

/** keepPreviousData 语义下的 gcTime */
export const DASHBOARD_QUERY_GC_MS = 10 * 60 * 1000

export type DashboardQueryCacheEntry<T> = {
  data: T
  updatedAt: number
  queryKey: string
}

const queryCache = new Map<string, DashboardQueryCacheEntry<unknown>>()

function pruneQueryCache() {
  const cutoff = Date.now() - DASHBOARD_QUERY_GC_MS
  for (const [k, v] of queryCache) {
    if (v.updatedAt < cutoff) queryCache.delete(k)
  }
}

export function dashboardQueryKeyString(parts: readonly (string | number)[]): string {
  return parts.map((p) => String(p)).join('|')
}

/**
 * 稳定 queryKey（禁止每 render 新 object）
 * ['gmv-compare', tenantId, market, timeRange, orderFilter, shopId, groupBy?]
 */
export function buildGmvCompareQueryKey(
  contract: DashboardFilterContract,
  groupBy: 'hour' | 'day',
  tenantId?: number | null,
): readonly string[] {
  const tid = tenantId != null && Number.isFinite(tenantId) ? String(Math.floor(tenantId)) : 'none'
  return [
    'gmv-compare',
    tid,
    contract.market,
    contract.timeRange,
    contract.orderFilter,
    contract.shopId,
    contract.startDate,
    contract.endDate,
    groupBy,
  ]
}

export function buildOrderVolumeQueryKey(
  contract: DashboardFilterContract,
  tenantId?: number | null,
): readonly string[] {
  const tid = tenantId != null && Number.isFinite(tenantId) ? String(Math.floor(tenantId)) : 'none'
  return [
    'order-volume',
    tid,
    contract.market,
    contract.timeRange,
    contract.orderFilter,
    contract.shopId,
    contract.startDate,
    contract.endDate,
  ]
}

/** @deprecated 字符串键；新代码优先 tuple + dashboardQueryKeyString */
export function buildTrendQueryKeyFromContract(
  endpoint: DashboardTrendEndpoint,
  contract: DashboardFilterContract,
  extra?: string,
): string {
  const base = contractStableQueryKey(contract)
  return extra ? `${endpoint}|${base}|${extra}` : `${endpoint}|${base}`
}

export function getDashboardQueryCache<T>(queryKey: string): T | undefined {
  const e = queryCache.get(queryKey)
  if (!e) return undefined
  if (Date.now() - e.updatedAt > DASHBOARD_QUERY_GC_MS) {
    queryCache.delete(queryKey)
    return undefined
  }
  return e.data as T
}

export function setDashboardQueryCache<T>(queryKey: string, data: T): void {
  queryCache.set(queryKey, { data, updatedAt: Date.now(), queryKey })
  if (queryCache.size > 200) pruneQueryCache()
}

export function dashboardQueryKeepPreviousOptions(timeRange: string | undefined) {
  return {
    keepPreviousData: true as const,
    placeholderData: 'previousData' as const,
    staleTime: dashboardSnapshotStaleTimeMs(timeRange),
    gcTime: DASHBOARD_QUERY_GC_MS,
  }
}

export type DashboardUiEndpoint =
  | DashboardTrendEndpoint
  | 'summary'
  | 'ranking'
  | 'product-ranking'
