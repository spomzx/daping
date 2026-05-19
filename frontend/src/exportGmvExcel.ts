import * as XLSX from 'xlsx'

const ORDER_STATUS_LABEL: Record<string, string> = {
  paid: '已支付',
  completed: '已完成',
  unpaid: '未付款',
  cancelled: '已取消',
}

const PRODUCT_STATUS_LABEL: Record<string, string> = {
  Active: '在售',
  'Low Stock': '库存低',
  'Out of Stock': '缺货',
}

export type ShopSalesExportRow = {
  rank: number
  shopName: string
  region: string
  todayOrders: number
  todayGmvTarget: number
  todayGmvBase: number
}

export type ProductRankingExportRow = {
  rank: number
  productName: string
  skuName?: string
  soldQuantity: number | null
  salesAmountTarget: number
  currency?: string
  salesAmountFormatted?: string
  conversionRate: number
  productStatus: string
}

export type OrderExportRow = {
  orderStatus: string
  shopName: string
  platform: string
  region: string
  customerName: string
  orderAmountTarget: number
  orderAmountBase: number
  orderTime: string
}

export type ExportShopSalesExcelInput = {
  shops: ShopSalesExportRow[]
  productRankings: ProductRankingExportRow[]
  orders: OrderExportRow[]
  displayBase: string
  displayTarget: string
  exchangeRate: number
  updatedAt: string
}

function pad2(n: number) {
  return String(n).padStart(2, '0')
}

function buildShopSalesFilename() {
  const d = new Date()
  return `tiktok-shop-sales-${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}.xlsx`
}

function fmtMoney(currency: string, value: number) {
  const c = String(currency || '').toUpperCase()
  const n = Number.isFinite(value) ? value : 0
  if (c === 'VND') {
    return `${c} ${Math.round(n).toLocaleString('en-US')}`
  }
  return `${c} ${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function safeAvg(gmv: number, orders: number) {
  const n = Math.max(orders, 0)
  if (n <= 0) return 0
  return Number((gmv / n).toFixed(2))
}

/**
 * 店铺维度导出（三 Sheet 同一文件），数据须与当前 shop / orderFilter / 币种筛选一致（由调用方传入已筛选的 data）。
 */
export function downloadShopSalesExcel(input: ExportShopSalesExcelInput) {
  const wb = XLSX.utils.book_new()
  const rateText = `1 ${input.displayBase} = ${Number(input.exchangeRate).toFixed(4)} ${input.displayTarget}`

  const shopHead = [
    '排名',
    '店铺名称',
    '市场',
    '今日订单数',
    '今日GMV Target',
    '今日GMV Base',
    '平均客单价 Target',
    '平均客单价 Base',
    '当前汇率',
    '目标币种',
    '基准币种',
    '更新时间',
  ]

  const shopBody = input.shops.map((s) => {
    const avgT = safeAvg(s.todayGmvTarget, s.todayOrders)
    const avgB = safeAvg(s.todayGmvBase, s.todayOrders)
    return [
      s.rank,
      s.shopName,
      s.region,
      s.todayOrders,
      fmtMoney(input.displayTarget, s.todayGmvTarget),
      fmtMoney(input.displayBase, s.todayGmvBase),
      fmtMoney(input.displayTarget, avgT),
      fmtMoney(input.displayBase, avgB),
      rateText,
      input.displayTarget,
      input.displayBase,
      input.updatedAt,
    ]
  })

  const ws1 = XLSX.utils.aoa_to_sheet([shopHead, ...shopBody])
  XLSX.utils.book_append_sheet(wb, ws1, '店铺销售汇总')

  const prodHead = ['排名', '商品名称', 'SKU名称', '今日销量', '今日销售额', '币种', '转化率', '状态']
  const prodBody = input.productRankings.map((p) => [
    p.rank,
    p.productName,
    p.skuName ?? '',
    p.soldQuantity == null ? '--' : p.soldQuantity,
    p.salesAmountFormatted && String(p.salesAmountFormatted).trim()
      ? p.salesAmountFormatted
      : fmtMoney(input.displayTarget, p.salesAmountTarget),
    (p.currency || input.displayTarget || '').toUpperCase(),
    `${Number.isFinite(p.conversionRate) ? p.conversionRate.toFixed(2) : '0.00'}%`,
    PRODUCT_STATUS_LABEL[p.productStatus] ?? p.productStatus,
  ])
  const ws2 = XLSX.utils.aoa_to_sheet([prodHead, ...prodBody])
  XLSX.utils.book_append_sheet(wb, ws2, '商品销量排行')

  const orderHead = [
    '订单状态',
    '店铺名称',
    '渠道',
    '市场',
    '客户名称',
    '订单金额 Target',
    '订单金额 Base',
    '下单时间',
  ]
  const orderBody = input.orders.map((o) => [
    ORDER_STATUS_LABEL[o.orderStatus] ?? o.orderStatus,
    o.shopName,
    o.platform,
    o.region,
    o.customerName,
    fmtMoney(input.displayTarget, o.orderAmountTarget),
    fmtMoney(input.displayBase, o.orderAmountBase),
    o.orderTime,
  ])
  const ws3 = XLSX.utils.aoa_to_sheet([orderHead, ...orderBody])
  XLSX.utils.book_append_sheet(wb, ws3, '订单明细')

  XLSX.writeFile(wb, buildShopSalesFilename())
}
