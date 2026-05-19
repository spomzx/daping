import type { ReactNode } from 'react'
import { useEffect, useState } from 'react'
import { NavLink } from 'react-router-dom'
import { fetchMyTenantPlan, type TenantPlanRow } from '../../services/api/tenants'
import { isAdminLike, isPlatformScope, type AccountAccess, type MeRole, type UserScope } from '../../authRole'
import { LOCALES, normalizeLocale, useI18n } from '../../i18n'
import { useAppShellHeader } from '../../hooks/useAppShellHeader'
import { SAAS_NAV_ITEMS, filterSaasNav } from '../../config/saasNav'
import { tiktokOAuthStartUrl } from '../../tiktokOAuth'
import { TenantViewSelector } from '../TenantViewSelector'

export type SaasLayoutProps = {
  appRole: MeRole
  appUserScope?: UserScope
  appUsername: string
  appAccess: AccountAccess
  onLogout: () => void
  children: ReactNode
  titleKey?: string
}

export function SaasLayout({
  appRole,
  appUserScope,
  appUsername,
  onLogout,
  children,
  titleKey = 'saas.nav.dashboard',
}: SaasLayoutProps) {
  const { locale, setLocale, t: tx } = useI18n()
  const { nowText, shopSummary, authConnected } = useAppShellHeader()
  const platformScope = isPlatformScope({ scope: appUserScope, role: appRole })
  const canManageShops = platformScope || isAdminLike(appRole)
  const navItems = filterSaasNav(SAAS_NAV_ITEMS, appRole, appUserScope)
  const [tenantPlan, setTenantPlan] = useState<TenantPlanRow | null>(null)

  useEffect(() => {
    if (platformScope) {
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
  }, [platformScope])

  const planBanner = (() => {
    if (platformScope || !tenantPlan) return null
    if (tenantPlan.plan_status === 'expired') {
      return '套餐已到期，仅允许查看数据（不可授权、同步、新增用户）'
    }
    if (tenantPlan.is_active === 0 || tenantPlan.plan_status === 'disabled') {
      return '当前套餐已停用，请联系平台管理员'
    }
    return null
  })()

  return (
    <div className="saas-shell">
      <aside className="saas-sidebar" aria-label={tx('saas.nav.label')}>
        <div className="saas-sidebar-brand">
          <span className="saas-sidebar-brand-title">{tx('app.title')}</span>
          <span className="saas-sidebar-brand-sub">SaaS</span>
        </div>
        <nav className="saas-sidebar-nav">
          {navItems.map((item) => (
            <NavLink
              key={item.id}
              to={item.path}
              className={({ isActive }) =>
                `saas-sidebar-link${isActive ? ' saas-sidebar-link--active' : ''}`
              }
              end={item.path === '/dashboard'}
            >
              {tx(item.labelKey)}
            </NavLink>
          ))}
          {canManageShops && !platformScope && !authConnected ? (
            <button
              type="button"
              className="saas-sidebar-link saas-sidebar-link--cta"
              onClick={() => {
                window.location.href = tiktokOAuthStartUrl()
              }}
            >
              {tx('nav.connectTiktok')}
            </button>
          ) : null}
        </nav>
        <div className="saas-sidebar-footer">
          <a className="saas-sidebar-link saas-sidebar-link--muted" href="/legacy" target="_blank" rel="noreferrer">
            {tx('saas.nav.legacyDashboard')}
          </a>
        </div>
      </aside>

      <div className="saas-main">
        <header className="saas-topbar">
          <h1 className="saas-topbar-title">{tx(titleKey)}</h1>
          <div className="saas-topbar-meta">
            {platformScope ? <TenantViewSelector compact /> : null}
            <span className="saas-topbar-clock">{nowText}</span>
            {authConnected ? (
              <span className="saas-topbar-chip">
                {tx('header.statusAuthorized', { n: shopSummary.totalAuthorized })}
              </span>
            ) : null}
            <label className="saas-locale">
              <select
                value={locale}
                onChange={(e) => setLocale(normalizeLocale(e.target.value))}
                className="locale-select"
              >
                {LOCALES.map((loc) => (
                  <option key={loc} value={loc}>
                    {tx(`locale.${loc}`)}
                  </option>
                ))}
              </select>
            </label>
            <span className="saas-topbar-user">{appUsername}</span>
            <button type="button" className="saas-topbar-btn" onClick={() => onLogout()}>
              {tx('dashboard.menu.logout')}
            </button>
          </div>
        </header>
        {planBanner ? (
          <div className="saas-plan-banner" role="status">
            {planBanner}
          </div>
        ) : null}
        <main className="saas-main-content">{children}</main>
      </div>
    </div>
  )
}
