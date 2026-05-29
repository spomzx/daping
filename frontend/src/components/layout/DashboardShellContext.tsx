import { createContext, useContext, type ReactNode } from 'react'
import type { ShopSummaryState } from '../../hooks/useAppShellHeader'

export type DashboardShellContextValue = {
  pageTitleKey: string
  nowText: string
  shopSummary: ShopSummaryState
  summaryError: boolean
  authConnected: boolean
  fetchShopSummary: () => Promise<void>
}

const DashboardShellContext = createContext<DashboardShellContextValue | null>(null)

export function DashboardShellProvider({
  value,
  children,
}: {
  value: DashboardShellContextValue
  children: ReactNode
}) {
  return <DashboardShellContext.Provider value={value}>{children}</DashboardShellContext.Provider>
}

export function useDashboardShell(): DashboardShellContextValue {
  const ctx = useContext(DashboardShellContext)
  if (!ctx) {
    throw new Error('useDashboardShell must be used within DashboardShellProvider')
  }
  return ctx
}

export function useDashboardShellOptional(): DashboardShellContextValue | null {
  return useContext(DashboardShellContext)
}
