import type { AdminBadgeVariant } from '../components/admin'

export type HealthStatusCode = 'healthy' | 'warning' | 'error' | 'disabled'

export type HealthStatusMeta = {
  code: HealthStatusCode
  label: string
  variant: AdminBadgeVariant
  tooltip: string
}

const HEALTH_STATUS_META: Record<HealthStatusCode, Omit<HealthStatusMeta, 'code'>> = {
  healthy: { label: '正常', variant: 'success', tooltip: '状态健康' },
  warning: { label: '异常', variant: 'warning', tooltip: '存在告警，请关注' },
  error: { label: '错误', variant: 'danger', tooltip: '状态错误，需要处理' },
  disabled: { label: '停用', variant: 'neutral', tooltip: '该能力已停用' },
}

export function resolveHealthStatusMeta(raw: string | null | undefined): HealthStatusMeta {
  const normalized = String(raw || '').trim().toLowerCase() as HealthStatusCode
  if (normalized in HEALTH_STATUS_META) {
    return { code: normalized, ...HEALTH_STATUS_META[normalized] }
  }
  return {
    code: 'warning',
    label: String(raw || '异常'),
    variant: 'warning',
    tooltip: '未识别健康状态，按异常处理',
  }
}

export function resolveHealthMetaFromSyncLabel(label: string | null | undefined): HealthStatusMeta {
  const text = String(label || '').trim()
  if (!text || text === '—') return resolveHealthStatusMeta('disabled')
  if (text === '同步正常' || text === '授权正常' || text === '近24h无订单' || text === '今日无单') {
    return resolveHealthStatusMeta('healthy')
  }
  if (text === '同步中' || text === '未授权' || text === '同步超时' || text === '限流中') {
    return resolveHealthStatusMeta('warning')
  }
  if (text === '异常' || text === '授权失效') {
    return resolveHealthStatusMeta('error')
  }
  return resolveHealthStatusMeta('warning')
}
