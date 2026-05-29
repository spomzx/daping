/**
 * TikTok / OpenAPI 订单状态：统一中文展示 + 规范化 key（供筛选与统计）
 * 与 frontend/src/App.tsx 保持语义一致
 */

/** @type {Record<string, string>} 任意大小写 / TikTok 原始值 -> 中文 */
const ORDER_STATUS_MAP = {
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

  // 常见别名 / 旧字段
  unpaid: '未付款',
  unknown: '未知',
  pending: '待付款',
  shipped: '待发货',
  ready_to_ship: '待发货',
  to_ship: '待发货',
  partially_shipped: '部分发货',
  awaiting_package: '待揽收',
};

/** 中文标签 -> 规范化小写 key（用于筛选） */
const LABEL_TO_CANON = {
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
};

const KNOWN_ZH = new Set(Object.values(ORDER_STATUS_MAP));

/**
 * @param {unknown} raw
 * @returns {string}
 */
function orderStatusToZh(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return '未知状态(空)';
  if (KNOWN_ZH.has(text)) return text;
  if (ORDER_STATUS_MAP[text]) return ORDER_STATUS_MAP[text];
  const lower = text.toLowerCase();
  if (ORDER_STATUS_MAP[lower]) return ORDER_STATUS_MAP[lower];
  const upper = text.toUpperCase();
  if (ORDER_STATUS_MAP[upper]) return ORDER_STATUS_MAP[upper];
  if (/[\u4e00-\u9fff]/.test(text)) return `未知状态(${text})`;
  return `未知状态(${text})`;
}

/**
 * @param {unknown} raw
 * @returns {string}
 */
function toCanonicalOrderStatus(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return '';
  if (text.startsWith('未知状态(')) return 'unknown';
  if (LABEL_TO_CANON[text]) return LABEL_TO_CANON[text];
  const lower = text.toLowerCase();
  if (ORDER_STATUS_MAP[lower]) {
    const zh = ORDER_STATUS_MAP[lower];
    return LABEL_TO_CANON[zh] || lower;
  }
  const upper = text.toUpperCase();
  if (ORDER_STATUS_MAP[upper]) {
    const zh = ORDER_STATUS_MAP[upper];
    return LABEL_TO_CANON[zh] || upper.toLowerCase();
  }
  return lower;
}

module.exports = {
  ORDER_STATUS_MAP,
  orderStatusToZh,
  toCanonicalOrderStatus,
  KNOWN_ZH,
};
