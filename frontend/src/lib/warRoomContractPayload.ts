import type { DashboardSummaryKpi } from './dashboardSummaryKpi'
import type { DashboardProductRankingItem, DashboardRankingItem } from '../services/api/dashboard'

type GmvPayloadLike = {
  selectedShopId: string
  baseCurrency: string
  targetCurrency: string
  exchangeRate: number
  summary: {
    todayOrders: number
    todayGmvBase: number
    todayGmvTarget: number
    avgOrderValueBase: number
    avgOrderValueTarget: number
    status: string
    updatedAt: string
  }
  shops: Array<{
    shopId: string
    shopName: string
    shop_name?: string
    region: string
    market: string
    todayOrders: number
    todayGmvBase: number
    todayGmvTarget: number
    shop_gmv?: number
    gmv?: number
    status: string
  }>
  orders: unknown[]
  productRankings: Array<{
    rank: number
    productId: string
    productName: string
    product_name: string
    sku_name?: string
    soldQuantity: number | null
    todayQuantity?: number
    todaySales?: number
    quantity?: number
    region?: string
    market?: string
    shop_name?: string
  }>
  trend: unknown[]
  meta: {
    dataSource: string
    source: string
    updatedAt: string
  }
}

export function buildWarRoomPayloadFromContract(
  kpi: DashboardSummaryKpi,
  ranking: DashboardRankingItem[],
  products: DashboardProductRankingItem[],
  baseCurrency: string,
  targetCurrency: string,
): GmvPayloadLike {
  const orders = Number(kpi.orders) || 0
  const gmv = kpi.currentGmvUsd != null ? Number(kpi.currentGmvUsd) : 0
  const avg = orders > 0 && gmv > 0 ? Number((gmv / orders).toFixed(2)) : 0
  const updatedAt = new Date().toISOString().slice(0, 19).replace('T', ' ')

  const shops = ranking.map((r) => {
    const g = Number(r.gmv) || 0
    const pid = String(r.shop_id ?? '').trim()
    return {
      shopId: pid,
      shopName: String(r.shop_name || pid || '—'),
      shop_name: String(r.shop_name || ''),
      region: String(r.market || '').trim(),
      market: String(r.market || '').trim().toUpperCase(),
      todayOrders: Number(r.orders) || 0,
      todayGmvBase: g,
      todayGmvTarget: g,
      shop_gmv: g,
      gmv: g,
      status: 'normal',
    }
  })

  const productRankings = products.map((p, i) => {
    const qty = Number(p.qty) || 0
    const name = String(p.product_name || '—')
    return {
      rank: i + 1,
      productId: `contract-${i}`,
      productName: name,
      product_name: name,
      sku_name: String(p.sku_name || ''),
      soldQuantity: qty,
      todayQuantity: qty,
      todaySales: qty,
      quantity: qty,
      region: '',
      market: '',
      shop_name: '',
    }
  })

  return {
    selectedShopId: 'all',
    baseCurrency,
    targetCurrency,
    exchangeRate: 1,
    summary: {
      todayOrders: orders,
      todayGmvBase: gmv,
      todayGmvTarget: gmv,
      avgOrderValueBase: avg,
      avgOrderValueTarget: avg,
      status: 'normal',
      updatedAt,
    },
    shops,
    orders: [],
    productRankings,
    trend: [],
    meta: {
      dataSource: 'mysql',
      source: 'dashboard-contract',
      updatedAt,
    },
  }
}
