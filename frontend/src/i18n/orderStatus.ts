import { createT, messages, type Locale } from './index'

/** 与 backend/lib/orderStatusZh.js 对齐：任意原始值 -> 中文标签（内部标准形） */
export const ORDER_STATUS_MAP: Record<string, string> = {
  UNPAID: '未付款',
  AWAITING_PAYMENT: '待付款',
  pending_payment: '待付款',
  awaiting_payment: '待付款',
  ON_HOLD: '挂起',
  on_hold: '挂起',
  AWAITING_SHIPMENT: '待发货',
  awaiting_shipment: '待发货',
  AWAITING_COLLECTION: '待揽收',
  awaiting_collection: '待揽收',
  PARTIALLY_SHIPPING: '部分发货',
  partially_shipping: '部分发货',
  IN_TRANSIT: '运输中',
  in_transit: '运输中',
  DELIVERED: '已送达',
  delivered: '已送达',
  COMPLETED: '已完成',
  completed: '已完成',
  PAID: '已支付',
  paid: '已支付',
  CANCELLED: '已取消',
  CANCELED: '已取消',
  cancelled: '已取消',
  canceled: '已取消',
  buyer_cancel: '买家取消',
  seller_cancel: '卖家取消',
  RETURNED: '已退货',
  returned: '已退货',
  REFUND: '退款中',
  refund: '退款中',
  REFUNDED: '已退款',
  refunded: '已退款',
  unpaid: '未付款',
  unknown: '未知',
  pending: '待付款',
  shipped: '待发货',
  ready_to_ship: '待发货',
  to_ship: '待发货',
  partially_shipped: '部分发货',
  awaiting_package: '待揽收',
  sample_order: '样品订单',
  SAMPLE_ORDER: '样品订单',
  is_sample_order: '样品订单',
}

export const LABEL_TO_CANON: Record<string, string> = {
  已取消: 'cancelled',
  买家取消: 'buyer_cancel',
  卖家取消: 'seller_cancel',
  挂起: 'on_hold',
  未付款: 'unpaid',
  待付款: 'awaiting_payment',
  待发货: 'awaiting_shipment',
  待揽收: 'awaiting_collection',
  部分发货: 'partially_shipping',
  运输中: 'in_transit',
  已送达: 'delivered',
  已完成: 'completed',
  已支付: 'paid',
  退款中: 'refund',
  已退款: 'refunded',
  已退货: 'returned',
  未知: 'unknown',
  样品订单: 'sample_order',
}

const KNOWN_ZH = new Set(Object.values(ORDER_STATUS_MAP))

export function orderStatusToZh(raw: unknown): string {
  const text = String(raw ?? '').trim()
  if (!text) return '未知状态(空)'
  if (KNOWN_ZH.has(text)) return text
  if (ORDER_STATUS_MAP[text]) return ORDER_STATUS_MAP[text]
  const lower = text.toLowerCase()
  if (ORDER_STATUS_MAP[lower]) return ORDER_STATUS_MAP[lower]
  const upper = text.toUpperCase()
  if (ORDER_STATUS_MAP[upper]) return ORDER_STATUS_MAP[upper]
  if (/[\u4e00-\u9fff]/.test(text)) return `未知状态(${text})`
  return `未知状态(${text})`
}

export function toCanonicalOrderStatus(statusRaw: string): string {
  const text = String(statusRaw ?? '').trim()
  if (!text) return ''
  if (text.startsWith('未知状态(')) return 'unknown'
  if (LABEL_TO_CANON[text]) return LABEL_TO_CANON[text]
  const lower = text.toLowerCase()
  if (ORDER_STATUS_MAP[lower]) {
    const zh = ORDER_STATUS_MAP[lower]
    return LABEL_TO_CANON[zh] || lower
  }
  const upper = text.toUpperCase()
  if (ORDER_STATUS_MAP[upper]) {
    const zh = ORDER_STATUS_MAP[upper]
    return LABEL_TO_CANON[zh] || upper.toLowerCase()
  }
  return lower
}

const CANON_TO_STATUS_KEY: Record<string, string> = {
  awaiting_payment: 'order.status.awaiting_payment',
  unpaid: 'order.status.unpaid',
  on_hold: 'order.status.on_hold',
  awaiting_shipment: 'order.status.awaiting_shipment',
  partially_shipping: 'order.status.partially_shipping',
  awaiting_collection: 'order.status.awaiting_collection',
  in_transit: 'order.status.in_transit',
  delivered: 'order.status.delivered',
  completed: 'order.status.completed',
  paid: 'order.status.paid',
  cancelled: 'order.status.cancelled',
  buyer_cancel: 'order.status.buyer_cancel',
  seller_cancel: 'order.status.seller_cancel',
  refund: 'order.status.refund',
  refunded: 'order.status.refunded',
  returned: 'order.status.returned',
  unknown: 'order.status.unknown',
  sample_order: 'order.status.sample',
}

export function translateOrderStatus(statusRaw: string, locale: Locale): string {
  const tt = createT(locale)
  const zh = orderStatusToZh(statusRaw)
  if (zh === '未知状态(空)') return tt('order.status.unknown_empty')
  if (zh.startsWith('未知状态(')) {
    const m = /^未知状态\((.+)\)$/.exec(zh)
    const inner = m ? m[1] : zh
    return tt('order.status.unknown_raw', { text: inner })
  }
  const canon = LABEL_TO_CANON[zh] || toCanonicalOrderStatus(statusRaw)
  const key = CANON_TO_STATUS_KEY[canon]
  if (key) {
    const bag = messages[locale] ?? messages.en
    const raw = bag[key] ?? messages.en[key]
    if (raw) return tt(key)
  }
  return tt('order.status.unknown')
}

export function orderStatusBadgeClass(statusRaw: string): string {
  const zh = orderStatusToZh(statusRaw)
  const canon = LABEL_TO_CANON[zh] || toCanonicalOrderStatus(statusRaw) || 'unknown'
  if (canon === 'unknown' || zh.startsWith('未知状态(')) return 'order-status-pill order-status--unknown'
  switch (canon) {
    case 'awaiting_payment':
    case 'unpaid':
      return 'order-status-pill order-status--pending-pay'
    case 'on_hold':
    case 'sample_order':
      return 'order-status-pill order-status--on-hold'
    case 'awaiting_shipment':
    case 'partially_shipping':
      return 'order-status-pill order-status--await-ship'
    case 'awaiting_collection':
      return 'order-status-pill order-status--await-collect'
    case 'in_transit':
      return 'order-status-pill order-status--in-transit'
    case 'delivered':
    case 'completed':
    case 'paid':
      return 'order-status-pill order-status--done'
    case 'cancelled':
    case 'buyer_cancel':
    case 'seller_cancel':
      return 'order-status-pill order-status--cancel'
    case 'refund':
    case 'refunded':
      return 'order-status-pill order-status--refund'
    case 'returned':
      return 'order-status-pill order-status--returned'
    default:
      return 'order-status-pill order-status--unknown'
  }
}
