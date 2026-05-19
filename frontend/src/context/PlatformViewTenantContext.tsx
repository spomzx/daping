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
  setViewingTenantId: (id: number) => void
  refreshTenants: () => Promise<void>
}

const PlatformViewTenantContext = createContext<PlatformViewTenantContextValue | null>(null)

/** 平台切换默认租户（不含系统租户 default，由 API 已过滤） */
const PREFERRED_TENANT_CODES = ['cqchic', '自用']

function pickDefaultTenantId(rows: TenantPlanRow[]): number | null {
  if (!rows.length) return null

  const matchPreferred = (code: string, requireShops: boolean) =>
    rows.find((r) => {
      const tc = String(r.tenant_code || '').trim().toLowerCase()
      const name = String(r.tenant_name || '').trim().toLowerCase()
      const shops = Number(r.active_shop_count ?? r.current_shops) || 0
      if (requireShops && shops <= 0) return false
      if (r.is_active === 0) return false
      return tc === code || name.includes(code)
    })

  for (const code of PREFERRED_TENANT_CODES) {
    const hit = matchPreferred(code, true)
    if (hit) return hit.id
  }

  const withShops = rows.find((r) => {
    const shops = Number(r.active_shop_count ?? r.current_shops) || 0
    return shops > 0 && r.is_active !== 0
  })
  if (withShops) return withShops.id

  for (const code of PREFERRED_TENANT_CODES) {
    const hit = matchPreferred(code, false)
    if (hit) return hit.id
  }

  return rows[0]?.id ?? null
}

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
      const validStored = stored != null && rows.some((r) => r.id === stored)
      const next = validStored ? stored! : pickDefaultTenantId(rows)
      if (next != null) {
        setPlatformViewTenantId(next)
        setViewingTenantIdState(next)
      } else {
        setPlatformViewTenantId(null)
        setViewingTenantIdState(null)
      }
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

  const setViewingTenantId = useCallback((id: number) => {
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
