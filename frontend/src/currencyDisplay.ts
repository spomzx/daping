/** 与大屏后端 `backend/lib/currency.js` 市场→币种规则一致 */

export const MARKET_TO_ORDER_CURRENCY: Record<string, string> = {
  TH: 'THB',
  MY: 'MYR',
  PH: 'PHP',
  VN: 'VND',
  SG: 'SGD',
}

const ISO = new Set(['THB', 'MYR', 'PHP', 'VND', 'SGD', 'USD', 'CNY'])

export function getCurrencyByMarket(market: string | undefined | null): string | null {
  const m = String(market || '')
    .trim()
    .toUpperCase()
  if (!m) return null
  if (MARKET_TO_ORDER_CURRENCY[m]) return MARKET_TO_ORDER_CURRENCY[m]
  if (m.length >= 2) {
    const two = m.slice(0, 2)
    if (MARKET_TO_ORDER_CURRENCY[two]) return MARKET_TO_ORDER_CURRENCY[two]
  }
  return null
}

export function normalizeCurrency(code: string | undefined | null): string | null {
  const raw = String(code || '')
    .trim()
    .toUpperCase()
  if (!raw) return null
  if (ISO.has(raw)) return raw
  if (MARKET_TO_ORDER_CURRENCY[raw]) return MARKET_TO_ORDER_CURRENCY[raw]
  if (raw.length >= 2) {
    const two = raw.slice(0, 2)
    if (MARKET_TO_ORDER_CURRENCY[two]) return MARKET_TO_ORDER_CURRENCY[two]
  }
  return null
}

/** USD 两位小数；VND 无小数；其余两位 */
export function formatMoneyByCurrency(currency: string, value: number): string {
  const c = String(currency || '').toUpperCase()
  const v = Number.isFinite(value) ? value : 0
  if (c === 'VND') {
    return `${c} ${Math.round(v).toLocaleString('en-US')}`
  }
  return `${c} ${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}
