import { apiGet } from './client'

export type ExchangeRateResponse = {
  baseCurrency: string
  targetCurrency: string
  rate: number
  updatedAt?: string
  source?: string
  status?: string
}

export function fetchExchangeRate(query?: Record<string, string>) {
  return apiGet<ExchangeRateResponse>('/api/exchange-rate', query)
}
