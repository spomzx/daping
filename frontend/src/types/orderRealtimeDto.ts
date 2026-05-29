/**
 * 实时大屏订单列表展示 DTO（数据源：GET /api/dashboard/orders）。
 * 非 orders 表列名映射；金额与 USD 为接口计算字段。
 */

export type OrderLevel = 'small' | 'medium' | 'large' | 'super'

export type OrderRealtimeDto = {
  platform_order_id: string
  shop_id: number | null
  shop_name: string
  market: string
  currency?: string
  original_currency?: string
  original_amount?: number
  /**
   * 展示用原币金额（接口计算/映射）；非 orders.total_amount 列名。
   */
  amount: number
  /**
   * 换算 USD（/api/dashboard/orders、recent-orders 计算字段）；非 DB 列。
   */
  usd_amount?: number | null
  usd_pending?: boolean
  exchange_rate?: number | null
  cny_amount?: number
  items: number
  is_large_order?: boolean
  is_multi_item?: boolean
  /** 由 analytics_status=sample 或 analytics 侧 raw 推导 */
  is_sample?: boolean
  market_color?: string
  order_level?: OrderLevel
  /**
   * 平台下单时间字符串（与 orders.created_at_platform 同源语义）。
   */
  created_at_platform: string
}
