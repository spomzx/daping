import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import { fetchTenantPlans, type TenantPlanRow } from '../services/api/tenants'
import { getPlatformViewTenantId, setPlatformViewTenantId } from '../lib/platformViewTenant'

type PlatformViewTenantContextValue = {
  tenants: TenantPlanRow[]
  viewingTenantId: number | null
  viewingTenant: TenantPlanRow | null
  loading: boolean
  ready: boolean
  initError: string | null
  setViewingTenantId: (id: number | null) => void
  refreshTenants: () => Promise<void>
}

const PlatformViewTenantContext = createContext<PlatformViewTenantContextValue | null>(null)

export function PlatformViewTenantProvider({ children }: { children: ReactNode }) {
  const [tenants, setTenants] = useState<TenantPlanRow[]>([])
  const [loading, setLoading] = useState(true)
  const [ready, setReady] = useState(false)
  const [initError, setInitError] = useState<string | null>(null)
  const [viewingTenantId, setViewingTenantIdState] = useState<number | null>(() => getPlatformViewTenantId())

  const refreshTenants = useCallback(async () => {
    setLoading(true)
    setInitError(null)
    try {
      const res = await fetchTenantPlans({ page: 1, page_size: 500 })
      const rows = res.list
      setTenants(rows)
      const stored = getPlatformViewTenantId()
      const validStored = stored != null && rows.some((r) => r.id === stored) ? stored : null
      setPlatformViewTenantId(validStored)
      setViewingTenantIdState(validStored)
    } catch (e) {
      setTenants([])
      setInitError(e instanceof Error ? e.message : '加载租户列表失败')
    } finally {
      setLoading(false)
      setReady(true)
    }
  }, [])

  useEffect(() => {
    void refreshTenants()
  }, [refreshTenants])

  useEffect(() => {
    const onStorage = () => setViewingTenantIdState(getPlatformViewTenantId())
    window.addEventListener('daping:platform-view-tenant', onStorage)
    return () => window.removeEventListener('daping:platform-view-tenant', onStorage)
  }, [])

  const setViewingTenantId = useCallback((id: number | null) => {
    setPlatformViewTenantId(id)
    setViewingTenantIdState(id)
  }, [])

  const viewingTenant = useMemo(
    () => tenants.find((t) => t.id === viewingTenantId) ?? null,
    [tenants, viewingTenantId],
  )

  const value = useMemo(
    () => ({
      tenants,
      viewingTenantId,
      viewingTenant,
      loading,
      ready,
      initError,
      setViewingTenantId,
      refreshTenants,
    }),
    [tenants, viewingTenantId, viewingTenant, loading, ready, initError, setViewingTenantId, refreshTenants],
  )

  if (!ready || loading) {
    return (
      <PlatformViewTenantContext.Provider value={value}>
        <div className="loading" style={{ padding: 24 }}>
          正在加载租户列表…
        </div>
      </PlatformViewTenantContext.Provider>
    )
  }

  return <PlatformViewTenantContext.Provider value={value}>{children}</PlatformViewTenantContext.Provider>
}

export function usePlatformViewTenant(): PlatformViewTenantContextValue | null {
  return useContext(PlatformViewTenantContext)
}
