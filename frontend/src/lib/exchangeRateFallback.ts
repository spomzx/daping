'use strict'

export type ExchangeRatePayload = {
  baseCurrency: string
  targetCurrency: string
  rate: number
  updatedAt: string
  source: string
  status: string
}

const LS_RATE_CACHE = 'daping_exchange_rate_cache_v1'

type RateCacheEntry = {
  base: string
  target: string
  payload: ExchangeRatePayload
  savedAt: number
}

function normCur(c: string): string {
  return String(c || 'USD')
    .trim()
    .toUpperCase()
}

function defaultRateForPair(base: string, target: string): number {
  const b = normCur(base)
  const t = normCur(target)
  if (b === t) return 1
  return 0
}

export function readExchangeRateCache(base: string, target: string): ExchangeRatePayload | null {
  try {
    const raw = localStorage.getItem(LS_RATE_CACHE)
    if (!raw) return null
    const entry = JSON.parse(raw) as RateCacheEntry
    if (!entry?.payload) return null
    if (normCur(entry.base) !== normCur(base) || normCur(entry.target) !== normCur(target)) return null
    const rate = Number(entry.payload.rate)
    if (!Number.isFinite(rate) || rate <= 0) return null
    return {
      ...entry.payload,
      baseCurrency: normCur(base),
      targetCurrency: normCur(target),
      rate,
    }
  } catch {
    return null
  }
}

export function writeExchangeRateCache(base: string, target: string, payload: ExchangeRatePayload): void {
  try {
    const entry: RateCacheEntry = {
      base: normCur(base),
      target: normCur(target),
      payload: {
        ...payload,
        baseCurrency: normCur(base),
        targetCurrency: normCur(target),
        rate: Number(payload.rate),
      },
      savedAt: Date.now(),
    }
    localStorage.setItem(LS_RATE_CACHE, JSON.stringify(entry))
  } catch {
    /* ignore quota */
  }
}

export function buildLoadingExchangeRate(base: string, target: string): ExchangeRatePayload {
  const b = normCur(base)
  const t = normCur(target)
  const cached = readExchangeRateCache(b, t)
  if (cached) {
    return { ...cached, source: 'cache', status: 'cached' }
  }
  return {
    baseCurrency: b,
    targetCurrency: t,
    rate: defaultRateForPair(b, t),
    updatedAt: '',
    source: 'loading',
    status: 'loading',
  }
}

export function buildFallbackExchangeRate(base: string, target: string): ExchangeRatePayload {
  const cached = readExchangeRateCache(base, target)
  if (cached) {
    return {
      ...cached,
      source: 'cache',
      status: 'cached',
    }
  }
  const b = normCur(base)
  const t = normCur(target)
  return {
    baseCurrency: b,
    targetCurrency: t,
    rate: 0,
    updatedAt: new Date().toISOString(),
    source: 'error',
    status: 'missing_rate',
  }
}

export function isSoftRateStatus(status: string | undefined): boolean {
  const s = String(status || '').toLowerCase()
  return s === 'loading' || s === 'cached'
}

export function isMissingRateStatus(status: string | undefined): boolean {
  const s = String(status || '').toLowerCase()
  return s === 'missing_rate' || s === 'error'
}
