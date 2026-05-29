import { Link, NavLink } from 'react-router-dom'
import { groupSaasNavItems, type SaasNavItem } from '../../config/saasNav'
import { useI18n } from '../../i18n'
import { SaasNavIcon } from './SaasNavIcon'

type SaasSidebarProps = {
  navItems: SaasNavItem[]
  showConnectCta: boolean
}

export function SaasSidebar({ navItems, showConnectCta }: SaasSidebarProps) {
  const { t: tx } = useI18n()
  const groups = groupSaasNavItems(navItems)

  return (
    <aside className="dashboard-sidebar" aria-label={tx('saas.nav.label')}>
      <div className="dashboard-sidebar__brand">
        <span className="dashboard-sidebar__logo" aria-hidden />
        <div className="dashboard-sidebar__brand-text">
          <span className="dashboard-sidebar__title">{tx('app.title')}</span>
          <span className="dashboard-sidebar__sub">SaaS Console</span>
        </div>
      </div>

      <nav className="dashboard-sidebar__nav">
        {groups.map(({ group, items }) => (
          <div key={group.id} className="dashboard-sidebar__group">
            <div className="dashboard-sidebar__group-label">{tx(group.labelKey)}</div>
            <ul className="dashboard-sidebar__list">
              {items.map((item) => (
                <li key={item.id}>
                  <NavLink
                    to={item.path}
                    className={({ isActive }) =>
                      `dashboard-sidebar__link${isActive ? ' dashboard-sidebar__link--active' : ''}`
                    }
                    end={item.path === '/dashboard' || item.path === '/legacy'}
                  >
                    <SaasNavIcon name={item.icon} />
                    <span className="dashboard-sidebar__link-text">{tx(item.labelKey)}</span>
                  </NavLink>
                </li>
              ))}
            </ul>
          </div>
        ))}

        {showConnectCta ? (
          <div className="dashboard-sidebar__group">
            <Link to="/shops" className="dashboard-sidebar__link dashboard-sidebar__link--cta">
              <SaasNavIcon name="key" />
              <span className="dashboard-sidebar__link-text">{tx('nav.connectTiktok')}</span>
            </Link>
          </div>
        ) : null}
      </nav>
    </aside>
  )
}
