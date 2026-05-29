import type { DashboardUiEndpoint } from './dashboardQueries'

export type DashboardUiSwitchLog = {
  reusedPrevious?: boolean
  keepPreviousData?: boolean
  chartRemounted?: boolean
  fetching?: boolean
  cacheHit?: boolean
  queryKey?: string
}

export function logDashboardUi(
  endpoint: DashboardUiEndpoint,
  meta: DashboardUiSwitchLog,
): void {
  console.log('[dashboard-ui]', endpoint, {
    reusedPrevious: Boolean(meta.reusedPrevious),
    keepPreviousData: meta.keepPreviousData !== false,
    chartRemounted: Boolean(meta.chartRemounted),
    fetching: Boolean(meta.fetching),
    cacheHit: Boolean(meta.cacheHit),
    ...(meta.queryKey ? { queryKey: meta.queryKey } : {}),
  })
}
