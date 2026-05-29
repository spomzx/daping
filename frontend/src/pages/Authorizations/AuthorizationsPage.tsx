import { useCallback, useEffect, useState } from 'react'
import { useT } from '../../i18n'
import { displayMarketCode } from '../../contracts/market.contract'
import { SaasPageFrame } from '../../components/layout/SaasPageFrame'
import {
  AdminBadge,
  type AdminBadgeVariant,
  AdminButton,
  AdminTable,
  AdminTableBody,
  AdminTableCell,
  AdminTableEmpty,
  AdminTableHeader,
  AdminTableLoading,
  AdminTableRow,
  AdminTableShell,
} from '../../components/admin'
import { fetchAuthorizationsList, type AuthorizationRow } from '../../services/api/authorizations'

const COL_COUNT = 8

function fmtDt(v: string | null | undefined): string {
  if (!v) return '—'
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleString('zh-CN', { hour12: false })
}

function tokenStatusDisplay(status: string | undefined): { variant: AdminBadgeVariant; label: string } {
  const s = String(status ?? '').trim().toLowerCase()
  if (s === 'active') return { variant: 'success', label: '正常' }
  if (s === 'expired') return { variant: 'warning', label: 'expired' }
  if (s === 'missing') return { variant: 'danger', label: 'missing' }
  if (!s) return { variant: 'neutral', label: '—' }
  return { variant: 'neutral', label: status?.trim() || '—' }
}

function authErrorDisplay(r: AuthorizationRow): string {
  const text = r.error_label
  return text != null && String(text).trim() ? String(text).trim() : '—'
}

export function AuthorizationsPage() {
  const t = useT()
  const [rows, setRows] = useState<AuthorizationRow[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setErr(null)
    try {
      const data = await fetchAuthorizationsList()
      setRows(Array.isArray(data.items) ? data.items : [])
    } catch (e) {
      setErr(String((e as Error)?.message || e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const headerActions = (
    <AdminButton variant="secondary" disabled={loading} onClick={() => void load()}>
      {loading ? t('common.refreshing') : t('btn.refresh')}
    </AdminButton>
  )

  return (
    <div className="saas-admin-page authorizations-page">
      <SaasPageFrame
        title={t('saas.nav.authorizations')}
        description={t('authz.pageDesc')}
        headerActions={headerActions}
        loading={loading && rows.length === 0}
        error={err}
        empty={!loading && !err && rows.length === 0}
      >
        <AdminTableShell title="Token 授权明细" description={t('authz.pageDesc')}>
          <AdminTable minWidth={960} zebra>
            <AdminTableHeader>
              <AdminTableRow>
                <AdminTableCell as="th" className="col-shop">
                  {t('authz.col.shop')}
                </AdminTableCell>
                <AdminTableCell as="th">{t('authz.col.platform')}</AdminTableCell>
                <AdminTableCell as="th" className="col-market">
                  {t('authz.col.market')}
                </AdminTableCell>
                <AdminTableCell as="th" className="col-status">
                  {t('authz.col.token')}
                </AdminTableCell>
                <AdminTableCell as="th">{t('authz.col.expire')}</AdminTableCell>
                <AdminTableCell as="th">{t('authz.col.lastAuth')}</AdminTableCell>
                <AdminTableCell as="th">{t('authz.col.lastSync')}</AdminTableCell>
                <AdminTableCell as="th" className="col-error">
                  {t('authz.col.error')}
                </AdminTableCell>
              </AdminTableRow>
            </AdminTableHeader>
            <AdminTableBody>
              {loading ? (
                <AdminTableLoading colSpan={COL_COUNT} />
              ) : rows.length === 0 ? (
                <AdminTableEmpty colSpan={COL_COUNT} />
              ) : (
                rows.map((r) => {
                  const badge = tokenStatusDisplay(r.token_status)
                  const errText = authErrorDisplay(r)
                  return (
                    <AdminTableRow key={`${r.platform_shop_id || 'sid'}-${r.shop_id}`}>
                      <AdminTableCell className="col-shop" title={r.shop_name || r.platform_shop_id}>
                        {r.shop_name || r.platform_shop_id}
                      </AdminTableCell>
                      <AdminTableCell>{r.platform || 'tiktok'}</AdminTableCell>
                      <AdminTableCell className="col-market">{displayMarketCode(r.market)}</AdminTableCell>
                      <AdminTableCell className="col-status">
                        <AdminBadge variant={badge.variant}>{badge.label}</AdminBadge>
                      </AdminTableCell>
                      <AdminTableCell>{fmtDt(r.token_expire_at)}</AdminTableCell>
                      <AdminTableCell>{fmtDt(r.token_updated_at)}</AdminTableCell>
                      <AdminTableCell>{fmtDt(r.last_sync_at)}</AdminTableCell>
                      <AdminTableCell className="col-error saas-td-error" title={errText}>
                        {errText}
                      </AdminTableCell>
                    </AdminTableRow>
                  )
                })
              )}
            </AdminTableBody>
          </AdminTable>
        </AdminTableShell>
      </SaasPageFrame>
    </div>
  )
}
