import type { AdminBadgeVariant } from '../components/admin'

export type SyncStatusCode = 'queued' | 'running' | 'retry_wait' | 'success' | 'failed'

export type SyncStatusMeta = {
  code: SyncStatusCode
  label: string
  variant: AdminBadgeVariant
  tooltip: string
}

const SYNC_STATUS_META: Record<SyncStatusCode, Omit<SyncStatusMeta, 'code'>> = {
  queued: { label: '排队中', variant: 'info', tooltip: '任务已入队，等待执行' },
  running: { label: '同步中', variant: 'processing', tooltip: '任务正在执行同步' },
  retry_wait: { label: '等待重试', variant: 'warning', tooltip: '任务失败后进入等待重试窗口' },
  success: { label: '成功', variant: 'success', tooltip: '同步任务已成功完成' },
  failed: { label: '失败', variant: 'danger', tooltip: '同步任务执行失败，请查看错误信息' },
}

export function resolveSyncStatusMeta(raw: string | null | undefined): SyncStatusMeta {
  const normalized = String(raw || '').trim().toLowerCase() as SyncStatusCode
  if (normalized in SYNC_STATUS_META) {
    return { code: normalized, ...SYNC_STATUS_META[normalized] }
  }
  return {
    code: 'failed',
    label: String(raw || '失败'),
    variant: 'danger',
    tooltip: '未识别状态，按失败处理',
  }
}
