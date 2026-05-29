/**
 * GET /api/orders/list items[] 契约（与 backend/modules/orders/repository.listOrders SELECT 对齐）。
 */

export type OrdersListItem = {
  id: number
  tenant_id: number
  shop_id: number | null
  platform_shop_id: string | null
  platform_order_id: string
  shop_name: string | null
  market: string | null
  currency: string | null
  buyer_name: string | null
  /**
   * 平台原始订单状态（TikTok order_status）。只读展示/入库推导；
   * 禁止作为 KPI 默认统计口径（见 field-governance.md §4）。
   */
  order_status: string | null
  /**
   * 分析统计状态：仅允许 valid | cancelled | sample | unpaid | other。
   * 禁止写入 paid；UI「付款订单」使用 query orderFilter=paid（非本列枚举）。
   */
  analytics_status: string | null
  /**
   * 订单原币金额（orders.total_amount）；GMV SUM 主字段。
   * 禁止与 DTO `amount` 混用写库。
   */
  total_amount: number
  /**
   * 平台下单时间；订单日期归属与大屏时间窗优先字段。
   * 禁止用 created_at / updated_at 代替。
   */
  created_at_platform: string | null
  /**
   * 付款时间；仅用于付款筛选（orderFilter=paid），非默认 KPI 日期字段。
   */
  paid_at: string | null
  updated_at: string | null
}

export type OrdersListApiResponse = {
  ok?: boolean
  module?: string
  items: OrdersListItem[]
  total: number
  page: number
  page_size: number
}
