import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { SaasBadge } from '../../components/saas/SaasBadge'
import { SaasDrawer } from '../../components/saas/SaasDrawer'
import { SaasEmptyState } from '../../components/saas/SaasEmptyState'
import { SaasQuotaProgress } from '../../components/saas/SaasQuotaProgress'
import { SaasTableSkeleton } from '../../components/saas/SaasTableSkeleton'
import { SaasCellStack } from '../../components/saas/SaasCellStack'
import { SaasPageFrame } from '../../components/layout/SaasPageFrame'
import { resolveTenantSubtext, resolveTenantTitle } from '../../lib/userDisplay'
import { usePlatformViewTenant } from '../../context/PlatformViewTenantContext'
import { useT } from '../../i18n'
import {
  PLAN_PRESETS,
  normalizeTenantPlanType,
  planTypeLabel,
  TENANT_PLAN_TYPES,
  type TenantPlanType,
} from '../../lib/tenantPlan'
import {
  fetchTenantPlans,
  patchTenantPlan,
  tenantsApiErrorMessage,
  type TenantPlanPatch,
  type TenantPlanRow,
  type TenantPlanStatus,
} from '../../services/api/tenants'
const PAGE_SIZE = 20

function formatDt(v: string | null | undefined): string {
  if (v == null || v === '') return '—'
  const d = new Date(v)
  if (Number.isNaN(d.getTime())) return String(v)
  return d.toLocaleString('zh-CN', { hour12: false })
}

function toDatetimeLocal(v: string | null | undefined): string {
  if (!v) return ''
  const d = new Date(v)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

type EditState = {
  plan_type: TenantPlanType
  shop_limit: number
  max_users: number
  expires_at: string
  is_active: boolean
  plan_remark: string
}

function rowToEdit(row: TenantPlanRow): EditState {
  return {
    plan_type: normalizeTenantPlanType(row.plan_type),
    shop_limit: row.shop_limit,
    max_users: row.max_users,
    expires_at: toDatetimeLocal(row.expires_at),
    is_active: row.is_active !== 0,
    plan_remark: row.plan_remark ?? '',
  }
}

function resolveRowStatus(row: TenantPlanRow): TenantPlanStatus {
  if (row.plan_status) return row.plan_status
  if (row.is_active === 0) return 'disabled'
  return 'normal'
}

export function TenantsPage() {
  const t = useT()
  const nav = useNavigate()
  const viewCtx = usePlatformViewTenant()
  const [list, setList] = useState<TenantPlanRow[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [keyword, setKeyword] = useState('')
  const [planFilter, setPlanFilter] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [editRow, setEditRow] = useState<TenantPlanRow | null>(null)
  const [form, setForm] = useState<EditState | null>(null)
  const [saving, setSaving] = useState(false)
  const [drawerErr, setDrawerErr] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setErr(null)
    try {
      const res = await fetchTenantPlans({
        page,
        page_size: PAGE_SIZE,
        keyword: keyword.trim() || undefined,
        plan_type: planFilter || undefined,
        plan_status: statusFilter || undefined,
      })
      setList(res.list)
      setTotal(res.total)
    } catch (e) {
      setErr(tenantsApiErrorMessage(e, '加载租户列表失败'))
      setList([])
    } finally {
      setLoading(false)
    }
  }, [page, keyword, planFilter, statusFilter])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    const onRefresh = () => void load()
    window.addEventListener('daping:tenants-refresh', onRefresh)
    return () => window.removeEventListener('daping:tenants-refresh', onRefresh)
  }, [load])

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  const openEdit = (row: TenantPlanRow) => {
    setEditRow(row)
    setForm(rowToEdit(row))
    setDrawerErr(null)
    setDrawerOpen(true)
  }

  const closeEdit = () => {
    setDrawerOpen(false)
    setEditRow(null)
    setForm(null)
    setDrawerErr(null)
  }

  const onPlanTypeChange = (next: TenantPlanType) => {
    if (!form) return
    if (next === 'custom') {
      setForm({ ...form, plan_type: 'custom' })
      return
    }
    const preset = PLAN_PRESETS[next]
    setForm({
      ...form,
      plan_type: next,
      shop_limit: preset.shop_limit,
      max_users: preset.max_users,
    })
  }

  const submitEdit = async () => {
    if (!editRow || !form) return
    setSaving(true)
    setDrawerErr(null)
    const body: TenantPlanPatch = {
      plan_type: form.plan_type,
      shop_limit: Number(form.shop_limit),
      max_users: Number(form.max_users),
      is_active: form.is_active ? 1 : 0,
      plan_remark: form.plan_remark.trim() || null,
      expires_at: form.expires_at ? new Date(form.expires_at).toISOString() : null,
    }
    try {
      await patchTenantPlan(editRow.id, body)
      closeEdit()
      await load()
    } catch (e) {
      setDrawerErr(tenantsApiErrorMessage(e, '保存失败'))
    } finally {
      setSaving(false)
    }
  }

  const resetFilters = () => {
    setKeyword('')
    setPlanFilter('')
    setStatusFilter('')
    setPage(1)
  }

  return (
    <div className="tenants-admin-page">
      <SaasPageFrame
        title={t('saas.nav.tenants')}
        description="平台管理员可调整各租户套餐、店铺/用户上限与到期时间"
        loading={false}
        error={null}
      >
        <div className="saas-card">
          <div className="saas-toolbar">
            <div className="saas-toolbar__field">
              <span className="saas-toolbar__label">搜索</span>
              <input
                className="saas-input"
                value={keyword}
                onChange={(e) => {
                  setKeyword(e.target.value)
                  setPage(1)
                }}
                placeholder="租户名 / 编码"
              />
            </div>
            <div className="saas-toolbar__field">
              <span className="saas-toolbar__label">套餐</span>
              <select
                className="saas-select"
                value={planFilter}
                onChange={(e) => {
                  setPlanFilter(e.target.value)
                  setPage(1)
                }}
              >
                <option value="">全部套餐</option>
                <option value="basic">基础版</option>
                <option value="enterprise">企业版</option>
                <option value="custom">自定义版</option>
              </select>
            </div>
            <div className="saas-toolbar__field">
              <span className="saas-toolbar__label">状态</span>
              <select
                className="saas-select"
                value={statusFilter}
                onChange={(e) => {
                  setStatusFilter(e.target.value)
                  setPage(1)
                }}
              >
                <option value="">全部状态</option>
                <option value="normal">正常</option>
                <option value="expiring">即将到期</option>
                <option value="expired">已过期</option>
                <option value="disabled">已禁用</option>
              </select>
            </div>
            <div className="saas-toolbar__actions">
              <button type="button" className="saas-btn saas-btn--ghost" disabled={loading} onClick={() => void load()}>
                {loading ? '刷新中…' : '刷新'}
              </button>
              <button type="button" className="saas-btn saas-btn--ghost" onClick={resetFilters}>
                {t('saas.filter.reset')}
              </button>
              <button type="button" className="saas-btn saas-btn--primary" disabled title="即将开放">
                新建租户
              </button>
            </div>
          </div>

          {err ? (
            <div className="saas-error-banner" role="alert">
              <span>{err}</span>
              <button type="button" className="saas-btn saas-btn--sm saas-btn--ghost" onClick={() => void load()}>
                重试
              </button>
            </div>
          ) : null}

          {loading ? (
            <SaasTableSkeleton />
          ) : !err && list.length === 0 ? (
            <SaasEmptyState
              title="暂无租户"
              description="尝试调整筛选条件，或等待新租户接入"
              action={
                <button type="button" className="saas-btn saas-btn--ghost" onClick={resetFilters}>
                  清除筛选
                </button>
              }
            />
          ) : !err ? (
            <div className="saas-table-wrap">
              <table className="saas-table">
                <thead>
                  <tr>
                    <th>租户</th>
                    <th>管理员账号</th>
                    <th>套餐</th>
                    <th>店铺额度</th>
                    <th>用户额度</th>
                    <th>状态</th>
                    <th>到期时间</th>
                    <th>备注</th>
                    <th>创建时间</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((row) => {
                    const ps = resolveRowStatus(row)
                    return (
                      <tr key={row.id}>
                        <td>
                          <SaasCellStack
                            title={resolveTenantTitle(row)}
                            subtext={resolveTenantSubtext(row)}
                          />
                        </td>
                        <td>
                          <span className="saas-cell-stack__title">
                            {row.primary_admin_username?.trim() || '—'}
                          </span>
                        </td>
                        <td>
                          <span className="saas-table__plan-name">{planTypeLabel(row.plan_type)}</span>
                        </td>
                        <td>
                          <SaasQuotaProgress current={row.current_shops} limit={row.shop_limit} unit="店" />
                        </td>
                        <td>
                          <SaasQuotaProgress current={row.current_users} limit={row.max_users} unit="用户" />
                        </td>
                        <td>
                          <SaasBadge status={ps} />
                        </td>
                        <td>{formatDt(row.expires_at)}</td>
                        <td title={row.plan_remark ?? ''}>
                          <span className="saas-table__remark">{row.plan_remark || '—'}</span>
                        </td>
                        <td>{formatDt(row.created_at)}</td>
                        <td>
                          <div className="saas-table__actions">
                            <button
                              type="button"
                              className="saas-btn saas-btn--sm saas-btn--blue"
                              onClick={() => {
                                viewCtx?.setViewingTenantId(row.id)
                                nav('/legacy')
                              }}
                            >
                              查看数据
                            </button>
                            <button
                              type="button"
                              className="saas-btn saas-btn--sm saas-btn--cyan"
                              onClick={() => openEdit(row)}
                            >
                              编辑
                            </button>
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          ) : null}

          {!loading && !err && list.length > 0 ? (
            <div className="saas-pager">
              <span>
                第 {page} / {totalPages} 页 · 共 {total} 个租户
              </span>
              <div className="saas-pager__controls">
                <button
                  type="button"
                  className="saas-btn saas-btn--ghost saas-btn--sm"
                  disabled={page <= 1}
                  onClick={() => setPage((p) => p - 1)}
                >
                  上一页
                </button>
                <button
                  type="button"
                  className="saas-btn saas-btn--ghost saas-btn--sm"
                  disabled={page >= totalPages}
                  onClick={() => setPage((p) => p + 1)}
                >
                  下一页
                </button>
              </div>
            </div>
          ) : null}
        </div>
      </SaasPageFrame>

      <SaasDrawer
        open={drawerOpen && !!editRow && !!form}
        title="编辑租户"
        subtitle={
          editRow ? (
            <>
              {editRow.tenant_name}
              <code>{editRow.tenant_code}</code>
            </>
          ) : null
        }
        onClose={closeEdit}
        footer={
          <>
            <button type="button" className="saas-btn saas-btn--ghost" onClick={closeEdit} disabled={saving}>
              取消
            </button>
            <button type="button" className="saas-btn saas-btn--primary" onClick={() => void submitEdit()} disabled={saving}>
              {saving ? '保存中…' : '保存'}
            </button>
          </>
        }
      >
        {form ? (
          <>
            <div className="saas-field">
              <label className="saas-field__label" htmlFor="tenant-plan-type">
                套餐类型
              </label>
              <select
                id="tenant-plan-type"
                className="saas-select"
                value={form.plan_type}
                onChange={(e) => onPlanTypeChange(normalizeTenantPlanType(e.target.value))}
              >
                {TENANT_PLAN_TYPES.map((pt) => (
                  <option key={pt} value={pt}>
                    {planTypeLabel(pt)}
                  </option>
                ))}
              </select>
            </div>
            <div className="saas-field">
              <label className="saas-field__label" htmlFor="tenant-shop-limit">
                店铺额度
              </label>
              <input
                id="tenant-shop-limit"
                type="number"
                min={1}
                className="saas-input"
                value={form.shop_limit}
                onChange={(e) => setForm({ ...form, shop_limit: Number(e.target.value) })}
              />
            </div>
            <div className="saas-field">
              <label className="saas-field__label" htmlFor="tenant-max-users">
                用户额度
              </label>
              <input
                id="tenant-max-users"
                type="number"
                min={1}
                className="saas-input"
                value={form.max_users}
                onChange={(e) => setForm({ ...form, max_users: Number(e.target.value) })}
              />
            </div>
            <div className="saas-field">
              <label className="saas-field__label" htmlFor="tenant-expires">
                到期时间
              </label>
              <input
                id="tenant-expires"
                type="datetime-local"
                className="saas-input"
                value={form.expires_at}
                onChange={(e) => setForm({ ...form, expires_at: e.target.value })}
              />
            </div>
            <div className="saas-field">
              <label className="saas-field__label" htmlFor="tenant-active">
                启用状态
              </label>
              <select
                id="tenant-active"
                className="saas-select"
                value={form.is_active ? '1' : '0'}
                onChange={(e) => setForm({ ...form, is_active: e.target.value === '1' })}
              >
                <option value="1">启用</option>
                <option value="0">禁用</option>
              </select>
            </div>
            <div className="saas-field">
              <label className="saas-field__label" htmlFor="tenant-remark">
                备注
              </label>
              <textarea
                id="tenant-remark"
                className="saas-textarea"
                rows={4}
                value={form.plan_remark}
                onChange={(e) => setForm({ ...form, plan_remark: e.target.value })}
              />
            </div>
            {drawerErr ? <p className="saas-drawer-error">{drawerErr}</p> : null}
          </>
        ) : null}
      </SaasDrawer>
    </div>
  )
}
