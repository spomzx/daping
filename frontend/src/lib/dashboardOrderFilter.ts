import type { DashboardOrderFilter } from './dashboardFilters'

const UNPAID = new Set(['unpaid', 'awaiting_payment', 'pending_payment'])
const EXCLUDED_VALID = new Set([
  'cancelled',
  'canceled',
  'buyer_cancel',
  'seller_cancel',
  'on_hold',
  'refund',
  'refunded',
  'unpaid',
  'unknown',
])
const VALID = new Set([
  'awaiting_shipment',
  'awaiting_collection',
  'partially_shipping',
  'in_transit',
  'delivered',
  'completed',
  'paid',
  'pending_payment',
  'awaiting_payment',
  'returned',
  'shipped',
  'ready_to_ship',
  'partially_shipped',
  'awaiting_package',
  'to_ship',
])

function canonStatus(raw: string): string {
  return String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_')
}

function isCancelledStatus(raw: string): boolean {
  const s = String(raw || '').trim()
  if (!s) return false
  if (s === '已取消' || s === '买家取消' || s === '卖家取消') return true
  const lower = s.toLowerCase()
  if (['cancelled', 'canceled', 'buyer_cancel', 'seller_cancel', 'cancel'].includes(lower)) return true
  if (lower.includes('cancel')) return true
  return false
}

export function inferOrderIsSample(row: Record<string, unknown>): boolean {
  if (row.isSample === true || row.is_sample === true) return true
  if (row.is_sample_order === true) return true
  const st = String(row.orderStatus ?? row.order_status ?? row.status ?? row.analytics_status ?? '')
  if (st === 'sample' || st.includes('样品')) return true
  if (/sample/i.test(st)) return true
  return false
}

export function orderMatchesDashboardFilter(
  row: {
    orderStatus?: string
    status?: string
    analytics_status?: string
    isSample?: boolean
    is_sample?: boolean
    totalAmount?: number
    total_amount?: number
    paid_at?: string | null
    paidTime?: string | null
  },
  filter: DashboardOrderFilter,
): boolean {
  const ast = String(row.analytics_status ?? '').trim().toLowerCase()
  if (ast) {
    if (filter === 'all') return true
    if (filter === 'valid') return ast === 'valid'
    if (filter === 'cancelled') return ast === 'cancelled'
    if (filter === 'sample') return ast === 'sample'
    if (filter === 'unpaid') return ast === 'unpaid'
    if (filter === 'paid') {
      if (ast === 'sample' || ast === 'unpaid') return false
      if (ast === 'valid') return true
      if (ast === 'cancelled') {
        const amt = Number(row.totalAmount ?? row.total_amount ?? 0)
        if (amt > 0) return true
        if (row.paid_at != null && String(row.paid_at).trim() !== '') return true
        if (row.paidTime != null && String(row.paidTime).trim() !== '') return true
        return false
      }
      return false
    }
  }

  if (filter === 'sample') {
    return inferOrderIsSample(row as Record<string, unknown>)
  }
  if (filter === 'cancelled') {
    return isCancelledStatus(String(row.orderStatus ?? row.status ?? ''))
  }
  const raw = String(row.orderStatus ?? row.status ?? '').trim()
  if (!raw) return filter === 'all'
  const canon = canonStatus(raw)
  if (filter === 'all') return true
  if (filter === 'unpaid') return UNPAID.has(canon)
  if (filter === 'valid') {
    if (!canon) return false
    if (EXCLUDED_VALID.has(canon)) return false
    return VALID.has(canon)
  }
  if (filter === 'paid') {
    if (inferOrderIsSample(row as Record<string, unknown>)) return false
    if (UNPAID.has(canon)) return false
    const amt = Number(row.totalAmount ?? row.total_amount ?? 0)
    if (isCancelledStatus(raw)) return amt > 0
    if (!canon) return false
    if (EXCLUDED_VALID.has(canon)) return false
    return VALID.has(canon)
  }
  return true
}
