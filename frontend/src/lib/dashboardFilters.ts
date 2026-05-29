import type { TimeRangePreset } from '../i18n'
import {
  buildDashboardFilterContract,
  contractToSearchParams,
  logDashboardContract,
} from './dashboardFilterContract'

/** 实时订单表标题 i18n key（今日用 orders.realtimeTitle） */
export function realtimeOrdersPanelTitleKey(timeRange: TimeRangePreset): string {
  switch (timeRange) {
    case 'yesterday':
      return 'orders.panelTitle.yesterday'
    case 'last7':
      return 'orders.panelTitle.last7'
    case 'last30':
      return 'orders.panelTitle.last30'
    case 'custom':
      return 'orders.panelTitle.custom'
    default:
      return 'orders.realtimeTitle'
  }
}

/**
 * paid = UI「付款订单」（valid + 已付款后取消）；valid = KPI 默认有效订单。
 */
export type DashboardOrderFilter = 'all' | 'valid' | 'unpaid' | 'sample' | 'cancelled' | 'paid'

export type DashboardFilterState = {
  /** UI 选中键：platform_shop_id 小写，或 mysql id 字符串 */
  shopId: string
  marketRegion: string
  orderFilter: DashboardOrderFilter
  timeRange: TimeRangePreset
  customStart: string
  customEnd: string
  baseCurrency: string
  targetCurrency: string
}

export type ShopCatalogRow = {
  id?: number
  shopId?: string
  platform_shop_id?: string
  shopName?: string
}

function normShopName(name: unknown): string {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
}

/** 与 legacy 大屏 shopId 筛选一致（platform_shop_id 小写） */
export function normalizeDashboardShopKey(shopId: unknown, shopName?: string): string {
  const id = String(shopId || '')
    .trim()
    .toLowerCase()
  if (id) return id
  const map: Record<string, string> = {
    'TIKTOK MY': 'my',
    'TIKTOK PH': 'ph',
    'TIKTOK SG': 'sg',
    'TIKTOK TH': 'th',
    'TIKTOK VN': 'vn',
  }
  const key = String(shopName || '')
    .trim()
    .toUpperCase()
  return map[key] || ''
}

/** 合并 /api/shops 与排行/GMV 返回的店铺，供 id 解析 */
export function mergeShopCatalog(...sources: Array<ShopCatalogRow[] | undefined | null>): ShopCatalogRow[] {
  const byMysql = new Map<number, ShopCatalogRow>()
  const byPid = new Map<string, ShopCatalogRow>()

  const ingest = (row: ShopCatalogRow) => {
    const id = row.id != null && Number.isFinite(Number(row.id)) ? Math.floor(Number(row.id)) : null
    const pid = normalizeDashboardShopKey(row.shopId ?? row.platform_shop_id, row.shopName)
    const merged: ShopCatalogRow = {
      id: id ?? row.id,
      shopId: pid || row.shopId,
      platform_shop_id: pid || row.platform_shop_id,
      shopName: row.shopName,
    }
    if (id != null) {
      const prev = byMysql.get(id)
      byMysql.set(id, prev ? { ...prev, ...merged } : merged)
    }
    if (pid) {
      const prev = byPid.get(pid)
      byPid.set(pid, prev ? { ...prev, ...merged, id: merged.id ?? prev.id } : merged)
    }
  }

  for (const list of sources) {
    if (!Array.isArray(list)) continue
    for (const row of list) {
      if (!row || typeof row !== 'object') continue
      ingest(row)
    }
  }

  const out = new Map<number | string, ShopCatalogRow>()
  for (const row of byMysql.values()) {
    if (row.id != null) out.set(`m:${row.id}`, row)
  }
  for (const row of byPid.values()) {
    const k = row.id != null ? `m:${row.id}` : `p:${row.shopId}`
    if (!out.has(k)) out.set(k, row)
  }
  return [...out.values()]
}

/**
 * 解析为后端 shop_id：优先 MySQL shops.id，否则 platform_shop_id（禁止用店铺名作为主筛选）
 */
export function resolveShopApiId(selectedShopKey: string, catalog: ShopCatalogRow[] = []): string {
  const key = String(selectedShopKey || '').trim().toLowerCase()
  if (!key || key === 'all') return 'all'

  const keyName = normShopName(key)

  for (const row of catalog) {
    const pid = normalizeDashboardShopKey(row.shopId ?? row.platform_shop_id, row.shopName)
    const name = normShopName(row.shopName)
    const idOk = row.id != null && Number.isFinite(Number(row.id))
    if (pid && pid === key && idOk) {
      return String(Math.floor(Number(row.id)))
    }
    if (name && name === keyName && idOk) {
      return String(Math.floor(Number(row.id)))
    }
  }

  for (const row of catalog) {
    const pid = normalizeDashboardShopKey(row.shopId ?? row.platform_shop_id, row.shopName)
    if (pid && pid === key) return pid
  }

  /** 长数字多为 TikTok platform_shop_id，勿当作 MySQL shops.id */
  if (/^\d+$/.test(key)) {
    const asMysql = catalog.find((r) => r.id != null && String(r.id) === key)
    if (asMysql?.id != null) return String(Math.floor(Number(asMysql.id)))
    if (key.length >= 10) return key
  }

  return key
}

export function logDashboardFilter(
  endpoint: string,
  params: URLSearchParams,
  meta?: { count?: number; rows?: number; points?: number; extra?: string },
): void {
  const contract = buildDashboardFilterContract({
    shopId: params.get('shopId') || params.get('shop_id') || 'all',
    marketRegion: (params.get('market') || 'ALL').toLowerCase() === 'all' ? 'all' : (params.get('market') || 'all'),
    orderFilter: (params.get('orderFilter') || 'all') as DashboardOrderFilter,
    timeRange: (params.get('timeRange') || params.get('range') || 'today') as TimeRangePreset,
    customStart: params.get('startDate') || '',
    customEnd: params.get('endDate') || '',
    baseCurrency: params.get('baseCurrency') || 'USD',
    targetCurrency: params.get('targetCurrency') || 'USD',
  })
  logDashboardContract(endpoint, contract, meta)
}

/** @deprecated 实时大屏请用 contractToApiQuery；勿再请求 /api/dashboard 聚合 */
export function buildDashboardQueryParams(
  filters: DashboardFilterState,
  catalog: ShopCatalogRow[] = [],
  extra?: Record<string, string | number | undefined>,
): URLSearchParams {
  const contract = buildDashboardFilterContract(filters, catalog)
  const params = contractToSearchParams(contract, {
    baseCurrency: filters.baseCurrency,
    targetCurrency: filters.targetCurrency,
    region: filters.marketRegion === 'all' ? 'all' : filters.marketRegion.toUpperCase(),
    ...extra,
  })
  params.set('shopId', contract.shopId)
  return params
}
