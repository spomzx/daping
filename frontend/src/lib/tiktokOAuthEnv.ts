/** staging：TikTok 官方 service open authorize（单按钮，不区分本土/跨境） */
export function isStagingTikTokServiceAuth(): boolean {
  if (import.meta.env.VITE_TIKTOK_SERVICE_AUTH === '1') return true
  if (import.meta.env.MODE === 'staging') return true

  const apiBase = String(import.meta.env.VITE_API_BASE_URL || '').toLowerCase()
  if (apiBase.includes('stag.') || apiBase.includes('staging')) return true

  if (typeof window !== 'undefined') {
    const host = window.location.hostname.toLowerCase()
    if (
      host === 'stag.cqchic-cq.top' ||
      host.includes('stag.') ||
      host.startsWith('stag-') ||
      host.includes('staging')
    ) {
      return true
    }
    const origin = window.location.origin.toLowerCase()
    if (origin.includes('stag.') || origin.includes('staging')) return true
  }

  return false
}
