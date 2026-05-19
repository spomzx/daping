export type TFn = (key: string, vars?: Record<string, string | number>) => string

type ReconcilePayload = {
  missingInMysql?: { platform: string; platform_order_id: string; shopId?: string | null }[]
  missingInCache?: { platform: string; platform_order_id: string; mysqlAmount: number }[]
  mismatchAmountOrders?: {
    platform: string
    platform_order_id: string
    cacheAmount: number
    mysqlAmount: number
  }[]
  mismatchStatusOrders?: {
    platform: string
    platform_order_id: string
    cacheStatus: string
    mysqlStatus: string
  }[]
  duplicatedOrders?: { platform: string; platform_order_id: string; count: number }[]
  itemMissingInMysql?: {
    platform: string
    platform_order_id: string
    platform_item_id: string
    sku_id: string
    product_id: string
  }[]
  itemMissingInCache?: {
    platform: string
    platform_order_id: string
    platform_item_id: string
    sku_id: string
    product_id: string
    mysqlQuantity: number
    mysqlAmount: number
  }[]
  itemMismatchQuantity?: {
    platform: string
    platform_order_id: string
    platform_item_id: string
    sku_id: string
    product_id: string
    cacheQuantity: number
    mysqlQuantity: number
  }[]
  itemMismatchAmount?: {
    platform: string
    platform_order_id: string
    platform_item_id: string
    sku_id: string
    product_id: string
    cacheAmount: number
    mysqlAmount: number
  }[]
}

const HEALTH_KEY: Record<string, string> = {
  normal: 'shopHealth.normal',
  auth_error: 'shopHealth.authError',
  permission_error: 'shopHealth.permissionError',
  region_error: 'shopHealth.regionError',
  sync_stale: 'shopHealth.syncStale',
  no_orders_today: 'shopHealth.noOrdersToday',
  order_cache_pending: 'shopHealth.orderCachePending',
  api_error: 'shopHealth.apiError',
  token_risk: 'shopHealth.authError',
  sync_off: 'shopHealth.syncOff',
  disabled: 'shopHealth.disabled',
  hidden: 'shopHealth.hidden',
  unknown: 'shopHealth.unknown',
}

export function healthStatusLabel(t: TFn, status: string | null | undefined): string {
  const s = String(status || 'unknown')
  const i18nKey = HEALTH_KEY[s]
  return i18nKey ? t(i18nKey) : s
}

export function buildReconcileIssueLines(t: TFn, r: ReconcilePayload, max = 20): string[] {
  const out: string[] = []
  const missingInMysql = Array.isArray(r.missingInMysql) ? r.missingInMysql : []
  const missingInCache = Array.isArray(r.missingInCache) ? r.missingInCache : []
  const mismatchAmountOrders = Array.isArray(r.mismatchAmountOrders) ? r.mismatchAmountOrders : []
  const mismatchStatusOrders = Array.isArray(r.mismatchStatusOrders) ? r.mismatchStatusOrders : []
  const duplicatedOrders = Array.isArray(r.duplicatedOrders) ? r.duplicatedOrders : []
  for (const x of missingInMysql) {
    if (out.length >= max) break
    out.push(
      t('shopMgmt.reconcile.cacheOnly', {
        platform: x.platform,
        orderId: x.platform_order_id,
        shopSuffix: x.shopId ? t('shopMgmt.reconcile.shopSuffix', { shopId: String(x.shopId) }) : '',
      }),
    )
  }
  for (const x of missingInCache) {
    if (out.length >= max) break
    out.push(
      t('shopMgmt.reconcile.mysqlOnly', {
        platform: x.platform,
        orderId: x.platform_order_id,
        amount: x.mysqlAmount,
      }),
    )
  }
  for (const x of mismatchAmountOrders) {
    if (out.length >= max) break
    out.push(
      t('shopMgmt.reconcile.amountMismatch', {
        platform: x.platform,
        orderId: x.platform_order_id,
        cacheAmount: x.cacheAmount,
        mysqlAmount: x.mysqlAmount,
      }),
    )
  }
  for (const x of mismatchStatusOrders) {
    if (out.length >= max) break
    out.push(
      t('shopMgmt.reconcile.statusMismatch', {
        platform: x.platform,
        orderId: x.platform_order_id,
        cacheStatus: x.cacheStatus,
        mysqlStatus: x.mysqlStatus,
      }),
    )
  }
  for (const x of duplicatedOrders) {
    if (out.length >= max) break
    out.push(
      t('shopMgmt.reconcile.mysqlDup', {
        platform: x.platform,
        orderId: x.platform_order_id,
        count: x.count,
      }),
    )
  }
  return out
}

export function buildItemReconcileIssueLines(t: TFn, r: ReconcilePayload, max = 20): string[] {
  const out: string[] = []
  const a = Array.isArray(r.itemMissingInMysql) ? r.itemMissingInMysql : []
  const b = Array.isArray(r.itemMissingInCache) ? r.itemMissingInCache : []
  const c = Array.isArray(r.itemMismatchQuantity) ? r.itemMismatchQuantity : []
  const d = Array.isArray(r.itemMismatchAmount) ? r.itemMismatchAmount : []
  const sid = (x: {
    platform: string
    platform_order_id: string
    platform_item_id: string
    sku_id: string
    product_id: string
  }) =>
    `${x.platform} · ${x.platform_order_id} · item=${x.platform_item_id} · sku=${x.sku_id} · pid=${x.product_id}`
  for (const x of a) {
    if (out.length >= max) break
    out.push(t('shopMgmt.reconcile.itemCacheOnly', { detail: sid(x) }))
  }
  for (const x of b) {
    if (out.length >= max) break
    out.push(
      t('shopMgmt.reconcile.itemMysqlOnly', {
        detail: sid(x),
        qty: x.mysqlQuantity,
        amt: x.mysqlAmount,
      }),
    )
  }
  for (const x of c) {
    if (out.length >= max) break
    out.push(
      t('shopMgmt.reconcile.itemQtyMismatch', {
        detail: sid(x),
        cacheQty: x.cacheQuantity,
        mysqlQty: x.mysqlQuantity,
      }),
    )
  }
  for (const x of d) {
    if (out.length >= max) break
    out.push(
      t('shopMgmt.reconcile.itemAmtMismatch', {
        detail: sid(x),
        cacheAmount: x.cacheAmount,
        mysqlAmount: x.mysqlAmount,
      }),
    )
  }
  return out
}

const AUDIT_ACTION_KEYS: Record<string, string> = {
  hide_shop: 'shopMgmt.audit.hideShop',
  show_shop: 'shopMgmt.audit.showShop',
  enable_sync: 'shopMgmt.audit.enableSync',
  disable_sync: 'shopMgmt.audit.disableSync',
  import_cache: 'shopMgmt.audit.importCache',
  update_shop: 'shopMgmt.audit.updateShop',
  create_shop: 'shopMgmt.audit.createShop',
  shop_create: 'shopMgmt.audit.createShop',
  update_sort: 'shopMgmt.audit.updateSort',
  disable_shop: 'shopMgmt.audit.disableShop',
  enable_shop: 'shopMgmt.audit.enableShop',
  shop_delete_soft: 'shopMgmt.audit.deleteShop',
  refresh_health: 'shopMgmt.audit.refreshHealth',
}

export function actionLabel(t: TFn, action: string): string {
  const k = AUDIT_ACTION_KEYS[action]
  return k ? t(k) : action
}

export function formatAuditResult(
  t: TFn,
  row: { action?: string },
  detail: Record<string, unknown> | null,
): string {
  const a = String(row.action || '')
  const d = detail || {}
  if (a === 'import_cache') {
    const ins = Number(d.inserted) || 0
    const upd = Number(d.updated) || 0
    const sk = Number(d.skipped) || 0
    const sc = Number(d.scanned) || 0
    return t('shopMgmt.auditResult.importCache', { inserted: ins, updated: upd, skipped: sk, scanned: sc })
  }
  const resultKey = `shopMgmt.auditResult.${a}`
  const direct = t(resultKey)
  if (direct !== resultKey) return direct
  if (a === 'refresh_health') {
    const c = d.checked != null ? Number(d.checked) : null
    const ab = d.abnormal != null ? Number(d.abnormal) : null
    if (c != null && ab != null) return t('shopMgmt.auditResult.refreshHealthCounts', { checked: c, abnormal: ab })
    return t('shopMgmt.auditResult.refreshHealthDone')
  }
  return t('shopMgmt.auditResult.done')
}

function pickShopNameFromDetail(detail: Record<string, unknown> | null): string | null {
  if (!detail) return null
  const shop = detail.shop
  if (shop && typeof shop === 'object' && !Array.isArray(shop)) {
    const s = shop as Record<string, unknown>
    const dn = s.display_name ?? s.displayName
    const sn = s.shop_name ?? s.shopName
    if (typeof dn === 'string' && dn.trim()) return dn.trim()
    if (typeof sn === 'string' && sn.trim()) return sn.trim()
  }
  return null
}

export function resolveAuditShopName(
  t: TFn,
  row: { target_type?: string | null; target_id?: string | number | null; action?: string },
  detail: Record<string, unknown> | null,
  shops: { id: number; shop_name?: string; display_name?: string | null }[],
): string {
  if (row.action === 'import_cache') return t('shopMgmt.auditScope.allCache')
  if (row.action === 'refresh_health') return t('shopMgmt.auditScope.tenantOverview')
  const fromDetail = pickShopNameFromDetail(detail)
  if (fromDetail) return fromDetail
  const id = row.target_id != null && row.target_id !== '' ? String(row.target_id) : ''
  if (row.target_type === 'shop' && id) {
    const local = shops.find((s) => String(s.id) === id)
    if (local) {
      const dn = local.display_name != null ? String(local.display_name).trim() : ''
      if (dn) return dn
      if (local.shop_name) return local.shop_name
    }
    return t('shopMgmt.auditScope.shopId', { id })
  }
  return t('common.dash')
}
