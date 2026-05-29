/** 趋势图缓存提示（gmv-compare meta / order-volume debug） */
export type DashboardTrendCacheHints = {
  cacheSource?: string
  stale?: boolean
  refreshPending?: boolean
  cacheMiss?: boolean
  reason?: string
  seriesPending?: boolean
  seriesEmpty?: boolean
}

const TREND_REFRESH_RETRY_MS_MIN = 3000
const TREND_REFRESH_RETRY_MS_MAX = 5000

export function trendRefreshRetryDelayMs(): number {
  return (
    TREND_REFRESH_RETRY_MS_MIN +
    Math.floor(Math.random() * (TREND_REFRESH_RETRY_MS_MAX - TREND_REFRESH_RETRY_MS_MIN + 1))
  )
}

export function readTrendCacheHints(
  meta?: Record<string, unknown> | null,
  debug?: Record<string, unknown> | null,
): DashboardTrendCacheHints {
  const m = meta && typeof meta === 'object' ? meta : {}
  const d = debug && typeof debug === 'object' ? debug : {}
  return {
    cacheSource:
      (typeof m.cacheSource === 'string' && m.cacheSource) ||
      (typeof d.cacheSource === 'string' && d.cacheSource) ||
      undefined,
    stale: m.stale === true || d.stale === true,
    refreshPending: m.refreshPending === true || d.refreshPending === true,
    cacheMiss: m.cacheMiss === true || d.cacheMiss === true,
    reason:
      (typeof m.reason === 'string' && m.reason) ||
      (typeof d.reason === 'string' && d.reason) ||
      undefined,
    seriesPending: m.seriesPending === true,
    seriesEmpty: m.seriesEmpty === true,
  }
}

/** refreshPending 或 pending 源：后台仍在加载 */
export function isTrendChartPending(hints: DashboardTrendCacheHints): boolean {
  if (hints.refreshPending) return true
  if (hints.seriesPending) return true
  const src = String(hints.cacheSource || '').toLowerCase()
  return src === 'pending'
}

/** 仅数据库确认无趋势数据时才允许清空图表 */
export function isTrendChartConfirmedEmpty(
  hints: DashboardTrendCacheHints,
  pointCount: number,
): boolean {
  if (pointCount > 0) return false
  if (isTrendChartPending(hints)) return false
  if (hints.reason === 'no_trend_data') return true
  const src = String(hints.cacheSource || '').toLowerCase()
  return src === 'db-empty'
}

/** pending / refreshPending 且本次无点：保留上一帧，不写入 display */
export function shouldRetainTrendDisplay(
  hints: DashboardTrendCacheHints,
  pointCount: number,
): boolean {
  if (pointCount > 0) return false
  if (isTrendChartConfirmedEmpty(hints, pointCount)) return false
  const src = String(hints.cacheSource || '').toLowerCase()
  if (src === 'snapshot' || src === 'snapshot-stale') return false
  if (hints.cacheMiss || src === 'cache-miss') return true
  if (src === 'pending') return true
  if (hints.refreshPending) return true
  return isTrendChartPending(hints)
}

export function isSnapshotCacheSource(hints: DashboardTrendCacheHints): boolean {
  const src = String(hints.cacheSource || '').toLowerCase()
  return src === 'snapshot' || src === 'snapshot-stale'
}

/**
 * 切换筛选时：fetching 且无新点则保留 previousStableDataRef，禁止写入空数据
 */
export function applyStableTrendPayload<T>(
  previousStableRef: { current: T | null },
  incoming: T | null | undefined,
  pointCount: number,
  hints: DashboardTrendCacheHints,
  opts?: { allowEmptyReplace?: boolean },
): { display: T | null; replaced: boolean; retainedPrevious: boolean } {
  const prev = previousStableRef.current
  if (incoming == null) {
    return { display: prev, replaced: false, retainedPrevious: Boolean(prev) }
  }
  if (pointCount > 0) {
    previousStableRef.current = incoming
    return { display: incoming, replaced: true, retainedPrevious: false }
  }
  if (shouldRetainTrendDisplay(hints, pointCount) && prev != null) {
    return { display: prev, replaced: false, retainedPrevious: true }
  }
  if (isTrendChartConfirmedEmpty(hints, pointCount) || opts?.allowEmptyReplace) {
    previousStableRef.current = incoming
    return { display: incoming, replaced: true, retainedPrevious: false }
  }
  if (prev != null) {
    return { display: prev, replaced: false, retainedPrevious: true }
  }
  previousStableRef.current = incoming
  return { display: incoming, replaced: true, retainedPrevious: false }
}
