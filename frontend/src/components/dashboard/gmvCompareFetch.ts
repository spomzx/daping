import { fetchWithAuth } from '../../apiClient'

export type GmvComparePayload = {
  today: { bucket: string; gmv: number }[]
  yesterday: { bucket: string; gmv: number }[]
  summary: { todayTotal: number; yesterdayTotal: number; changePercent: number | null }
  gmv_currency?: string
  meta?: { seriesEmpty?: boolean; emptyReason?: string }
}

/** SaaS Dashboard：compare 失败时返回 null，由图表展示占位文案 */
export async function fetchGmvCompareSafe(
  query: Record<string, string | undefined>,
  signal?: AbortSignal,
): Promise<GmvComparePayload | null> {
  const qs = new URLSearchParams()
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== '') qs.set(k, v)
  }
  try {
    const res = await fetchWithAuth(`/api/analytics/gmv-compare?${qs}`, {
      cache: 'no-store',
      signal,
    })
    if (!res.ok) return null
    return (await res.json()) as GmvComparePayload
  } catch {
    return null
  }
}
