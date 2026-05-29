import type { OperationLogItem, OperationLogStats } from '../../components/logs/types'
import { ApiClientError, apiGet } from './client'

export type { OperationLogItem, OperationLogStats }

export type OperationLogsListQuery = Record<string, string | number | undefined>

export type OperationLogsListResponse = {
  items: OperationLogItem[]
  total: number
  page?: number
  pageSize?: number
}

export type OperationLogDetailResponse = {
  item: OperationLogItem
}

export function operationLogsApiErrorMessage(e: unknown): string {
  if (e instanceof ApiClientError) {
    const code = String(e.body?.error || '').trim()
    if (e.status === 401) {
      if (code === 'missing_token') return '未携带登录凭证，请重新登录后再试'
      if (code === 'invalid_token' || code === 'invalid_token_payload') return '登录已失效，请重新登录'
      if (code === 'inactive_account') return '账号已停用，无法访问日志中心'
      return code ? `认证失败：${code}` : '认证失败，请重新登录'
    }
    if (e.status === 403) {
      return code ? `无权限：${code}` : '无权限访问操作日志'
    }
    const msg = String(e.body?.message || e.body?.error || '').trim()
    if (msg) return msg
    return `请求失败（HTTP ${e.status}）`
  }
  const msg = String((e as Error)?.message || e || '').trim()
  return msg || '加载日志失败，请稍后重试'
}

/** GET /api/operation-logs/stats */
export function fetchOperationLogStats(query?: OperationLogsListQuery): Promise<OperationLogStats> {
  return apiGet<OperationLogStats>('/api/operation-logs/stats', query)
}

/** GET /api/operation-logs */
export function fetchOperationLogs(query?: OperationLogsListQuery): Promise<OperationLogsListResponse> {
  return apiGet<OperationLogsListResponse>('/api/operation-logs', query)
}

/** GET /api/operation-logs/:id */
export function fetchOperationLogDetail(id: number): Promise<OperationLogDetailResponse> {
  return apiGet<OperationLogDetailResponse>(`/api/operation-logs/${id}`)
}
