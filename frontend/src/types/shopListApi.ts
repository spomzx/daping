/**
 * GET /api/shops 列表项契约（shops 表 + shop_sync_status + enrichShopRows + display 契约）。
 * 仅类型定义，不含业务逻辑。
 */

export type ShopListDisplay =
  | 'today_no_orders'
  | 'ok'
  | 'auth_error'
  | 'sync_error'
  | 'sync_off'
  | 'disabled'
  | 'hidden'
  | 'order_cache_pending'
  | 'unknown'
  | string

/** enrichShopRows 调试块（字段随版本扩展） */
export type ShopListHealthDebug = {
  shop_id?: number
  shop_name?: string
  market?: string
  today_orders?: number
  today_gmv?: number
  last_sync_error?: string | null
  latest_sync_status?: string
  openapi_last_sync_ok?: boolean
  stats_lookup?: {
    via?: string
    today_orders?: number
    today_gmv?: number
  }
} & Record<string, unknown>

export type ShopListApiRow = {
  id: number
  /** enrich：与 id 相同 */
  shop_id?: number
  tenant_id?: number
  tenant_name?: string | null
  tenant_code?: string | null
  platform: string
  platform_shop_id: string
  shop_name: string
  display_name: string | null
  market: string | null
  region: string | null
  currency: string | null
  sort_order: number
  hidden: number | boolean
  sync_enabled: number | boolean
  remarks: string | null
  imported_from_cache: number | boolean
  last_cache_sync_at: string | null
  status: string
  auth_status?: string | null
  /** GET /api/shops auth contract */
  shop_cipher_present?: boolean
  token_status?: 'active' | 'expired' | 'missing' | string
  token_valid_for_display?: boolean
  auth_contract_label?: string
  auth_status_contract?: string
  /** 错误/授权说明列（contract） */
  error_label?: string | null
  created_at?: string
  updated_at?: string
  last_order_seen_at?: string | null
  last_order_count?: number
  /**
   * shops 表历史缓存 GMV（DB: last_gmv_amount）。
   * enrich 后常与 today_gmv 相同；禁止单独作为今日 KPI 兜底（用 today_gmv + stats_source）。
   */
  last_gmv_amount?: number | string
  last_health_status?: string | null
  last_health_message?: string | null
  last_health_checked_at?: string | null
  last_sync_at?: string | null
  /**
   * 今日订单数 DTO（MySQL CURDATE 聚合）；非 shops 表持久化列。
   */
  today_orders?: number
  /**
   * 今日 GMV DTO（MySQL CURDATE）；列表主展示口径，非 orders 表列。
   */
  today_gmv?: number | string
  latest_order_at?: string | null
  latest_sync_success_at?: string | null
  latest_sync_attempt_at?: string | null
  latest_sync_status?: string | null
  /** shop_sync_status.sync_status */
  sync_status?: string | null
  last_success_sync_at?: string | null
  sync_fail_count?: number
  /**
   * shop_sync_status.last_error；display=ok|today_no_orders 时 API 可能置 null。
   */
  last_error?: string | null
  /**
   * 与 last_error 同源全文；display=ok|today_no_orders 时 API 可能置 null。
   */
  last_error_full?: string | null
  last_error_code?: string | null
  /**
   * OpenAPI 同步错误摘要（非 shops 表列；与 health_debug.last_sync_error 同源）。
   */
  last_sync_error?: string | null
  is_token_valid?: number | boolean
  token_expired_at?: string | null
  /** 与 sync_status 重复的队列态字段 */
  queue_sync_status?: string | null
  /** 健康 v2 状态码（如 normal / auth_error / sync_stale） */
  health_status?: string | null
  health_reason?: string | null
  health_rule?: string | null
  display?: ShopListDisplay | null
  /** 健康列展示文案（API display 契约，优先于 last_error 覆盖 UI） */
  health_label?: string | null
  sync_label?: string | null
  display_priority?: string | null
  health_debug?: ShopListHealthDebug
  stats_source?: string | null
  stats_window_hours?: number
  stats_date_window?: string | null
  kpi_trusted?: boolean
  kpi_untrusted_reason?: string | null
  api_stale_seconds?: number
  diff_minutes?: number | null
}

export type ShopsListApiResponse = {
  list: ShopListApiRow[]
  shops?: ShopListApiRow[]
  total: number
  page: number
  page_size: number
  meta?: {
    scope_mode?: string
    data_source?: string
    today_kpi_source?: string
    deprecated_sources?: string[]
  }
}
