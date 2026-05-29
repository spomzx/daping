import type { DashboardOrderFilter } from './dashboardFilters'
import {
  abortDashboardEndpointQuery,
  clearDashboardInflightDedupe,
  type DashboardEndpoint,
} from './dashboardQueryGuard'

const DASHBOARD_ENDPOINTS: DashboardEndpoint[] = [
  'summary',
  'ranking',
  'product-ranking',
  'gmv-compare',
  'order-volume',
  'orders',
]

/** 进程内：当前大屏唯一生效的 orderFilter（子组件只读） */
export const activeOrderFilterRef: { current: DashboardOrderFilter } = { current: 'all' }

let filterGeneration = 0

export function getDashboardFilterGeneration(): number {
  return filterGeneration
}

/**
 * orderFilter 切换：中止各 endpoint 旧请求、清空 dedupe，防止多 filter 并行污染 UI。
 */
export function resetDashboardQueriesForOrderFilter(next: DashboardOrderFilter): number {
  activeOrderFilterRef.current = next
  filterGeneration += 1
  for (const ep of DASHBOARD_ENDPOINTS) {
    abortDashboardEndpointQuery(ep)
  }
  clearDashboardInflightDedupe()
  return filterGeneration
}

export function shouldApplyDashboardFilterGeneration(gen: number): boolean {
  return gen === filterGeneration
}
