import type { ReactNode } from 'react'
import { SaasLayout, type SaasLayoutProps } from '../components/layout/SaasLayout'
import './styles/admin-design-tokens.css'
import './styles/admin-dashboard-shell.css'
import './styles/saas-admin.css'
import './styles/admin-layout.css'
import './styles/admin-common.css'
import './styles/admin-app-legacy.css'
import './styles/admin-sync.css'
import './styles/admin-users.css'
import './styles/admin-tenants.css'
import './styles/admin-shops.css'
import './styles/admin-layout-system.css'
import '../components/admin/admin-components.css'
import '../components/admin/admin-table-system.css'
import './styles/analytics-overview-page.css'
import '../components/tenant-view-selector.admin.css'

export type AdminLayoutProps = SaasLayoutProps

/**
 * SaaS 管理后台根节点：所有 admin 样式必须挂在 .saas-admin 下。
 * 禁止在此引入 legacy-app.css / App.css。
 */
export function AdminLayout(props: AdminLayoutProps) {
  return (
    <div className="saas-admin">
      <SaasLayout {...props} />
    </div>
  )
}

export function AdminPage({ children }: { children: ReactNode }) {
  return <div className="saas-admin-page">{children}</div>
}
