/** 同步中心 / 日志：仅辅助识别后端已下发的中文 status_label */

const ALLOWED = new Set([
  '同步正常',
  '同步中',
  '授权失效',
  '未授权',
  '限流中',
  '异常',
  '近24h无订单',
  '今日无单',
  '授权正常',
  '授权已过期',
  '缺少授权 Token',
  '同步超时',
])

export function isSyncRunningLabel(label: string | null | undefined): boolean {
  const s = String(label || '')
  return s.includes('同步中') || /running/i.test(s)
}

/** 同步中心店铺状态列：仅展示后端 status_label */
export function syncCenterStatusLabel(shop: { status_label?: string | null }): string {
  const label = String(shop.status_label ?? '').trim()
  return label || '—'
}

export function isSyncCenterRunning(shop: { status_label?: string | null }): boolean {
  return isSyncRunningLabel(syncCenterStatusLabel(shop))
}

/** 同步日志状态：优先后端已映射文案，禁止用 health/sync_stale 码转「异常」 */
export function resolveSyncLogDisplayLabel(status: string | null | undefined): string {
  const raw = String(status ?? '').trim()
  if (!raw) return '—'
  if (ALLOWED.has(raw)) return raw
  const key = raw.toLowerCase().replace(/\s+/g, '_')
  if (key === 'success' || key === 'normal') return '同步正常'
  if (key === 'running') return '同步中'
  if (key === 'failed') return '异常'
  if (key === 'rate_limited') return '限流中'
  return raw.slice(0, 120)
}
