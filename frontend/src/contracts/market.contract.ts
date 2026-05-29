export const MARKET_CODES = ['TH', 'MY', 'PH', 'VN', 'SG'] as const

export type MarketCode = (typeof MARKET_CODES)[number]

const MARKET_ALIASES: Record<string, MarketCode> = {
  th: 'TH',
  thailand: 'TH',
  thai: 'TH',
  'cross-border-th': 'TH',
  my: 'MY',
  malaysia: 'MY',
  ph: 'PH',
  philippines: 'PH',
  vn: 'VN',
  vietnam: 'VN',
  sg: 'SG',
  singapore: 'SG',
}

export function normalizeMarketCode(raw: string | null | undefined): MarketCode | null {
  const key = String(raw || '').trim().toLowerCase()
  if (!key) return null
  const mapped = MARKET_ALIASES[key]
  if (mapped) return mapped
  const upper = key.toUpperCase()
  return (MARKET_CODES as readonly string[]).includes(upper) ? (upper as MarketCode) : null
}

export function displayMarketCode(raw: string | null | undefined): string {
  return normalizeMarketCode(raw) || '—'
}
