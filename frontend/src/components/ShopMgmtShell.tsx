import { DashboardShell, type DashboardShellProps } from './DashboardShell'

export type ShopMgmtShellProps = Omit<DashboardShellProps, 'pageContext'> & {
  children: React.ReactNode
}

/** 店铺管理全屏页：复用 Dashboard 顶栏 + tech-panel 主内容区 */
export function ShopMgmtShell({ children, ...props }: ShopMgmtShellProps) {
  return (
    <DashboardShell
      pageContext="shops"
      mainClassName="dashboard-main shop-mgmt-main shops-page"
      cardClassName="tech-panel shop-mgmt-page-card shops-table-card"
      {...props}
    >
      {children}
    </DashboardShell>
  )
}
