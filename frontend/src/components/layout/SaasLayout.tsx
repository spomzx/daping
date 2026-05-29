import type { ReactNode } from 'react'
import { useEffect, useState } from 'react'
import { fetchMyTenantPlan, type TenantPlanRow } from '../../services/api/tenants'
import { isAdminLike, isPlatformScope, type AccountAccess, type MeRole, type UserScope } from '../../authRole'
import { useAppShellHeader } from '../../hooks/useAppShellHeader'
import { SAAS_NAV_ITEMS, filterSaasNav } from '../../config/saasNav'
import { DashboardShellProvider } from './DashboardShellContext'
import { SaasSidebar } from './SaasSidebar'
import { SaasTopbar } from './SaasTopbar'
import { ContentShell } from './ContentShell'

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
  const shellHeader = useAppShellHeader()
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

  const showConnectCta = canManageShops && !platformScope && !shellHeader.authConnected

  return (
    <DashboardShellProvider
      value={{
        pageTitleKey: titleKey,
        nowText: shellHeader.nowText,
        shopSummary: shellHeader.shopSummary,
        summaryError: shellHeader.summaryError,
        authConnected: shellHeader.authConnected,
        fetchShopSummary: shellHeader.fetchShopSummary,
      }}
    >
      <div className="dashboard-shell saas-shell">
        <SaasSidebar navItems={navItems} showConnectCta={showConnectCta} />

        <div className="dashboard-shell__main saas-main">
          <SaasTopbar
            navItems={navItems}
            appUsername={appUsername}
            platformScope={platformScope}
            onLogout={onLogout}
          />

          {planBanner ? (
            <div className="saas-plan-banner" role="status">
              {planBanner}
            </div>
          ) : null}

          <main className="dashboard-shell__content saas-main-content saas-main-content--admin-pages">
            <ContentShell>{children}</ContentShell>
          </main>
        </div>
      </div>
    </DashboardShellProvider>
  )
}
