import type { ReactNode } from 'react'
import { DashboardHeader, type AppPageContext, type DashboardHeaderProps } from './DashboardHeader'

export type DashboardShellProps = Omit<DashboardHeaderProps, 'pageContext' | 'metaSlot'> & {
  pageContext: AppPageContext
  children: ReactNode
  metaSlot?: ReactNode
  mainClassName?: string
  cardClassName?: string
}

/** 各业务页统一：war-room + DashboardHeader + tech-panel 主内容 */
export function DashboardShell({
  children,
  pageContext,
  metaSlot,
  mainClassName = 'app-shell-main',
  cardClassName = 'tech-panel app-shell-card',
  ...headerProps
}: DashboardShellProps) {
  return (
    <div className={`war-room app-shell-page dashboard-shell app-shell-page--${pageContext}`}>
      <DashboardHeader {...headerProps} pageContext={pageContext} metaSlot={metaSlot} />
      <main className={mainClassName}>
        <section className={cardClassName}>{children}</section>
      </main>
    </div>
  )
}
