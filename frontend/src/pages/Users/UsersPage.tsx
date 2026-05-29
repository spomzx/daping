import { useCallback, useEffect, useMemo, useState } from 'react'
import { me as fetchAuthMe } from '../../apiClient'
import {
  isCustomerAdmin,
  isPlatformScope,
  isTenantOwnerLike,
  normalizeMeRole,
  userDisplayI18nKey,
  type UserScope,
} from '../../authRole'
import { SaasCellStack } from '../../components/saas/SaasCellStack'
import { SaasPageFrame } from '../../components/layout/SaasPageFrame'
import {
  AdminButton,
  AdminBadge,
  AdminPagination,
  AdminSection,
  AdminTable,
  AdminTableBody,
  AdminTableCell,
  AdminTableFooter,
  AdminTableHeader,
  AdminTableLoading,
  AdminTableRow,
  AdminToolbarField,
  AdminToolbarSearch,
} from '../../components/admin'
import {
  resolveTenantSubtext,
  resolveTenantTitle,
  resolveUserLoginAccount,
  resolveUserNickname,
} from '../../lib/userDisplay'
import { PasswordInput } from '../../components/PasswordInput'
import {
  membershipStatusLabel,
  userStatusLabel,
  useT,
} from '../../i18n'
import {
  approveUser,
  createUser,
  deleteUser,
  fetchUsersList,
  patchUserStatus,
  rejectUser,
  resetUserPassword,
  usersApiErrorMessage,
  type UserRow,
} from '../../services/api/users'
import { fetchMyTenantPlan, type TenantPlanRow } from '../../services/api/tenants'
import { AssignShopsModal } from './AssignShopsModal'

function formatDt(v: string | null | undefined): string {
  if (v == null || v === '') return '—'
  const d = new Date(v)
  if (Number.isNaN(d.getTime())) return String(v)
  return d.toLocaleString('zh-CN', { hour12: false })
}

function isViewerRoleRow(role: string | undefined): boolean {
  return normalizeMeRole(String(role || '')) === 'viewer'
}

function sessionIsPlatform(sessionRole: string, sessionScope?: UserScope): boolean {
  return isPlatformScope({ scope: sessionScope, role: sessionRole })
}

function canDeleteUserRow(
  sessionRole: string,
  sessionScope: UserScope | undefined,
  row: UserRow,
  myUserId: number | null,
): boolean {
  if (myUserId == null || row.id == null) return false
  if (Number(row.id) === myUserId) return false
  const r = normalizeMeRole(String(row.role || ''))
  if (!r || r === 'super_admin') return false
  if (isPlatformScope({ scope: row.scope as UserScope | undefined, role: row.role })) return false
  if (r === 'viewer') return sessionIsPlatform(sessionRole, sessionScope) || isCustomerAdmin(sessionRole)
  if (r === 'admin') return sessionIsPlatform(sessionRole, sessionScope)
  return false
}

function rowDeleteHint(
  sessionRole: string,
  sessionScope: UserScope | undefined,
  row: UserRow,
  myUserId: number | null,
): string | null {
  if (row.id != null && myUserId != null && Number(row.id) === myUserId) return null
  const r = normalizeMeRole(String(row.role || ''))
  if (isPlatformScope({ scope: row.scope as UserScope | undefined, role: row.role }) || r === 'super_admin')
    return 'btn.cannotDelete'
  if (r === 'admin' && !sessionIsPlatform(sessionRole, sessionScope)) return 'btn.cannotDelete'
  return null
}

function canShowRowActions(
  sessionRole: string,
  sessionScope: UserScope | undefined,
  row: UserRow,
  myUserId: number | null,
): boolean {
  if (myUserId == null || row.id == null) return false
  if (Number(row.id) === myUserId) return false
  if (sessionIsPlatform(sessionRole, sessionScope)) {
    return normalizeMeRole(String(row.role || '')) === 'admin'
  }
  if (isTenantOwnerLike(sessionRole)) return isViewerRoleRow(row.role)
  return false
}

/** 仅账户管理员可为本租户普通用户分配店铺（平台管理员不可） */
function canAssignShops(sessionRole: string, sessionScope: UserScope | undefined, row: UserRow): boolean {
  if (!isViewerRoleRow(row.role)) return false
  if (sessionIsPlatform(sessionRole, sessionScope)) return false
  return isCustomerAdmin(sessionRole)
}

const PAGE_SIZE = 20

export function UsersPage({
  sessionRole,
  sessionScope,
}: {
  sessionRole: string
  sessionScope?: UserScope
}) {
  const t = useT()
  const platformSession = sessionIsPlatform(sessionRole, sessionScope)

  const [rows, setRows] = useState<UserRow[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [keyword, setKeyword] = useState('')
  const [roleFilter, setRoleFilter] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [okMsg, setOkMsg] = useState<string | null>(null)
  const [myUserId, setMyUserId] = useState<number | null>(null)
  const [myTenantId, setMyTenantId] = useState<number | null>(null)
  const [tenantPlan, setTenantPlan] = useState<TenantPlanRow | null>(null)

  const [createOpen, setCreateOpen] = useState(false)
  const [cUsername, setCUsername] = useState('')
  const [cDisplay, setCDisplay] = useState('')
  const [cPassword, setCPassword] = useState('')
  const [cConfirm, setCConfirm] = useState('')
  const [cBusy, setCBusy] = useState(false)
  const [cErr, setCErr] = useState('')

  const [resetOpen, setResetOpen] = useState(false)
  const [resetTarget, setResetTarget] = useState<UserRow | null>(null)
  const [rPassword, setRPassword] = useState('')
  const [rConfirm, setRConfirm] = useState('')
  const [rBusy, setRBusy] = useState(false)
  const [rErr, setRErr] = useState('')

  const [assignTarget, setAssignTarget] = useState<UserRow | null>(null)
  const [rowBusy, setRowBusy] = useState<number | null>(null)
  const [reviewBusy, setReviewBusy] = useState<number | null>(null)
  const [viewRow, setViewRow] = useState<UserRow | null>(null)

  const pendingRows = useMemo(() => {
    return rows.filter((u) => {
      const ms = String(u.membership_status || '')
      const us = String(u.user_status || '')
      const role = String(u.role || '')
      const owner = normalizeMeRole(role) === 'admin'
      return owner && (ms === 'pending_review' || us === 'pending_review')
    })
  }, [rows])

  const load = useCallback(async () => {
    setErr(null)
    setLoading(true)
    try {
      const q: Record<string, string> = {
        page: String(page),
        page_size: String(PAGE_SIZE),
      }
      if (keyword.trim()) q.keyword = keyword.trim()
      if (roleFilter) {
        if (platformSession && roleFilter === 'viewer') {
          /* 平台侧不请求 viewer，后端亦会返回空 */
        } else {
          q.role = roleFilter
        }
      }
      if (statusFilter) q.status = statusFilter
      const res = await fetchUsersList(q)
      setRows(Array.isArray(res.list) ? res.list : [])
      setTotal(Number(res.total) || 0)
    } catch (e) {
      setRows([])
      setErr(usersApiErrorMessage(e, t))
    } finally {
      setLoading(false)
    }
  }, [page, keyword, roleFilter, statusFilter, t])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (platformSession) {
      setTenantPlan(null)
      return
    }
    let cancelled = false
    void fetchMyTenantPlan()
      .then((plan) => {
        if (!cancelled) setTenantPlan(plan)
      })
      .catch(() => {
        if (!cancelled) setTenantPlan(null)
      })
    return () => {
      cancelled = true
    }
  }, [platformSession])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const mr = await fetchAuthMe()
        if (!mr.ok || cancelled) return
        const j = (await mr.json().catch(() => ({}))) as { user?: { id?: number; tenant_id?: number } }
        const id = Number(j?.user?.id)
        const tid = Number(j?.user?.tenant_id)
        if (!cancelled && Number.isFinite(id) && id > 0) setMyUserId(id)
        if (!cancelled && Number.isFinite(tid) && tid > 0) setMyTenantId(tid)
      } catch {
        /* ignore */
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  const userQuotaReached =
    tenantPlan != null &&
    Number.isFinite(tenantPlan.current_users) &&
    Number.isFinite(tenantPlan.max_users) &&
    tenantPlan.current_users >= tenantPlan.max_users

  const displayRole = (scope: string | undefined, role: string | undefined) => {
    return t(userDisplayI18nKey(scope, role))
  }

  function openCreate() {
    setCErr('')
    setCUsername('')
    setCDisplay('')
    setCPassword('')
    setCConfirm('')
    setCreateOpen(true)
  }

  async function submitCreate() {
    setCErr('')
    if (!platformSession && userQuotaReached) {
      setCErr('已达到套餐用户数量上限')
      return
    }
    if (cPassword !== cConfirm) {
      setCErr(t('error.passwordMismatch'))
      return
    }
    if (cPassword.length < 6) {
      setCErr(t('error.invalidPassword'))
      return
    }
    const u = cUsername.trim()
    if (!u) {
      setCErr(t('error.usernameRequired'))
      return
    }
    const body: Record<string, unknown> = { username: u, password: cPassword }
    if (cDisplay.trim()) body.display_name = cDisplay.trim()
    if (platformSession) {
      const tid = myTenantId != null && Number.isFinite(myTenantId) && myTenantId > 0 ? myTenantId : null
      if (tid == null) {
        setCErr(t('error.tenantContext'))
        return
      }
      body.tenant_id = tid
      body.role = 'admin'
    }
    setCBusy(true)
    try {
      await createUser(body)
      setCreateOpen(false)
      await load()
      if (!platformSession) {
        try {
          const plan = await fetchMyTenantPlan()
          setTenantPlan(plan)
        } catch {
          /* ignore */
        }
      }
    } catch (e) {
      setCErr(usersApiErrorMessage(e, t))
    } finally {
      setCBusy(false)
    }
  }

  async function toggleStatus(row: UserRow) {
    const id = Number(row.id)
    if (!Number.isFinite(id)) return
    const next = String(row.user_status || '').toLowerCase() === 'disabled' ? 'active' : 'disabled'
    setRowBusy(id)
    setErr(null)
    try {
      await patchUserStatus(id, next)
      await load()
    } catch (e) {
      setErr(usersApiErrorMessage(e, t))
    } finally {
      setRowBusy(null)
    }
  }

  function openReset(row: UserRow) {
    setResetTarget(row)
    setRPassword('')
    setRConfirm('')
    setRErr('')
    setResetOpen(true)
  }

  async function submitReset() {
    setRErr('')
    if (!resetTarget?.id) return
    if (rPassword !== rConfirm) {
      setRErr(t('error.passwordMismatch'))
      return
    }
    if (rPassword.length < 6) {
      setRErr(t('error.invalidPassword'))
      return
    }
    setRBusy(true)
    try {
      await resetUserPassword(Number(resetTarget.id), rPassword)
      setResetOpen(false)
      setResetTarget(null)
    } catch (e) {
      setRErr(usersApiErrorMessage(e, t))
    } finally {
      setRBusy(false)
    }
  }

  async function approvePending(id: number) {
    setReviewBusy(id)
    setErr(null)
    try {
      await approveUser(id)
      await load()
    } catch (e) {
      setErr(usersApiErrorMessage(e, t))
    } finally {
      setReviewBusy(null)
    }
  }

  async function rejectPending(id: number) {
    if (!window.confirm(t('confirm.rejectRegister'))) return
    setReviewBusy(id)
    setErr(null)
    try {
      await rejectUser(id)
      await load()
    } catch (e) {
      setErr(usersApiErrorMessage(e, t))
    } finally {
      setReviewBusy(null)
    }
  }

  async function deleteViewer(row: UserRow) {
    const id = Number(row.id)
    if (!Number.isFinite(id)) return
    const label = String(row.username || id)
    if (!window.confirm(t('confirm.deleteUser', { label }))) return
    setRowBusy(id)
    setErr(null)
    setOkMsg(null)
    try {
      const res = await deleteUser(id)
      await load()
      if (platformSession) {
        window.dispatchEvent(new CustomEvent('daping:tenants-refresh'))
      }
      const removed = res.tenants_deleted ?? []
      if (removed.length > 0) {
        const names = removed.map((x) => x.tenant_name || x.tenant_code || String(x.id)).join('、')
        setOkMsg(t('users.deleteSuccessTenantRemoved', { names }))
      } else {
        setOkMsg(t('users.deleteSuccess'))
      }
    } catch (e) {
      setErr(usersApiErrorMessage(e, t))
    } finally {
      setRowBusy(null)
    }
  }

  const listColCount = platformSession ? 7 : 8

  return (
    <div className="saas-admin-page users-page">
      <SaasPageFrame
        title={t('saas.nav.users')}
        description={platformSession ? t('users.pageDescPlatform') : t('users.pageDescTenant')}
        loading={loading && rows.length === 0}
        error={err}
        empty={!loading && !err && rows.length === 0 && pendingRows.length === 0}
        toolbarFilters={
          <>
            <AdminToolbarField label={t('users.filter.keyword')}>
              <AdminToolbarSearch
                value={keyword}
                onChange={(v) => {
                  setKeyword(v)
                  setPage(1)
                }}
                placeholder={t('users.filter.keyword')}
                className="users-input"
              />
            </AdminToolbarField>
            <AdminToolbarField label={t('users.filter.role')}>
              <select
                className="locale-select"
                value={roleFilter}
                onChange={(e) => {
                  setRoleFilter(e.target.value)
                  setPage(1)
                }}
              >
                <option value="">{t('sync.filter.all')}</option>
                {platformSession ? (
                  <>
                    <option value="admin">{t('role.admin')}</option>
                    <option value="super_admin">{t('role.super_admin')}</option>
                  </>
                ) : (
                  <option value="viewer">{t('role.viewer')}</option>
                )}
              </select>
            </AdminToolbarField>
            <AdminToolbarField label={t('users.filter.status')}>
              <select
                className="locale-select"
                value={statusFilter}
                onChange={(e) => {
                  setStatusFilter(e.target.value)
                  setPage(1)
                }}
              >
                <option value="">{t('sync.filter.all')}</option>
                <option value="active">{t('status.active')}</option>
                <option value="disabled">{t('status.disabled')}</option>
                <option value="pending_review">{t('status.pendingReview')}</option>
              </select>
            </AdminToolbarField>
            {!platformSession && tenantPlan ? (
              <span className="users-quota-hint">
                当前用户：{tenantPlan.current_users}/{tenantPlan.max_users}
              </span>
            ) : null}
          </>
        }
        toolbarActions={
          <>
            <AdminButton
              variant="primary"
              onClick={openCreate}
              disabled={!platformSession && userQuotaReached}
              title={!platformSession && userQuotaReached ? '已达到套餐用户数量上限' : undefined}
            >
              {t('users.newSubAccount')}
            </AdminButton>
            <AdminButton variant="secondary" disabled={loading} onClick={() => void load()}>
              {loading ? t('common.refreshing') : t('btn.refresh')}
            </AdminButton>
            <AdminButton
              variant="secondary"
              onClick={() => {
                setKeyword('')
                setRoleFilter('')
                setStatusFilter('')
                setPage(1)
              }}
            >
              {t('saas.filter.reset')}
            </AdminButton>
          </>
        }
        footer={
          <AdminTableFooter>
            <AdminPagination
              page={page}
              totalPages={totalPages}
              disabled={loading}
              density="compact"
              info={`${page} / ${totalPages} · ${total}`}
              onPrev={() => setPage((p) => p - 1)}
              onNext={() => setPage((p) => p + 1)}
            />
          </AdminTableFooter>
        }
      >
        {okMsg ? (
          <div className="saas-ok-banner" role="status">
            {okMsg}
          </div>
        ) : null}
        {platformSession && pendingRows.length > 0 ? (
          <AdminSection variant="table" title={t('users.pendingTitle')}>
            <div className="admin-table-wrap saas-table-wrap">
              <table className="saas-table">
                <thead>
                  <tr>
                    <th>{t('users.thUser')}</th>
                    <th>{t('users.thCustomer')}</th>
                    <th>{t('users.thStatus')}</th>
                    <th>{t('users.thActions')}</th>
                  </tr>
                </thead>
                <tbody>
                  {pendingRows.map((u) => {
                    const id = Number(u.id)
                    const busy = reviewBusy === id
                    return (
                      <tr key={`p-${id}`}>
                        <td>
                          <SaasCellStack
                            title={resolveUserNickname(u)}
                            subtext={resolveUserLoginAccount(u)}
                            subtextPrefix={t('users.labelLoginAccount')}
                          />
                        </td>
                        <td>
                          <SaasCellStack
                            title={resolveTenantTitle(u)}
                            subtext={resolveTenantSubtext(u)}
                          />
                        </td>
                        <td>{membershipStatusLabel(String(u.membership_status || ''), t)}</td>
                        <td>
                          <button type="button" disabled={busy} className="admin-btn admin-btn--secondary" onClick={() => setViewRow(u)}>
                            {t('btn.view')}
                          </button>
                          <button
                            type="button"
                            disabled={busy}
                            className="admin-btn admin-btn--secondary"
                            style={{ marginLeft: 6 }}
                            onClick={() => void approvePending(id)}
                          >
                            {busy ? '…' : t('btn.approve')}
                          </button>
                          <button
                            type="button"
                            disabled={busy}
                            className="admin-btn admin-btn--secondary"
                            style={{ marginLeft: 6 }}
                            onClick={() => void rejectPending(id)}
                          >
                            {t('btn.reject')}
                          </button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </AdminSection>
        ) : null}

        <AdminSection variant="table" title="用户列表">
          <AdminTable minWidth={960} zebra>
            <AdminTableHeader>
              <AdminTableRow>
                <AdminTableCell as="th">{t('users.thUser')}</AdminTableCell>
                <AdminTableCell as="th">{t('users.thContact')}</AdminTableCell>
                <AdminTableCell as="th">{t('users.thRole')}</AdminTableCell>
                <AdminTableCell as="th">{t('users.thStatus')}</AdminTableCell>
                <AdminTableCell as="th">{t('users.thCustomer')}</AdminTableCell>
                {!platformSession ? (
                  <AdminTableCell as="th">{t('users.thAssignedShops')}</AdminTableCell>
                ) : null}
                <AdminTableCell as="th">{t('users.thCreatedAt')}</AdminTableCell>
                <AdminTableCell as="th">{t('users.thActions')}</AdminTableCell>
              </AdminTableRow>
            </AdminTableHeader>
            <AdminTableBody>
              {loading ? (
                <AdminTableLoading colSpan={listColCount} />
              ) : (
                rows.map((u, i) => {
                const stUser = String(u.user_status || '—')
                const stMem = String(u.membership_status || '—')
                const statusText =
                  stMem === stUser
                    ? userStatusLabel(stUser, t)
                    : t('users.statusCombined', {
                        user: userStatusLabel(stUser, t),
                        member: membershipStatusLabel(stMem, t),
                      })
                const disabledUser = String(u.user_status || '').toLowerCase() === 'disabled'
                const showAct = canShowRowActions(sessionRole, sessionScope, u, myUserId)
                const showDelete = canDeleteUserRow(sessionRole, sessionScope, u, myUserId)
                const deleteHint = rowDeleteHint(sessionRole, sessionScope, u, myUserId)
                const showAssign = canAssignShops(sessionRole, sessionScope, u)
                const busy = rowBusy === u.id
                const isSelf = myUserId != null && u.id != null && Number(u.id) === myUserId
                return (
                  <AdminTableRow key={`${u.id ?? u.username}-${u.tenant_id ?? i}`}>
                    <AdminTableCell>
                      <SaasCellStack
                        title={resolveUserNickname(u)}
                        subtext={resolveUserLoginAccount(u)}
                        subtextPrefix={t('users.labelLoginAccount')}
                      />
                    </AdminTableCell>
                    <AdminTableCell>{u.contact?.trim() || '—'}</AdminTableCell>
                    <AdminTableCell>
                      <AdminBadge variant={String(u.scope || '').toLowerCase() === 'platform' ? 'processing' : 'info'}>
                        {displayRole(u.scope, u.role)}
                      </AdminBadge>
                    </AdminTableCell>
                    <AdminTableCell>{statusText}</AdminTableCell>
                    <AdminTableCell>
                      <SaasCellStack
                        title={resolveTenantTitle(u)}
                        subtext={resolveTenantSubtext(u)}
                      />
                      <div style={{ marginTop: 6 }}>
                        <AdminBadge variant="neutral">{u.tenant_code || `T${u.tenant_id ?? '—'}`}</AdminBadge>
                      </div>
                    </AdminTableCell>
                    {!platformSession ? (
                      <AdminTableCell numeric>{u.assigned_shop_count ?? 0}</AdminTableCell>
                    ) : null}
                    <AdminTableCell>{formatDt(u.created_at)}</AdminTableCell>
                    <AdminTableCell className="users-actions-cell">
                      <div className="users-actions-inner">
                        {showAssign ? (
                          <AdminButton variant="secondary" onClick={() => setAssignTarget(u)}>
                            {t('users.assignShops')}
                          </AdminButton>
                        ) : null}
                        {isSelf ? (
                          <AdminButton variant="secondary" disabled title={t('users.changePasswordSoon')}>
                            {t('btn.changePassword')}
                          </AdminButton>
                        ) : (
                          <>
                            {showAct ? (
                              <>
                                <AdminButton variant="secondary" disabled={busy} onClick={() => void toggleStatus(u)}>
                                  {busy ? '…' : disabledUser ? t('btn.enable') : t('btn.disable')}
                                </AdminButton>
                                <AdminButton variant="secondary" disabled={busy} onClick={() => openReset(u)}>
                                  {t('btn.resetPassword')}
                                </AdminButton>
                              </>
                            ) : null}
                            {showDelete ? (
                              <AdminButton variant="secondary" disabled={busy} onClick={() => void deleteViewer(u)}>
                                {t('btn.delete')}
                              </AdminButton>
                            ) : deleteHint ? (
                              <span className="users-action-muted">{t(deleteHint)}</span>
                            ) : null}
                          </>
                        )}
                      </div>
                    </AdminTableCell>
                  </AdminTableRow>
                )
              })
              )}
            </AdminTableBody>
          </AdminTable>
        </AdminSection>
      </SaasPageFrame>

      {viewRow ? (
        <div className="users-modal-backdrop" onClick={() => setViewRow(null)}>
          <div className="users-modal" onClick={(e) => e.stopPropagation()}>
            <h3 className="users-modal__title">{t('users.registerInfo')}</h3>
            <div style={{ fontSize: 13, lineHeight: 1.7 }}>
              <div>
                <strong>{t('users.fieldCustomer')}</strong>：{resolveTenantTitle(viewRow)}
                {resolveTenantSubtext(viewRow) ? `（${resolveTenantSubtext(viewRow)}）` : ''}
              </div>
              <div>
                <strong>{t('users.labelNickname')}</strong>：{resolveUserNickname(viewRow)}
              </div>
              <div>
                <strong>{t('users.labelLoginAccount')}</strong>：{resolveUserLoginAccount(viewRow)}
              </div>
              <div>
                <strong>{t('users.fieldContact')}</strong>：{viewRow.contact || t('common.dash')}
              </div>
            </div>
            <div className="users-modal__actions">
              <button type="button" className="admin-btn admin-btn--secondary" onClick={() => setViewRow(null)}>
                {t('btn.close')}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {createOpen ? (
        <div className="users-modal-backdrop" onClick={() => !cBusy && setCreateOpen(false)}>
          <div className="users-modal" onClick={(e) => e.stopPropagation()}>
            <h3 className="users-modal__title">{t('users.createTitle')}</h3>
            <label style={{ display: 'block', marginBottom: 10, fontSize: 13 }}>
              {t('users.labelLoginAccount')}
              <input className="users-input" value={cUsername} onChange={(e) => setCUsername(e.target.value)} autoComplete="off" />
            </label>
            <label style={{ display: 'block', marginBottom: 10, fontSize: 13 }}>
              {t('users.labelNickname')}
              <input className="users-input" value={cDisplay} onChange={(e) => setCDisplay(e.target.value)} />
            </label>
            <label style={{ display: 'block', marginBottom: 10, fontSize: 13 }}>
              {t('users.labelPassword')}
              <PasswordInput
                name="password"
                className="users-input"
                value={cPassword}
                onChange={(e) => setCPassword(e.target.value)}
                autoComplete="new-password"
              />
            </label>
            <label style={{ display: 'block', marginBottom: 10, fontSize: 13 }}>
              {t('users.labelConfirmPassword')}
              <PasswordInput
                name="confirm_password"
                className="users-input"
                value={cConfirm}
                onChange={(e) => setCConfirm(e.target.value)}
                autoComplete="new-password"
              />
            </label>
            {platformSession ? (
              <p className="users-modal__hint">{t('users.platformCreateAdminHint')}</p>
            ) : (
              <>
                <p className="users-modal__hint">{t('users.viewerOnlyHint')}</p>
                {tenantPlan ? (
                  <p className="users-modal__hint">
                    当前：{tenantPlan.current_users}/{tenantPlan.max_users} 用户
                    {userQuotaReached ? '（已达上限，无法继续创建）' : ''}
                  </p>
                ) : null}
              </>
            )}
            {cErr ? <p className="warn-text">{cErr}</p> : null}
            <div className="users-modal__actions">
              <button
                type="button"
                disabled={cBusy || (!platformSession && userQuotaReached)}
                className="admin-btn admin-btn--secondary"
                onClick={() => void submitCreate()}
              >
                {cBusy ? t('btn.submitting') : t('btn.create')}
              </button>
              <button type="button" disabled={cBusy} className="admin-btn admin-btn--secondary" onClick={() => setCreateOpen(false)}>
                {t('btn.cancel')}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {resetOpen && resetTarget ? (
        <div className="users-modal-backdrop" onClick={() => !rBusy && setResetOpen(false)}>
          <div className="users-modal" onClick={(e) => e.stopPropagation()}>
            <h3 className="users-modal__title">{t('users.resetTitle', { username: resetTarget.username ?? '' })}</h3>
            <label style={{ display: 'block', marginBottom: 10, fontSize: 13 }}>
              {t('users.labelNewPassword')}
              <PasswordInput
                name="new_password"
                className="users-input"
                value={rPassword}
                onChange={(e) => setRPassword(e.target.value)}
                autoComplete="new-password"
              />
            </label>
            <label style={{ display: 'block', marginBottom: 10, fontSize: 13 }}>
              {t('users.labelConfirmNewPassword')}
              <PasswordInput
                name="confirm_new_password"
                className="users-input"
                value={rConfirm}
                onChange={(e) => setRConfirm(e.target.value)}
                autoComplete="new-password"
              />
            </label>
            {rErr ? <p className="warn-text">{rErr}</p> : null}
            <div className="users-modal__actions">
              <button type="button" disabled={rBusy} className="admin-btn admin-btn--secondary" onClick={() => void submitReset()}>
                {rBusy ? t('btn.submitting') : t('users.confirmReset')}
              </button>
              <button type="button" disabled={rBusy} className="admin-btn admin-btn--secondary" onClick={() => setResetOpen(false)}>
                {t('btn.cancel')}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {assignTarget ? (
        <AssignShopsModal
          user={assignTarget}
          open={Boolean(assignTarget)}
          onClose={() => setAssignTarget(null)}
          onSaved={() => void load()}
        />
      ) : null}
    </div>
  )
}
