import { Link, useLocation } from 'react-router-dom'
import { LOCALES, normalizeLocale, useI18n } from '../../i18n'
import { resolveSaasBreadcrumb } from '../../lib/saasBreadcrumb'
import type { SaasNavItem } from '../../config/saasNav'
import { TenantViewSelector } from '../TenantViewSelector'
import { useDashboardShell } from './DashboardShellContext'

type SaasTopbarProps = {
  navItems: SaasNavItem[]
  appUsername: string
  platformScope: boolean
  onLogout: () => void
}

export function SaasTopbar({ navItems, appUsername, platformScope, onLogout }: SaasTopbarProps) {
  const { locale, setLocale, t: tx } = useI18n()
  const { pageTitleKey, nowText, shopSummary, summaryError, authConnected, fetchShopSummary } = useDashboardShell()

  const { pathname } = useLocation()
  const breadcrumbs = resolveSaasBreadcrumb(pathname, navItems, tx, {
    home: tx('saas.shell.console'),
  })
  const pageTitle = tx(pageTitleKey)

  const statusLabel = summaryError
    ? tx('saas.shell.statusError')
    : authConnected
      ? tx('saas.shell.statusOk', { n: shopSummary.totalAuthorized })
      : tx('saas.shell.statusEmpty')

  return (
    <header className="dashboard-topbar">
      <div className="dashboard-topbar__lead">
        <nav className="dashboard-topbar__breadcrumb" aria-label="Breadcrumb">
          <ol>
            {breadcrumbs.map((crumb, i) => {
              const isLast = i === breadcrumbs.length - 1
              return (
                <li key={`${crumb.label}-${i}`}>
                  {crumb.path && !isLast ? (
                    <Link to={crumb.path}>{crumb.label}</Link>
                  ) : (
                    <span aria-current={isLast ? 'page' : undefined}>{crumb.label}</span>
                  )}
                  {!isLast ? <span className="dashboard-topbar__sep" aria-hidden>/</span> : null}
                </li>
              )
            })}
          </ol>
        </nav>
        <h1 className="dashboard-topbar__title">{pageTitle}</h1>
      </div>

      <div className="dashboard-topbar__actions">
        {platformScope ? <TenantViewSelector compact /> : null}

        <button
          type="button"
          className="admin-btn admin-btn--secondary dashboard-topbar__refresh"
          onClick={() => void fetchShopSummary()}
          title={tx('saas.shell.refreshStatus')}
        >
          {tx('saas.shell.refreshStatus')}
        </button>

        <span
          className={`dashboard-topbar__status${summaryError ? ' dashboard-topbar__status--error' : authConnected ? ' dashboard-topbar__status--ok' : ''}`}
          role="status"
        >
          {statusLabel}
        </span>

        <time className="dashboard-topbar__clock" dateTime={nowText}>
          {nowText}
        </time>

        <label className="dashboard-topbar__locale">
          <select
            value={locale}
            onChange={(e) => setLocale(normalizeLocale(e.target.value))}
            className="locale-select"
            aria-label={tx('locale.zh')}
          >
            {LOCALES.map((loc) => (
              <option key={loc} value={loc}>
                {tx(`locale.${loc}`)}
              </option>
            ))}
          </select>
        </label>

        <span className="dashboard-topbar__user" title={appUsername}>
          {appUsername}
        </span>

        <button type="button" className="admin-btn admin-btn--secondary" onClick={() => onLogout()}>
          {tx('dashboard.menu.logout')}
        </button>
      </div>
    </header>
  )
}
