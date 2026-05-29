import { useCallback, useEffect, useState } from 'react'
import { apiFetch } from '../apiClient'
import { AUTH_TOKEN_KEY, getAuthHeaders } from '../authStorage'

export type ShopSummaryState = {
  totalAuthorized: number
  enabledCount: number
  todayOrderShopCount: number
  abnormalCount: number
}

export function useAppShellHeader() {
  const [nowText, setNowText] = useState(() => new Date().toLocaleString())
  const [shopSummary, setShopSummary] = useState<ShopSummaryState>({
    totalAuthorized: 0,
    enabledCount: 0,
    todayOrderShopCount: 0,
    abnormalCount: 0,
  })
  const [summaryError, setSummaryError] = useState(false)

  useEffect(() => {
    const id = window.setInterval(() => setNowText(new Date().toLocaleString()), 1000)
    return () => window.clearInterval(id)
  }, [])

  const fetchShopSummary = useCallback(() => {
    const token = typeof localStorage !== 'undefined' ? localStorage.getItem(AUTH_TOKEN_KEY) : null
    if (!token) return Promise.resolve()
    setSummaryError(false)
    return apiFetch('/api/shops/summary', { headers: { ...getAuthHeaders() }, cache: 'no-store' })
      .then((r) => {
        if (!r.ok) {
          setSummaryError(true)
          return null
        }
        return r.json()
      })
      .then((j) => {
        if (!j || typeof j !== 'object') return
        setShopSummary({
          totalAuthorized: Number((j as { totalAuthorized?: number }).totalAuthorized ?? 0),
          enabledCount: Number((j as { enabledCount?: number }).enabledCount ?? 0),
          todayOrderShopCount: Number((j as { todayOrderShopCount?: number }).todayOrderShopCount ?? 0),
          abnormalCount: Number((j as { abnormalCount?: number }).abnormalCount ?? 0),
        })
      })
      .catch(() => setSummaryError(true))
  }, [])

  useEffect(() => {
    void fetchShopSummary()
  }, [fetchShopSummary])

  useEffect(() => {
    const onTenant = () => void fetchShopSummary()
    window.addEventListener('daping:platform-view-tenant', onTenant)
    return () => window.removeEventListener('daping:platform-view-tenant', onTenant)
  }, [fetchShopSummary])

  return { nowText, shopSummary, summaryError, fetchShopSummary, authConnected: shopSummary.totalAuthorized > 0 }
}
