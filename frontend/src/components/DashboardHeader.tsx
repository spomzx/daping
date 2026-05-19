import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { isAdminLike, isPlatformScope, isViewerLike, type AccountAccess, type MeRole, type UserScope } from '../authRole'
import { LOCALES, normalizeLocale, useI18n } from '../i18n'

const TARGET_OPTIONS = ['USD', 'CNY', 'THB', 'SGD', 'MYR', 'PHP', 'VND'] as const

export type AppPageContext = 'dashboard' | 'shops' | 'analytics' | 'users'

const CRUMB_I18N: Record<Exclude<AppPageContext, 'dashboard'>, string> = {
  shops: 'shopMgmt.drawerTitle',
  analytics: 'dashboard.menu.analytics',
  users: 'dashboard.menu.users',
}

export type DashboardHeaderProps = {
  appRole: MeRole
  appUserScope?: UserScope
  appUsername: string
  appAccess: AccountAccess
  platformScope: boolean
  authConnected: boolean
  shopSummary: { totalAuthorized: number; todayOrderShopCount: number }
  activeShopCount: number
  nowText: string
  marketStatsTimezoneHeadline: string
  displayBase: string
  displayTarget: string
  displayRate: number
  rateUpdatedAt: string
  baseCurrency: string
  targetCurrency: string
  onBaseCurrencyChange: (value: string) => void
  onTargetCurrencyChange: (value: string) => void
  onRefreshRate: () => Promise<void>
  onLogout: () => void
  onOpenShops: () => void
  metaSlot?: ReactNode
  pageContext?: AppPageContext
}

export function DashboardHeader({
  appRole,
  appUserScope,
  appUsername,
  platformScope,
  authConnected,
  shopSummary,
  activeShopCount,
  nowText,
  marketStatsTimezoneHeadline,
  displayBase,
  displayTarget,
  displayRate,
  rateUpdatedAt,
  baseCurrency,
  targetCurrency,
  onBaseCurrencyChange,
  onTargetCurrencyChange,
  onRefreshRate,
  onLogout,
  onOpenShops,
  metaSlot,
  pageContext = 'dashboard',
}: DashboardHeaderProps) {
  const nav = useNavigate()
  const { locale, setLocale, t: tx } = useI18n()
  const [userMenuOpen, setUserMenuOpen] = useState(false)
  const [ratePanelOpen, setRatePanelOpen] = useState(false)
  const userMenuRef = useRef<HTMLDivElement | null>(null)

  const isViewer = isViewerLike(appRole)
  const isPlatform = platformScope || isPlatformScope({ scope: appUserScope, role: appRole })
  const canManageUsers = isPlatform || isAdminLike(appRole)
  const canManageShops = isPlatform || isAdminLike(appRole)

  const accountInitial = useMemo(() => {
    const ch = appUsername.trim().charAt(0)
    return ch ? ch.toUpperCase() : 'A'
  }, [appUsername])

  useEffect(() => {
    if (!userMenuOpen) {
      setRatePanelOpen(false)
      return
    }
    const onDocClick = (ev: MouseEvent) => {
      const t = ev.target as Node
      if (userMenuRef.current?.contains(t)) return
      setUserMenuOpen(false)
    }
    document.addEventListener('click', onDocClick, true)
    return () => document.removeEventListener('click', onDocClick, true)
  }, [userMenuOpen])

  const activeCount = shopSummary.todayOrderShopCount || activeShopCount

  const go = (path: string, ctx: AppPageContext) => {
    if (pageContext === ctx) return
    nav(path)
  }

  return (
    <header className="war-header war-header--saas">
      <div className="war-header-saas-row">
        <div className="war-header-brand">
          {pageContext === 'dashboard' ? (
            <h1 className="war-header-title-main">{tx('app.title')}</h1>
          ) : (
            <nav className="war-header-crumb" aria-label={tx(CRUMB_I18N[pageContext])}>
              <button type="button" className="war-header-crumb-link" onClick={() => nav('/')}>
                {tx('app.title')}
              </button>
              <span className="war-header-crumb-sep" aria-hidden>
                /
              </span>
              <span className="war-header-crumb-current">{tx(CRUMB_I18N[pageContext])}</span>
            </nav>
          )}
          <label className="locale-switch war-header-locale">
            <span className="sr-only">Language</span>
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
        </div>

        <div className="war-header-status-center">
          <p className="war-header-clock">{nowText}</p>
          <div className="war-header-status-chips" aria-label={tx('header.statusRegionLabel')}>
            {authConnected ? (
              <>
                <span className="war-header-status-chip war-header-status-chip--auth">
                  <span className="war-header-status-dot war-header-status-dot--green" aria-hidden />
                  {tx('header.statusAuthorized', { n: shopSummary.totalAuthorized })}
                </span>
                <span className="war-header-status-chip war-header-status-chip--active">
                  <span className="war-header-status-dot war-header-status-dot--blue" aria-hidden />
                  {tx('header.statusActiveShops', { n: activeCount })}
                </span>
              </>
            ) : (
              <span className="war-header-status-chip war-header-status-chip--muted">
                {tx('nav.notAuthorized')}
              </span>
            )}
          </div>
          <div className="war-header-subline war-header-subline--center">
            <span title={tx('meta.timezoneHint')}>{marketStatsTimezoneHeadline}</span>
            <span>{`${displayTarget} / ${displayBase}`}</span>
          </div>
        </div>

        <nav className="war-header-nav war-header-nav--unified" aria-label={tx('header.navRegionLabel')}>
          {canManageShops ? (
            <button
              type="button"
              className={`war-header-btn${pageContext === 'shops' ? ' war-header-btn--active' : ''}`}
              aria-current={pageContext === 'shops' ? 'page' : undefined}
              onClick={() => {
                if (pageContext === 'shops') return
                onOpenShops()
              }}
            >
              {authConnected ? tx('header.navShops') : tx('nav.connectTiktok')}
            </button>
          ) : isViewer ? (
            <span className="war-header-hint">{tx('header.viewerReadonly')}</span>
          ) : null}
          <button
            type="button"
            className="war-header-btn"
            onClick={() => go('/dashboard', 'analytics')}
          >
            {tx('dashboard.menu.console')}
          </button>
          {canManageUsers ? (
            <button
              type="button"
              className={`war-header-btn${pageContext === 'users' ? ' war-header-btn--active' : ''}`}
              aria-current={pageContext === 'users' ? 'page' : undefined}
              onClick={() => go('/users', 'users')}
            >
              {tx('dashboard.menu.users')}
            </button>
          ) : null}
          <div className="war-header-account" ref={userMenuRef}>
            <button
              type="button"
              className="war-header-btn war-header-btn--account"
              aria-expanded={userMenuOpen}
              aria-haspopup="menu"
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation()
                setUserMenuOpen((v) => !v)
              }}
            >
              <span className="war-header-avatar" aria-hidden>
                {accountInitial}
              </span>
              <span className="war-header-account-name">{appUsername}</span>
              <span className="war-header-account-caret" aria-hidden>
                ▼
              </span>
            </button>
            {userMenuOpen ? (
              <div className="war-header-account-dropdown" role="menu">
                <button
                  type="button"
                  className="war-header-account-item"
                  role="menuitem"
                  onClick={(e) => {
                    e.stopPropagation()
                    setRatePanelOpen((v) => !v)
                  }}
                >
                  {tx('header.exchangeRateSettings')}
                </button>
                {ratePanelOpen ? (
                  <div className="war-header-rate-panel tech-panel">
                    <h3 className="war-header-rate-title">{tx('rate.panelTitle')}</h3>
                    <div className="rate-compact-row rate-popover-inner">
                      <label className="rate-field rate-field-inline">
                        <span>{tx('rate.base')}</span>
                        <select value={baseCurrency} onChange={(e) => onBaseCurrencyChange(e.target.value)}>
                          {TARGET_OPTIONS.map((item) => (
                            <option value={item} key={`base-${item}`}>
                              {item}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="rate-field rate-field-inline">
                        <span>{tx('rate.target')}</span>
                        <select value={targetCurrency} onChange={(e) => onTargetCurrencyChange(e.target.value)}>
                          {TARGET_OPTIONS.map((item) => (
                            <option value={item} key={item}>
                              {item}
                            </option>
                          ))}
                        </select>
                      </label>
                      <div className="rate-compact-item">
                        <span>{tx('rate.current')}</span>
                        <strong>
                          1 {displayBase} = {displayRate.toFixed(4)} {displayTarget}
                        </strong>
                      </div>
                      <div className="rate-compact-item">
                        <span>{tx('rate.updatedAt')}</span>
                        <strong>{rateUpdatedAt}</strong>
                      </div>
                      <button
                        type="button"
                        className="refresh-btn"
                        onClick={() => {
                          void onRefreshRate()
                        }}
                      >
                        {tx('rate.manualRefresh')}
                      </button>
                    </div>
                    {baseCurrency === targetCurrency ? (
                      <div className="warn-text">{tx('rate.sameCurrencyWarn')}</div>
                    ) : null}
                  </div>
                ) : null}
                {isPlatform ? (
                  <button type="button" className="war-header-account-item" disabled role="menuitem">
                    {tx('header.systemSettings')}
                  </button>
                ) : null}
                <button
                  type="button"
                  className="war-header-account-item war-header-account-item--danger"
                  role="menuitem"
                  onClick={() => {
                    setUserMenuOpen(false)
                    onLogout()
                  }}
                >
                  {tx('header.logout')}
                </button>
              </div>
            ) : null}
          </div>
        </nav>
      </div>

      {metaSlot ? <div className="war-header-meta">{metaSlot}</div> : null}
    </header>
  )
}
