import { useCallback, useEffect, useState } from 'react'
import { useT } from '../../i18n'
import { SaasPageFrame } from '../../components/layout/SaasPageFrame'
import { fetchAuthorizationsList, type AuthorizationRow } from '../../services/api/authorizations'

function fmtDt(v: string | null | undefined): string {
  if (!v) return '—'
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleString('zh-CN', { hour12: false })
}

function tokenBadge(status: string | undefined, hasToken?: number) {
  const s = String(status || (hasToken ? 'active' : 'missing')).toLowerCase()
  if (s === 'active') return { cls: 'saas-badge saas-badge--success', label: 'active' }
  if (s === 'expired') return { cls: 'saas-badge saas-badge--warn', label: 'expired' }
  return { cls: 'saas-badge saas-badge--danger', label: 'missing' }
}

function authErrorDisplay(r: AuthorizationRow): string {
  const ts = String(r.token_status || '').toLowerCase()
  if (ts === 'active') return '授权正常'
  if (ts === 'expired') return '授权已过期'
  if (ts === 'missing') return '缺少授权 Token'
  return r.error_label || '—'
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
      setRows(data.items)
    } catch (e) {
      setErr(String((e as Error)?.message || e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const toolbar = (
    <button type="button" className="refresh-btn" disabled={loading} onClick={() => void load()}>
      {loading ? t('common.refreshing') : t('btn.refresh')}
    </button>
  )

  return (
    <div className="saas-admin-page">
      <SaasPageFrame
        description={t('authz.pageDesc')}
        loading={loading}
        error={err}
        empty={!loading && !err && rows.length === 0}
        toolbar={toolbar}
      >
        <div className="saas-table-wrap">
          <table className="saas-table">
            <thead>
              <tr>
                <th className="col-shop">{t('authz.col.shop')}</th>
                <th>{t('authz.col.platform')}</th>
                <th className="col-market">{t('authz.col.market')}</th>
                <th className="col-status">{t('authz.col.token')}</th>
                <th>{t('authz.col.expire')}</th>
                <th>{t('authz.col.lastAuth')}</th>
                <th>{t('authz.col.lastSync')}</th>
                <th className="col-error">{t('authz.col.error')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const badge = tokenBadge(r.token_status, r.has_token)
                const errText = authErrorDisplay(r)
                return (
                  <tr key={`${r.platform_shop_id || 'sid'}-${r.shop_id}`}>
                    <td className="col-shop" title={r.shop_name || r.platform_shop_id}>
                      {r.shop_name || r.platform_shop_id}
                    </td>
                    <td>{r.platform || 'tiktok'}</td>
                    <td className="col-market">{r.market || '—'}</td>
                    <td className="col-status">
                      <span className={badge.cls}>{badge.label}</span>
                    </td>
                    <td>{fmtDt(r.token_expire_at)}</td>
                    <td>{fmtDt(r.token_updated_at)}</td>
                    <td>{fmtDt(r.last_sync_at)}</td>
                    <td className="col-error saas-td-error" title={errText}>
                      {errText}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </SaasPageFrame>
    </div>
  )
}
