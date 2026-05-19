import { apiGet, apiPost } from './client'

export type ImportCachePreviewResponse = {
  count?: number
  items?: unknown[]
}

export type ImportCacheResult = {
  scope?: string
  tenants?: unknown[]
  inserted?: number
  updated?: number
  skipped?: number
  skipped_max_shops?: number
  scanned?: number
  tenant_id?: number
  max_shops?: number
  _deprecated?: boolean
  _use_instead?: string
}

export type OrdersCachePathsResponse = {
  orders_cache_path?: string
  storage_dir?: string
  process_cwd?: string
  ops_only?: boolean
  legacy_cache?: boolean
  [key: string]: unknown
}

export type OrdersCacheRebuildResponse = {
  rebuild?: Record<string, unknown>
  reconcile?: unknown
  paths?: Record<string, unknown>
  meta?: Record<string, unknown>
  _deprecated?: boolean
  _use_instead?: string
}

function importCacheQuery(opts?: { scope?: 'all'; tenantId?: string }) {
  const params = new URLSearchParams()
  if (opts?.scope === 'all') params.set('scope', 'all')
  else if (opts?.tenantId) params.set('tenant_id', opts.tenantId)
  const qs = params.toString()
  return qs ? `?${qs}` : ''
}

/** Ops：预览 legacy cache 可导入店铺（平台管理员） */
export async function previewImportCache() {
  return apiGet<ImportCachePreviewResponse>('/api/ops/import-cache/preview')
}

/** Ops：从 cache/json 导入 MySQL（平台管理员） */
export async function runImportCache(opts?: { scope?: 'all'; tenantId?: string }) {
  return apiPost<ImportCacheResult>(`/api/ops/import-cache${importCacheQuery(opts)}`, {
    cache: 'no-store',
  })
}

/** Ops：orders-cache vs MySQL 对账（平台管理员） */
export async function runOrdersReconcile(hours?: number) {
  return apiGet<unknown>(
    '/api/ops/orders/reconcile',
    hours != null && Number.isFinite(hours) && hours > 0 ? { hours } : undefined,
  )
}

/** Ops：从 MySQL 重建 orders-cache.json（平台管理员） */
export async function rebuildOrdersCache(hours?: number) {
  const qs =
    hours != null && Number.isFinite(hours) && hours > 0
      ? `?${new URLSearchParams({ hours: String(hours) }).toString()}`
      : ''
  return apiPost<OrdersCacheRebuildResponse>(`/api/ops/orders/rebuild-cache${qs}`, {
    cache: 'no-store',
  })
}

/** Ops：cache 文件路径诊断（平台管理员） */
export async function getCachePaths() {
  return apiGet<OrdersCachePathsResponse>('/api/ops/orders/cache-paths')
}
