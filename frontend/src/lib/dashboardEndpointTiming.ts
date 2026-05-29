import type { DashboardEndpoint } from './dashboardQueryGuard'

/** 筛选切换耗时对比（staging / ?debug=1 可看） */
export function logDashboardEndpointTiming(
  endpoint: DashboardEndpoint,
  dedupeKey: string,
  durationMs: number,
  extra?: Record<string, unknown>,
): void {
  /* console.info：便于 staging F12 / pm2 stdout 对比 all vs valid，不走 error 日志 */
  const parts = [
    '[dashboard-timing]',
    `endpoint=${endpoint}`,
    `durationMs=${Math.max(0, Math.round(durationMs))}`,
    `key=${dedupeKey}`,
  ]
  if (extra?.orderFilter != null) parts.push(`orderFilter=${String(extra.orderFilter)}`)
  console.info(parts.join(' '))
}

export async function withDashboardEndpointTiming<T>(
  endpoint: DashboardEndpoint,
  dedupeKey: string,
  extra: Record<string, unknown> | undefined,
  run: () => Promise<T>,
): Promise<T> {
  const t0 = performance.now()
  try {
    return await run()
  } finally {
    logDashboardEndpointTiming(endpoint, dedupeKey, performance.now() - t0, extra)
  }
}
