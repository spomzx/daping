/** 兼容入口：实现位于 ./i18n/ */
export * from './i18n/index'
export {
  ORDER_STATUS_MAP,
  LABEL_TO_CANON,
  orderStatusToZh,
  toCanonicalOrderStatus,
  translateOrderStatus,
  orderStatusBadgeClass,
} from './i18n/orderStatus'
