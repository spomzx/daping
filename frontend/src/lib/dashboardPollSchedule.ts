/**
 * Dashboard 前端轮询错峰时间表（Phase-1）
 * 0s summary | 10s orders | 20s ranking | 40s trend | 60s product-ranking
 */

export const DASHBOARD_POLL_ORDERS_MS = 10_000

export const DASHBOARD_POLL_SUMMARY_MS = 25_000
export const DASHBOARD_POLL_RANKING_MS = 30_000
export const DASHBOARD_POLL_PRODUCT_RANKING_MS = 60_000
export const DASHBOARD_POLL_TREND_MS = 90_000

/** 相对页面加载 / cycle 起点的相位偏移 */
export const DASHBOARD_STAGGER_SUMMARY_MS = 0
export const DASHBOARD_STAGGER_ORDERS_MS = 10_000
export const DASHBOARD_STAGGER_RANKING_MS = 20_000
export const DASHBOARD_STAGGER_TREND_MS = 40_000
export const DASHBOARD_STAGGER_PRODUCT_RANKING_MS = 60_000

/** orders-changed 联动刷新最短间隔（与后端 TTL 对齐，禁止 5s bypass 风暴） */
export const DASHBOARD_PRIMARY_METRICS_REFRESH_MIN_MS = 20_000
export const DASHBOARD_SECONDARY_METRICS_REFRESH_MIN_MS = 60_000

/** ranking 相对 summary 的错峰延迟（orders-changed 场景） */
export const DASHBOARD_RANKING_AFTER_PRIMARY_MS = 3_000

/**
 * 计算距下一次错峰 slot 的毫秒数（用于 setTimeout 链式轮询）
 */
export function msUntilNextStaggeredPoll(intervalMs: number, phaseMs: number, nowMs = Date.now()): number {
  const interval = Math.max(1000, Math.floor(intervalMs))
  const phase = ((Math.floor(phaseMs) % interval) + interval) % interval
  const elapsed = nowMs % interval
  if (elapsed <= phase) return phase - elapsed
  return interval - elapsed + phase
}

/**
 * 创建错峰轮询循环（返回 cleanup）
 */
export function scheduleStaggeredPoll(
  intervalMs: number,
  phaseMs: number,
  tick: () => void,
): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null
  let alive = true

  const loop = () => {
    if (!alive) return
    tick()
    const delay = msUntilNextStaggeredPoll(intervalMs, phaseMs)
    timer = setTimeout(loop, delay)
  }

  const initialDelay = msUntilNextStaggeredPoll(intervalMs, phaseMs)
  timer = setTimeout(loop, initialDelay)

  return () => {
    alive = false
    if (timer != null) clearTimeout(timer)
    timer = null
  }
}
