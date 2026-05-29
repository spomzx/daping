import type { OperationLogItem } from '../components/logs/types'

/** 操作动作 → 中文（未知动作回退为原始 code） */
const ACTION_LABELS: Record<string, string> = {
  login_success: '登录成功',
  login_failed: '登录失败',
  refresh_health: '刷新店铺健康状态',
  create_user: '创建用户',
  delete_user: '删除用户',
  update_user: '修改用户',
  update_user_status: '修改用户状态',
  create_tenant: '创建租户',
  update_tenant: '修改租户',
  update_tenant_plan: '修改租户套餐',
  disable_shop: '禁用店铺',
  enable_shop: '启用店铺',
  sync_shop: '同步店铺',
  manual_sync: '手动同步店铺',
  sync_retry: '同步重试',
  token_refresh: '刷新授权 Token',
  sync_failed: '同步失败',
  shop_create: '创建店铺',
  shop_delete_soft: '删除店铺',
  import_cache: '导入店铺缓存',
  disable_sync: '禁用店铺同步',
  enable_sync: '启用店铺同步',
  update_shop: '修改店铺',
  update_sort: '调整店铺排序',
}

/** 模块 → 中文 */
const MODULE_LABELS: Record<string, string> = {
  auth: '登录认证',
  users: '用户管理',
  tenants: '租户管理',
  shops: '店铺管理',
  sync: '同步中心',
  'operation-logs': '日志中心',
  analytics: '数据分析',
  orders: '订单中心',
}

const STATUS_LABELS: Record<string, string> = {
  success: '成功',
  failed: '失败',
}

export const LOG_MODULE_FILTER_OPTIONS = [
  { value: '', label: '全部模块' },
  { value: 'auth', label: '登录认证' },
  { value: 'users', label: '用户管理' },
  { value: 'tenants', label: '租户管理' },
  { value: 'shops', label: '店铺管理' },
  { value: 'sync', label: '同步中心' },
] as const

export function formatModuleLabel(module: string | null | undefined): string {
  const key = String(module || '').trim()
  if (!key) return '—'
  return MODULE_LABELS[key] ?? key
}

export function formatActionLabel(action: string | null | undefined): {
  label: string
  isKnown: boolean
  raw: string
} {
  const raw = String(action || '').trim()
  if (!raw) return { label: '—', isKnown: true, raw: '' }
  const label = ACTION_LABELS[raw]
  if (label) return { label, isKnown: true, raw }
  return { label: raw, isKnown: false, raw }
}

export function formatStatusLabel(status: string | null | undefined): string {
  const key = String(status || '').trim().toLowerCase()
  if (!key) return '—'
  return STATUS_LABELS[key] ?? status ?? '—'
}

export function statusBadgeClass(status: string | null | undefined): string {
  return String(status || '').toLowerCase() === 'failed'
    ? 'saas-badge saas-badge--danger'
    : 'saas-badge saas-badge--success'
}

function pickTargetName(row: OperationLogItem): string | null {
  const r = row as OperationLogItem & { target_name?: string | null }
  if (r.target_name && String(r.target_name).trim()) return String(r.target_name).trim()
  const detail = row.detail_json
  if (detail && typeof detail === 'object' && !Array.isArray(detail)) {
    const d = detail as Record<string, unknown>
    if (d.target_name != null && String(d.target_name).trim()) return String(d.target_name).trim()
    const shop = d.shop as Record<string, unknown> | undefined
    if (shop?.shop_name) return String(shop.shop_name)
    if (shop?.display_name) return String(shop.display_name)
  }
  const after = row.after_data
  if (after && typeof after === 'object' && !Array.isArray(after)) {
    const a = after as Record<string, unknown>
    const shop = a.shop as Record<string, unknown> | undefined
    if (shop?.shop_name) return String(shop.shop_name)
    if (shop?.display_name) return String(shop.display_name)
  }
  return null
}

function normalizeTargetTypeId(
  targetType: string | null | undefined,
  targetId: string | number | null | undefined,
): { type: string; id: string } {
  let type = String(targetType || '').trim().toLowerCase()
  let id = String(targetId || '').trim()
  if (!type && id.includes(':')) {
    const idx = id.indexOf(':')
    type = id.slice(0, idx).toLowerCase()
    id = id.slice(idx + 1)
  }
  return { type, id }
}

/** 操作对象展示（优先 target_name） */
export function formatTargetLabel(row: OperationLogItem): string {
  const name = pickTargetName(row)
  const { type, id } = normalizeTargetTypeId(row.target_type, row.target_id)
  if (name) {
    if (type === 'user') return `用户：${name}`
    if (type === 'tenant') return `租户：${name}`
    if (type === 'shop') return `店铺：${name}`
    if (type === 'order') return `订单：${name}`
    return name
  }
  if (!type && !id) return '—'
  switch (type) {
    case 'user':
      return id ? `用户 ID：${id}` : '用户'
    case 'tenant':
      return id ? `租户 ID：${id}` : '租户'
    case 'shop':
      return id ? `店铺：${id}` : '店铺'
    case 'order':
      return id ? `订单：${id}` : '订单'
    default:
      if (type && id) return `${type}：${id}`
      return id || type || '—'
  }
}

export function formatRoleLabel(role: string | null | undefined): string {
  const r = String(role || '').trim()
  const map: Record<string, string> = {
    super_admin: '平台超管',
    admin: '管理员',
    tenant_owner: '租户主账号',
    tenant_admin: '租户管理员',
    viewer: '只读',
  }
  return map[r] || r || '—'
}
