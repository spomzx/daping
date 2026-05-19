/** 与 backend/modules/sync/saasSyncLabels + syncApiMessages 对齐 */
const STATUS_MAP: Record<string, string> = {
  rate_limited: '限流中',
  token_missing: '未授权',
  missing: '未授权',
  expired: '授权失效',
  no_orders_today: '近24h无订单',
  no_orders_24h: '近24h无订单',
  normal: '同步正常',
  success: '同步正常',
  order_cache_pending: '同步正常',
  unknown: '异常',
  failed: '异常',
  sync_stale: '异常',
  sync_error: '异常',
  running: '同步中',
  sync_timeout: '同步超时',
  partial_success: '异常',
  shop_not_found_or_not_eligible: '店铺不存在或未启用同步',
  storage_lock_timeout: '同步任务正在执行中，请稍后查看',
  missing_shop_cipher: '缺少店铺授权信息',
  missing_token: '缺少授权 Token',
}

const ALLOWED = new Set([
  '同步正常',
  '同步中',
  '授权失效',
  '未授权',
  '限流中',
  '异常',
  '近24h无订单',
  '授权正常',
  '授权已过期',
  '缺少授权 Token',
  '同步超时',
])

export function mapSyncStatusLabelClient(code: string | null | undefined): string {
  if (!code) return '同步正常'
  const raw = String(code).trim()
  if (ALLOWED.has(raw)) return raw
  const key = raw.toLowerCase().replace(/\s+/g, '_')
  return STATUS_MAP[key] || '异常'
}

export function mapSyncErrorLabelClient(code: string | null | undefined): string {
  if (!code) return '—'
  const raw = String(code).trim()
  if (raw === 'rate_limited' || /rate.?limit/i.test(raw)) {
    return '同步频率过高，请稍后重试'
  }
  if (STATUS_MAP[raw.toLowerCase().replace(/\s+/g, '_')]) {
    return STATUS_MAP[raw.toLowerCase().replace(/\s+/g, '_')]
  }
  if (ALLOWED.has(raw)) return raw
  const key = raw.toLowerCase().replace(/\s+/g, '_')
  if (STATUS_MAP[key]) return STATUS_MAP[key]
  if (/^[a-z][a-z0-9_]*$/i.test(raw) && raw.includes('_')) {
    return '同步失败，请稍后重试'
  }
  return raw.slice(0, 120)
}

export function isSyncRunningLabel(label: string | null | undefined): boolean {
  const s = String(label || '')
  return s.includes('同步中') || /running/i.test(s)
}

const SYNC_STALE_MS = 3 * 60 * 1000

const AUTH_LOG_NOISE_RE = /缺少|missing|token_missing|未授权|授权失效|缺少授权/i

function parseSyncTs(v: string | null | undefined): number | null {
  if (v == null || v === '') return null
  const t = Date.parse(String(v))
  return Number.isFinite(t) ? t : null
}

export function isSyncLogOk(status: string | null | undefined): boolean {
  const s = String(status || '').toLowerCase()
  return s === 'success' || s === 'partial_success'
}

/** 店铺同步状态展示（前端兜底：卡住「同步中」、日志成功则正常） */
export function resolveShopSyncDisplayLabel(
  shop: {
    status_label?: string
    last_log_status?: string | null
    last_health_status?: string
    last_sync_at?: string | null
    last_finished_at?: string | null
    token_status?: string
  },
  latestLog?: { status?: string; created_at?: string } | null,
): string {
  const ts = String(shop.token_status || '').toLowerCase()
  if (ts === 'missing') return '未授权'
  if (ts === 'expired') return '授权失效'

  const raw =
    shop.status_label ||
    mapSyncStatusLabelClient(shop.last_log_status || shop.last_health_status) ||
    '同步正常'

  if (latestLog && isSyncLogOk(latestLog.status)) {
    const running =
      isSyncRunningLabel(raw) ||
      isSyncRunningLabel(shop.last_log_status) ||
      String(shop.last_log_status || '').toLowerCase() === 'running'
    if (running) return '同步正常'
  }

  const running =
    isSyncRunningLabel(raw) ||
    isSyncRunningLabel(shop.last_log_status) ||
    String(shop.last_log_status || '').toLowerCase() === 'running'

  if (running) {
    const anchor =
      parseSyncTs(shop.last_sync_at) ??
      parseSyncTs(shop.last_finished_at) ??
      parseSyncTs(latestLog?.created_at)
    if (anchor != null && Date.now() - anchor > SYNC_STALE_MS) {
      if (latestLog && isSyncLogOk(latestLog.status)) return '同步正常'
      return '同步超时'
    }
  }

  return raw
}

/** 同步日志状态列：过滤「缺少…」类残留文案 */
export function resolveSyncLogDisplayLabel(status: string | null | undefined): string {
  const mapped = mapSyncStatusLabelClient(status)
  if (AUTH_LOG_NOISE_RE.test(mapped)) {
    return isSyncLogOk(status) ? '同步正常' : '异常'
  }
  if (mapped === '同步中') {
    return '同步正常'
  }
  return mapped
}
