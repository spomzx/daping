/**
 * SaaS 用户展示名（仅 UI，不改权限与归属）
 * 优先：display_name → nickname → 已知账号展示映射 → username
 */

export type UserDisplayFields = {
  username?: string | null
  display_name?: string | null
  nickname?: string | null
}

/** 已知账号展示名（DB 无 display_name 时的展示层 fallback） */
const NICKNAME_OVERRIDES: Record<string, string> = {
  cqchic: 'CQ CHIC',
  test01: '测试账户管理员',
  test02: '测试公司2管理员',
}

export function resolveUserNickname(row: UserDisplayFields): string {
  const username = String(row.username ?? '').trim()
  const fromDb = String(row.display_name ?? row.nickname ?? '').trim()
  if (fromDb) return fromDb
  if (username) {
    const key = username.toLowerCase()
    const over = NICKNAME_OVERRIDES[key]
    if (over) return over
    return username
  }
  return '—'
}

export function resolveUserLoginAccount(row: UserDisplayFields): string {
  return String(row.username ?? '').trim() || '—'
}

export type TenantDisplayFields = {
  tenant_name?: string | null
  tenant_code?: string | null
}

export function resolveTenantTitle(row: TenantDisplayFields): string {
  return String(row.tenant_name ?? '').trim() || '—'
}

export function resolveTenantSubtext(row: TenantDisplayFields): string | null {
  const code = String(row.tenant_code ?? '').trim()
  return code || null
}
