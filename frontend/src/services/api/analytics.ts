import { apiFetch } from './client'
import { getAuthHeaders } from '../../authStorage'

export async function fetchAnalyticsJson<T>(path: string, query?: Record<string, string>): Promise<T> {
  const qs = query ? `?${new URLSearchParams(query).toString()}` : ''
  const res = await apiFetch(`${path}${qs}`, {
    headers: { ...getAuthHeaders() },
    cache: 'no-store',
  })
  if (!res.ok) throw new Error(`analytics_http_${res.status}`)
  return res.json() as Promise<T>
}
