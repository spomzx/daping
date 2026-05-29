import type { CSSProperties } from 'react'

/** Analytics 页市场色（与后端 market_color 约定一致，不新增接口） */
const MARKET_HEX: Record<string, string> = {
  TH: '#00E5FF',
  MY: '#4DFFB8',
  PH: '#FFD54F',
  VN: '#FF8A65',
  SG: '#B388FF',
}

export function analyticsMarketHex(market: string): string {
  const m = String(market || '')
    .trim()
    .toUpperCase()
  return MARKET_HEX[m] || '#90A4AE'
}

export function analyticsMarketBadgeStyle(market: string): CSSProperties {
  const c = analyticsMarketHex(market)
  return {
    borderColor: c,
    color: c,
    boxShadow: `0 0 8px ${c}40`,
  }
}

/** 订单号缩略展示，hover 用 title 显示完整 */
export function abbrevPlatformOrderId(raw: string, head = 10, tail = 4): string {
  const s = String(raw || '').trim()
  if (!s) return '—'
  if (s.length <= head + tail + 3) return s
  return `${s.slice(0, head)}…${s.slice(-tail)}`
}
