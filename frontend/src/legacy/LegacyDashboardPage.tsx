import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import './styles/legacy-app.css'
import { RealtimeOrdersPanel } from '../components/RealtimeOrdersPanel'
import {
  isAdminLike,
  isViewerLike,
  isPlatformScope,
  type MeRole,
  type AuthSession,
  type AccountAccess,
} from '../authRole'
import { AUTH_TOKEN_KEY, getAuthHeaders } from '../authStorage'
import { tiktokOAuthStartUrl } from '../tiktokOAuth'
import { resolveApiRequestInput } from '../apiClient'
import { usePlatformViewTenant } from '../context/PlatformViewTenantContext'
import { TenantViewSelector } from '../components/TenantViewSelector'
import { getPlatformViewTenantId } from '../lib/platformViewTenant'
import { apiFetch, fetchWithAuth } from '../apiClient'
import {
  LS_TIME_RANGE,
  LS_CUSTOM_START,
  LS_CUSTOM_END,
  readInitialTimeRange,
  toCanonicalOrderStatus,
  useI18n,
  type TimeRangePreset,
} from '../i18n'
import { appendDashboardTimeQuery, getDashboardBoundsForQuery } from '../dashboardBounds'
import { formatMoneyByCurrency } from '../currencyDisplay'
import { GmvCompareTrendPanel } from '../GmvCompareTrendPanel'
import { useChartResize } from '../hooks/useChartResize'
import './styles/legacy-dashboard.css'
import './styles/legacy-realtime-orders.css'
import './styles/legacy-filters.css'
import './styles/legacy-charts.css'
import './styles/legacy-dashboard-layout.css'
import './styles/tenant-view-selector.legacy.css'
import {
  buildFallbackExchangeRate,
  buildLoadingExchangeRate,
  isSoftRateStatus,
  readExchangeRateCache,
  writeExchangeRateCache,
} from '../lib/exchangeRateFallback'
import { DashboardHeader } from '../components/DashboardHeader'


const ReactECharts = lazy(() => import('echarts-for-react'))
const PRODUCT_RANK_CARD_ROWS = 20
const FETCH_TIMEOUT_MS = 60000

/** 市场筛选按钮固定顺序（不受当前 dashboard 筛选结果影响） */
const MARKET_FILTER_CODES = ['TH', 'PH', 'MY', 'SG', 'VN'] as const

/** 已授权店铺明细弹窗分页 */
const SHOPS_PANEL_PAGE_SIZE = 7

/** 与后端 normalizeOrderFilter 一致 */
type OrderFilter = 'all' | 'valid' | 'unpaid' | 'sample' | 'cancelled'

const ORDER_FILTER_PARAM_VALUES: OrderFilter[] = ['all', 'valid', 'unpaid', 'sample', 'cancelled']

function readInitialOrderFilter(): OrderFilter {
  if (typeof window === 'undefined') return 'all'
  try {
    const v = new URLSearchParams(window.location.search).get('orderFilter')
    if (v && ORDER_FILTER_PARAM_VALUES.includes(v as OrderFilter)) return v as OrderFilter
  } catch {
    /* ignore */
  }
  return 'all'
}

type TrendPoint = {
  time: string
  gmvBase: number
  gmvTarget: number
  orders: number
}

type ShopRow = {
  shopId: string
  shopName: string
  shop_name?: string
  region: string
  market?: string
  todayOrders: number
  todayGmvBase: number
  todayGmvTarget: number
  /** 与 todayGmvTarget 一致：目标币种下的店铺 GMV（订单汇总） */
  shop_gmv?: number
  gmv?: number
  status: string
  ordersAll?: number
  ordersValid?: number
  ordersUnpaid?: number
}

type GmvMeta = {
  dataSource: string
  updatedAt: string
  refreshInterval: number
  /** orders-cache 原始条数；>0 表示同步正常，空列表多为筛选所致 */
  ordersLoadedCount?: number
  /** 今日自然日（按区域日界）内的订单条数，未应用订单类型筛选 */
  ordersTodayCount?: number
  trendMessage?: string
  status?: string
  error?: string
  lastCollectAt?: string
  lastCollectDuration?: number
  cacheAgeSeconds?: number
  collectWarning?: string
  collectError?: string
  insightsProductRankings?: boolean
  insightsProductRankingsSource?: string
  insightsProductRankingsUpdatedAt?: string
  insightsProductRankingsCurrency?: string
  insightsOverview?: boolean
  insightsOverviewSource?: string
  insightsOverviewUpdatedAt?: string
  insightsOverviewCurrency?: string
  /** 后端时间筛选回显 */
  timeRange?: string
  rangeStartEpoch?: number
  rangeEndEpoch?: number
  startDate?: string
  endDate?: string
  customInvalid?: boolean
}

/** P3 锁定：与 /api/gmv/current 一致，禁止依赖根级 todayOrders/todayGmv 等旧字段 */
type GmvPayload = {
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
    itemSoldCount?: number
    skuOrderCount?: number
  }
  shops: ShopRow[]
  orders: Array<{
    id: string
    shopId: string
    shopName: string
    orderStatus: string
    platform: string
    region: string
    customerName: string
    orderAmountBase: number
    orderAmountTarget: number
    /** 与后端 currency.js 一致：usd = raw / rate(1USD=x本币) */
    usdAmount?: number
    cnyAmount?: number
    /** 订单支付/标价原币种（接口 currency） */
    currency?: string
    orderTime: string
    /** 样品订单：来自接口 _raw.is_sample_order / isSample */
    isSample?: boolean
    isCancelled?: boolean
  }>
  productRankings: Array<{
    rank: number
    productId: string
    skuId?: string
    sellerSku?: string
    sku?: string
    productName: string
    product_name?: string
    todayQuantity?: number
    soldQuantity: number | null
    todaySales?: number
    orderCount?: number
    todayAmount?: number
    quantity?: number
    sales_amount?: number
    gmv?: number
    region?: string
    market?: string
    shopName?: string
    shop_name?: string
    salesAmountBase: number
    salesAmountTarget: number
    salesAmountFormatted?: string
    conversionRate: number
    productStatus: 'Active' | 'Low Stock' | 'Out of Stock'
    targetCurrency: string
    skuName?: string
    currency?: string
    shopId?: string
  }>
  trend: TrendPoint[]
  meta: GmvMeta
}

type ExchangeRatePayload = {
  baseCurrency: string
  targetCurrency: string
  rate: number
  updatedAt: string
  source: string
  status: string
}

const TARGET_OPTIONS = ['USD', 'CNY', 'THB', 'SGD', 'MYR', 'PHP', 'VND'] as const

const LS_BASE_CURRENCY = 'daping_base_currency'
const LS_TARGET_CURRENCY = 'daping_target_currency'

function readInitialCurrencies(): { base: string; target: string } {
  const supported = new Set(TARGET_OPTIONS as readonly string[])
  if (typeof window === 'undefined') return { base: 'USD', target: 'USD' }
  try {
    const u = new URLSearchParams(window.location.search)
    const qb = u.get('baseCurrency') || u.get('base')
    const qt = u.get('targetCurrency') || u.get('target')
    if (qb && supported.has(qb.toUpperCase()) && qt && supported.has(qt.toUpperCase())) {
      return { base: qb.toUpperCase(), target: qt.toUpperCase() }
    }
  } catch {
    /* ignore */
  }
  try {
    const b = localStorage.getItem(LS_BASE_CURRENCY)?.trim().toUpperCase()
    const t = localStorage.getItem(LS_TARGET_CURRENCY)?.trim().toUpperCase()
    if (b && supported.has(b) && t && supported.has(t)) return { base: b, target: t }
  } catch {
    /* ignore */
  }
  return { base: 'USD', target: 'USD' }
}

/** 市场列：展示 TH / VN 等简称 */
function formatMarket(v: string | undefined): string {
  const raw = String(v || '')
    .trim()
    .toUpperCase()
  if (!raw || raw === '--') return '--'
  const known = new Set(['TH', 'MY', 'SG', 'PH', 'VN'])
  if (known.has(raw)) return raw
  if (raw.length >= 2) return raw.slice(0, 2)
  return raw
}

function jsonScalarTruthy(v: unknown): boolean {
  if (v === true || v === 1) return true
  if (typeof v === 'number' && v !== 0 && Number.isFinite(v)) return true
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase()
    return s === 'true' || s === '1' || s === 'yes' || s === 'y'
  }
  return false
}

function sampleSignalsFromObject(node: Record<string, unknown> | null | undefined): boolean {
  if (!node || typeof node !== 'object') return false
  if (node.isSample === true) return true
  if (node.is_sample_order === true) return true
  if (jsonScalarTruthy(node.is_sample_order)) return true
  if (node.is_sample === true) return true
  if (jsonScalarTruthy(node.is_sample)) return true
  if (node.sample_order === true) return true
  if (jsonScalarTruthy(node.sample_order)) return true
  const ot = String(node.order_type ?? node.orderType ?? '')
    .trim()
    .toLowerCase()
  if (ot === 'sample') return true
  return false
}

function rawJsonStringSuggestsSample(sj: string): boolean {
  const s = String(sj || '')
  if (!s) return false
  const low = s.toLowerCase()
  if (s.includes('样品订单')) return true
  if (s.includes('样品') && (low.includes('sample') || low.includes('is_sample') || low.includes('sample_order'))) return true
  const needles = [
    '"is_sample_order":true',
    '"is_sample_order": true',
    '"is_sample":true',
    '"is_sample": true',
    '"sample_order":true',
    '"sample_order": true',
    '"order_type":"sample',
    '"order_type": "sample',
    'order_type":"sample',
  ]
  for (const p of needles) {
    if (low.includes(p)) return true
  }
  return false
}

function orderStatusSuggestsSample(statusRaw: unknown): boolean {
  const t = String(statusRaw ?? '').trim()
  if (!t) return false
  if (t.includes('样品')) return true
  return /sample/i.test(t)
}

/** 与 backend/lib/orderFilter.js 的 orderIsSampleOrder 同口径（大屏列表 / 样品筛选） */
function inferOrderIsSample(row: Record<string, unknown>): boolean {
  if (row.isSample === true) return true
  if (row.is_sample_order === true) return true
  const rawTop = row._raw
  if (rawTop && typeof rawTop === 'object' && sampleSignalsFromObject(rawTop as Record<string, unknown>)) return true
  if (sampleSignalsFromObject(row)) return true
  try {
    const rj = row.raw_json != null ? String(row.raw_json) : ''
    if (rj && rawJsonStringSuggestsSample(rj)) return true
  } catch {
    /* ignore */
  }
  if (orderStatusSuggestsSample(row.orderStatus ?? row.order_status ?? row.status)) return true
  return false
}
function safeNum(value: number | undefined, digits = 2) {
  if (!Number.isFinite(value ?? NaN)) return 0
  return Number((value ?? 0).toFixed(digits))
}

/** 大屏「统计日界」展示：与当前筛选市场一致（仅文案/时钟展示，接口不变）。 */
function getMarketStatsTimezoneDisplay(region: string) {
  const r = String(region || 'all').trim().toUpperCase()
  if (r === 'ALL') return { headline: 'Multi Timezone', clockIana: null as string | null }
  if (r === 'TH' || r === 'VN') {
    const clockIana = r === 'VN' ? 'Asia/Ho_Chi_Minh' : 'Asia/Bangkok'
    return { headline: 'UTC+7', clockIana }
  }
  if (r === 'MY') return { headline: 'UTC+8', clockIana: 'Asia/Kuala_Lumpur' }
  if (r === 'SG') return { headline: 'UTC+8', clockIana: 'Asia/Singapore' }
  if (r === 'PH') return { headline: 'UTC+8', clockIana: 'Asia/Manila' }
  return { headline: 'UTC+8', clockIana: 'Asia/Singapore' }
}

function formatClockInIanaZone(date: Date, iana: string) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: iana,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date)
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? ''
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')}`
}

function formatBrowserLocalClock(date: Date) {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

function formatAmount(currency: string, value: number) {
  return formatMoneyByCurrency(currency, value)
}

const formatCurrency = formatAmount

function shopGmvDisplayValue(s: ShopRow): number {
  const v = s.shop_gmv ?? s.todayGmvTarget ?? s.gmv
  return Number.isFinite(Number(v)) ? Number(v) : 0
}

async function fetchWithTimeout(input: RequestInfo | URL, init: RequestInit = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController()
  const timer = window.setTimeout(() => controller.abort(), timeoutMs)
  const externalSignal = init.signal
  const forwardExternalAbort = () => {
    try {
      controller.abort()
    } catch {
      /* ignore */
    }
  }
  if (externalSignal) {
    if (externalSignal.aborted) forwardExternalAbort()
    else externalSignal.addEventListener('abort', forwardExternalAbort)
  }
  try {
    const { signal: _sig, headers: inHeaders, ...rest } = init
    const mergedHeaders: Record<string, string> = {
      ...getAuthHeaders(),
      ...(typeof inHeaders === 'object' && inHeaders != null && !Array.isArray(inHeaders)
        ? (inHeaders as Record<string, string>)
        : {}),
    }
    return await fetch(resolveApiRequestInput(input), {
      ...rest,
      headers: mergedHeaders,
      signal: controller.signal,
    })
  } finally {
    window.clearTimeout(timer)
    if (externalSignal) {
      externalSignal.removeEventListener('abort', forwardExternalAbort)
    }
  }
}

function truncateProductTitle(name: string, maxLen: number) {
  if (name.length <= maxLen) return name
  return `${name.slice(0, Math.max(0, maxLen - 3))}...`
}

function isRequestAbortedError(err: unknown) {
  const name = String((err as { name?: unknown })?.name ?? '')
  const message = String((err as { message?: unknown })?.message ?? '').toLowerCase()
  return (
    name === 'AbortError' ||
    message.includes('aborted') ||
    message.includes('signal is aborted') ||
    message.includes('the user aborted a request')
  )
}

const UNPAID_ORDER_CANON = new Set(['unpaid', 'awaiting_payment', 'pending_payment'])

const EXCLUDED_FROM_VALID_CANON = new Set([
  'cancelled',
  'canceled',
  'buyer_cancel',
  'seller_cancel',
  'on_hold',
  'refund',
  'refunded',
  'unpaid',
  'unknown',
])

const VALID_ORDER_CANON = new Set([
  'awaiting_shipment',
  'awaiting_collection',
  'partially_shipping',
  'in_transit',
  'delivered',
  'completed',
  'paid',
  'pending_payment',
  'awaiting_payment',
  'returned',
  'shipped',
  'ready_to_ship',
  'partially_shipped',
  'awaiting_package',
  'to_ship',
])

/** 与 backend/lib/orderFilter.js 的 orderMatchesFilterStatus 一致（all / valid / unpaid） */
function orderMatchesFilterClient(status: string, filter: 'all' | 'valid' | 'unpaid') {
  const raw = String(status || '').trim()
  if (!raw) {
    if (filter === 'all') return true
    return false
  }
  if (filter === 'all') return true
  const canon = toCanonicalOrderStatus(raw)
  if (filter === 'unpaid') {
    return UNPAID_ORDER_CANON.has(canon)
  }
  if (filter === 'valid') {
    if (!canon) return false
    if (EXCLUDED_FROM_VALID_CANON.has(canon)) return false
    return VALID_ORDER_CANON.has(canon)
  }
  return true
}

/** 与 backend orderIsCancelledStatus 一致 */
function inferOrderIsCancelled(statusRaw: string): boolean {
  const raw = String(statusRaw || '').trim()
  if (!raw) return false
  if (raw === '已取消' || raw === '买家取消' || raw === '卖家取消') return true
  const lower = raw.toLowerCase()
  const exact = new Set(['cancelled', 'canceled', 'buyer_cancel', 'seller_cancel', 'cancel'])
  if (exact.has(lower)) return true
  if (lower.includes('cancel')) return true
  const upper = raw.toUpperCase()
  if (upper === 'CANCELLED' || upper === 'CANCELED') return true
  return false
}

function orderRowMatchesFilter(o: { orderStatus: string; isSample?: boolean }, filter: OrderFilter): boolean {
  if (filter === 'sample') return o.isSample === true
  if (filter === 'cancelled') return inferOrderIsCancelled(o.orderStatus)
  return orderMatchesFilterClient(o.orderStatus, filter)
}

const SHOP_NAME_FALLBACK_ID: Record<string, string> = {
  'TIKTOK MY': 'my',
  'TIKTOK PH': 'ph',
  'TIKTOK SG': 'sg',
  'TIKTOK TH': 'th',
  'TIKTOK VN': 'vn',
}

function normalizeShopId(shopId: unknown, shopName?: string) {
  const id = String(shopId || '')
    .trim()
    .toLowerCase()
  if (id) return id
  const key = String(shopName || '')
    .trim()
    .toUpperCase()
  return SHOP_NAME_FALLBACK_ID[key] || ''
}

/** 订单数以 summary（后端 orderId 去重）为准，不再用店铺累加覆盖，避免与排行「全部店铺」不一致 */
function reconcileSummaryFromShops(payload: GmvPayload): GmvPayload {
  return payload
}

function patchGmvStatus(payload: GmvPayload): GmvPayload {
  const keepCollectWarning = payload.summary?.status === 'warning'
  const ok = (payload.summary?.todayOrders ?? 0) > 0
  return {
    ...payload,
    summary: {
      ...payload.summary,
      status: keepCollectWarning ? 'warning' : ok ? 'normal' : payload.summary.status || 'normal',
    },
    shops: (payload.shops ?? []).map((s) => ({
      ...s,
      status: keepCollectWarning
        ? s.status === 'warning'
          ? 'warning'
          : s.status || 'normal'
        : (s.todayOrders ?? 0) > 0 || ok
          ? 'normal'
          : s.status || 'normal',
    })),
  }
}

function isNewMultiShopPayload(raw: unknown): raw is GmvPayload {
  if (!raw || typeof raw !== 'object') return false
  const r = raw as Record<string, unknown>
  const summary = r.summary
  const shops = r.shops
  const meta = r.meta
  if (!summary || typeof summary !== 'object') return false
  if (!Array.isArray(shops)) return false
  if (!meta || typeof meta !== 'object') return false
  /** P4.4：仅当存在 dataSource 键时才要求为 string；缺失时不误判为旧版（否则会走 legacy 并把 meta 写死为 mock） */
  const ds = (meta as { dataSource?: unknown }).dataSource
  if (ds !== undefined && typeof ds !== 'string') return false
  return typeof (summary as { todayOrders?: unknown }).todayOrders === 'number'
}

function adaptGmvResponse(raw: unknown, orderFilter: OrderFilter, _selectedShopId: string): GmvPayload | null {
  if (!raw || typeof raw !== 'object') return null
  if (isNewMultiShopPayload(raw)) {
    const normalized: GmvPayload = {
      ...raw,
      summary: {
        ...raw.summary,
        todayOrders: Number(raw.summary.todayOrders ?? 0),
        todayGmvBase: Number(raw.summary.todayGmvBase ?? 0),
        todayGmvTarget: Number(raw.summary.todayGmvTarget ?? 0),
        avgOrderValueBase: Number(raw.summary.avgOrderValueBase ?? 0),
        avgOrderValueTarget: Number(raw.summary.avgOrderValueTarget ?? 0),
      },
      shops: (Array.isArray(raw.shops) ? raw.shops : []).map((s) => {
        const r = s as Record<string, unknown>
        const gmv = Number(s.todayGmvTarget ?? r.shop_gmv ?? r.gmv ?? 0)
        return {
          ...s,
          shopId: String(s.shopId ?? '')
            .trim()
            .toLowerCase(),
          shopName: String(s.shopName ?? r.shop_name ?? ''),
          shop_name: String(r.shop_name ?? s.shopName ?? ''),
          region: String(s.region ?? '').trim(),
          market: String(r.market ?? s.region ?? '')
            .trim()
            .toUpperCase(),
          todayOrders: Number(s.todayOrders ?? 0),
          todayGmvBase: Number(s.todayGmvBase ?? 0),
          todayGmvTarget: gmv,
          shop_gmv: Number(r.shop_gmv ?? gmv),
          gmv: Number(r.gmv ?? gmv),
        }
      }),
      orders: (Array.isArray(raw.orders) ? raw.orders : [])
        .map((o, idx) => {
          const row = (o || {}) as Record<string, unknown>
          return {
            id: String(row.id ?? `${idx}-${row.orderStatus ?? row.status ?? 'order'}`),
            shopId: String(row.shopId ?? 'all'),
            shopName: String(row.shopName ?? 'TikTok Shop'),
            orderStatus: String(row.orderStatus ?? row.status ?? ''),
            platform: String(row.platform ?? row.channel ?? row.source ?? 'TikTok'),
            region: String(row.region ?? row.market ?? '--'),
            customerName: String(row.customerName ?? row.buyerName ?? '***'),
            orderAmountBase: Number(row.orderAmountBase ?? row.amountBase ?? row.gmvBase ?? 0),
            orderAmountTarget: Number(row.orderAmountTarget ?? row.amountTarget ?? row.gmvTarget ?? 0),
            currency: (() => {
              const raw = row.currency ?? row.Currency
              const s = raw != null ? String(raw).trim().toUpperCase() : ''
              return s || undefined
            })(),
            orderTime: String(row.orderTime ?? row.createdAt ?? row.paidTime ?? ''),
            usdAmount: Number(row.usdAmount ?? row.usd_amount ?? 0),
            usd_amount: Number(row.usd_amount ?? row.usdAmount ?? 0),
            cnyAmount: Number(row.cnyAmount ?? row.cny_amount ?? 0),
            items: Number(row.itemCount ?? row.items ?? row.lineItemCount ?? 1),
            isSample: inferOrderIsSample(row),
            isCancelled:
              row.isCancelled === true ||
              inferOrderIsCancelled(String(row.orderStatus ?? row.status ?? '')),
          }
        })
        .filter((o) => orderRowMatchesFilter(o, orderFilter)),
      trend: (Array.isArray(raw.trend) ? raw.trend : []).map((t) => ({
        ...t,
        gmvBase: Number(t.gmvBase ?? 0),
        gmvTarget: Number(t.gmvTarget ?? 0),
        orders: Number(t.orders ?? 0),
      })),
      productRankings: aggregateProductRankings((Array.isArray(raw.productRankings) ? raw.productRankings : []).map((p, idx) => {
        const row = (p || {}) as Record<string, unknown>
        const salesCandidates = [
          row.todayQuantity,
          row.todaySales,
          row.soldQuantity,
          row.itemSoldCount,
          row.soldCount,
          row.salesCount,
          row.quantity,
          row.skuSoldCount,
          row.productSoldCount,
        ]
        let qty: number | null = null
        for (const c of salesCandidates) {
          const n = Number(c)
          if (Number.isFinite(n)) {
            qty = n
            break
          }
        }
        if (qty == null) {
          const hasAmountSignal =
            row.salesAmountBase != null ||
            row.salesAmount != null ||
            row.salesAmountFormatted != null ||
            row.revenue != null ||
            row.gmv != null ||
            row.amount != null
          const todaySalesNum = Number(row.todaySales)
          if (!hasAmountSignal && Number.isFinite(todaySalesNum)) qty = todaySalesNum
        }
        return {
          rank: Number(row.rank ?? idx + 1),
          productId: String(row.productId ?? row.product_id ?? ''),
          skuId: typeof row.skuId === 'string' ? row.skuId : typeof row.sku_id === 'string' ? row.sku_id : undefined,
          sellerSku:
            typeof row.sellerSku === 'string' ? row.sellerSku : typeof row.seller_sku === 'string' ? row.seller_sku : undefined,
          sku: String(row.sku ?? row.sellerSku ?? row.seller_sku ?? row.skuId ?? row.sku_id ?? ''),
          productName: String(row.productName ?? row.product_name ?? row.name ?? row.title ?? 'Unknown Product'),
          product_name: String(row.product_name ?? row.productName ?? row.name ?? row.title ?? ''),
          todayQuantity: Number(row.todayQuantity ?? row.todaySales ?? row.soldQuantity ?? qty ?? 0),
          soldQuantity: qty,
          todaySales: Number(row.todaySales ?? qty ?? 0),
          orderCount: Number(row.orderCount ?? row.orders ?? 0),
          todayAmount: Number(row.todayAmount ?? row.salesAmountBase ?? row.salesAmount ?? row.sales_amount ?? 0),
          quantity: Number(row.quantity ?? row.todayQuantity ?? row.todaySales ?? row.soldQuantity ?? qty ?? 0),
          sales_amount: Number(row.sales_amount ?? row.salesAmountTarget ?? row.salesAmountBase ?? 0),
          gmv: Number(row.gmv ?? row.sales_amount ?? row.salesAmountTarget ?? 0),
          region: String(
            row.region ||
              row.market ||
              row.shopRegion ||
              row.shopMarket ||
              row.country ||
              '',
          ),
          market: String(
            row.market ||
              row.region ||
              row.shopMarket ||
              row.shopRegion ||
              row.country ||
              '',
          ),
          shopName:
            typeof row.shopName === 'string'
              ? row.shopName
              : typeof row.shop_name === 'string'
                ? row.shop_name
                : undefined,
          shop_name: String(row.shop_name ?? row.shopName ?? ''),
          shopId:
            typeof row.shopId === 'string'
              ? row.shopId
              : typeof row.shop_id === 'string'
                ? row.shop_id
                : undefined,
          salesAmountBase: Number(row.salesAmountBase ?? row.sales_amount ?? 0),
          salesAmountTarget: Number(row.salesAmountTarget ?? row.sales_amount ?? 0),
          salesAmountFormatted: typeof row.salesAmountFormatted === 'string' ? row.salesAmountFormatted : undefined,
          conversionRate: Number(row.conversionRate ?? 0),
          productStatus:
            (String(row.productStatus || 'Active') as 'Active' | 'Low Stock' | 'Out of Stock') || 'Active',
          targetCurrency: String(row.targetCurrency ?? (raw as GmvPayload).targetCurrency ?? 'USD'),
          skuName: typeof row.skuName === 'string' ? row.skuName : undefined,
          currency: typeof row.currency === 'string' ? row.currency : undefined,
        }
      })),
    }
    return patchGmvStatus(reconcileSummaryFromShops(normalized))
  }
  return null
}

type ProductRankingRow = GmvPayload['productRankings'][number]

function firstNonEmpty(...values: Array<unknown>) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) return value.trim()
  }
  return ''
}

function toFiniteNumber(value: unknown, fallback = 0) {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

function aggregateProductRankings(rows: ProductRankingRow[]) {
  const merged = new Map<string, ProductRankingRow>()
  for (const row of rows) {
    const productId = String(row.productId || '').trim()
    const skuId = String(row.skuId || '').trim()
    const sellerSku = String(row.sellerSku || '').trim()
    const productName = String(row.productName || '').trim()
    const shopKey = String(row.shopId || '')
      .trim()
      .toLowerCase() || 'unknown'
    const key = `${shopKey}::${productId || skuId || sellerSku || productName}`
    if (!key) continue
    const prev = merged.get(key)
    if (!prev) {
      merged.set(key, {
        ...row,
        productId,
        skuId,
        sellerSku,
        sku: String(row.sku || sellerSku || skuId || ''),
        productName: productName || 'Unknown Product',
        product_name: String(row.product_name || row.productName || productName || ''),
        shop_name: String(row.shop_name || row.shopName || ''),
        todayQuantity: toFiniteNumber(row.todayQuantity),
        soldQuantity: toFiniteNumber(row.soldQuantity),
        todaySales: toFiniteNumber(row.todaySales),
        orderCount: toFiniteNumber(row.orderCount),
        todayAmount: toFiniteNumber(row.todayAmount),
        salesAmountBase: toFiniteNumber(row.salesAmountBase),
        salesAmountTarget: toFiniteNumber(row.salesAmountTarget),
      })
      continue
    }
    merged.set(key, {
      ...prev,
      productId: firstNonEmpty(prev.productId, productId),
      skuId: firstNonEmpty(prev.skuId, skuId),
      sellerSku: firstNonEmpty(prev.sellerSku, sellerSku),
      sku: firstNonEmpty(prev.sku, row.sku, sellerSku, skuId),
      productName: firstNonEmpty(prev.productName, productName) || 'Unknown Product',
      product_name: firstNonEmpty(prev.product_name, row.product_name, prev.productName, row.productName, productName),
      region: firstNonEmpty(prev.region, row.region),
      market: firstNonEmpty(prev.market, row.market),
      shopName: firstNonEmpty(prev.shopName, row.shopName),
      shop_name: firstNonEmpty(prev.shop_name, row.shop_name, prev.shopName, row.shopName),
      todayQuantity: toFiniteNumber(prev.todayQuantity) + toFiniteNumber(row.todayQuantity),
      soldQuantity: toFiniteNumber(prev.soldQuantity) + toFiniteNumber(row.soldQuantity),
      todaySales: toFiniteNumber(prev.todaySales) + toFiniteNumber(row.todaySales),
      orderCount: toFiniteNumber(prev.orderCount) + toFiniteNumber(row.orderCount),
      todayAmount: toFiniteNumber(prev.todayAmount) + toFiniteNumber(row.todayAmount),
      salesAmountBase: toFiniteNumber(prev.salesAmountBase) + toFiniteNumber(row.salesAmountBase),
      salesAmountTarget: toFiniteNumber(prev.salesAmountTarget) + toFiniteNumber(row.salesAmountTarget),
    })
  }

  return [...merged.values()]
    .sort((a, b) => toFiniteNumber(b.todayQuantity) - toFiniteNumber(a.todayQuantity))
    .map((item, index) => ({
      ...item,
      rank: index + 1,
      productId: String(item.productId || '').trim() || `group-${index + 1}`,
      soldQuantity: toFiniteNumber(item.soldQuantity),
    }))
}

export function LegacyDashboardPage({
  appRole,
  appUserScope,
  appUsername,
  appAccess,
  onLogout,
}: {
  appRole: MeRole
  appUserScope: AuthSession['scope']
  appUsername: string
  appAccess: AccountAccess
  onLogout: () => void
}) {
  const nav = useNavigate()
  const platformScope = isPlatformScope({ scope: appUserScope, role: appRole })
  const viewCtx = usePlatformViewTenant()
  const [data, setData] = useState<GmvPayload | null>(null)
  const [shops, setShops] = useState<
    Array<{
      id?: number
      shopId?: string
      shopName?: string
      region?: string
      currency?: string
      enabled?: boolean
      status?: string
      tokenStatus?: string
      lastSyncAt?: string
      lastSyncOk?: boolean
      lastSyncError?: string
    }>
  >([])
  const [selectedShopId, setSelectedShopId] = useState('all')
  const [selectedRegion, setSelectedRegion] = useState('all')
  const [rankingData, setRankingData] = useState<GmvPayload | null>(null)
  const [shopsPanelOpen, setShopsPanelOpen] = useState(false)
  const [shopsPanelPage, setShopsPanelPage] = useState(1)
  const [baseCurrency, setBaseCurrency] = useState(() => readInitialCurrencies().base)
  const [targetCurrency, setTargetCurrency] = useState(() => readInitialCurrencies().target)

  useEffect(() => {
    if (shopsPanelOpen) setShopsPanelPage(1)
  }, [shopsPanelOpen])

  useEffect(() => {
    const maxPage = Math.max(1, Math.ceil(shops.length / SHOPS_PANEL_PAGE_SIZE))
    setShopsPanelPage((p) => Math.min(Math.max(1, p), maxPage))
  }, [shops.length])
  const [orderFilter, setOrderFilter] = useState<OrderFilter>(() => readInitialOrderFilter())
  const [timeRange, setTimeRange] = useState<TimeRangePreset>(() => readInitialTimeRange().preset)
  const [customStart, setCustomStart] = useState(() => readInitialTimeRange().start)
  const [customEnd, setCustomEnd] = useState(() => readInitialTimeRange().end)
  const { t: tx } = useI18n()
  const [customApplyNonce, setCustomApplyNonce] = useState(0)
  const [gmvLoading, setGmvLoading] = useState(true)
  const [gmvError, setGmvError] = useState(false)
  const [gmvErrorText, setGmvErrorText] = useState<string | null>(null)
  const [rateData, setRateData] = useState<ExchangeRatePayload | null>(null)
  const [rateError, setRateError] = useState(false)
  const [nowText, setNowText] = useState('')
  const rateRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const gmvControllerRef = useRef<AbortController | null>(null)
  const gmvLoadingRef = useRef(false)
  const rankingControllerRef = useRef<AbortController | null>(null)
  const rankingLoadingRef = useRef(false)
  const loadGmvFnRef = useRef<((opts?: { force?: boolean }) => Promise<void>) | null>(null)
  const loadRankingFnRef = useRef<((opts?: { force?: boolean }) => Promise<void>) | null>(null)
  const [mysqlAbnormalShopCount, setMysqlAbnormalShopCount] = useState(0)
  const [shopSummary, setShopSummary] = useState({
    totalAuthorized: 0,
    enabledCount: 0,
    todayOrderShopCount: 0,
    abnormalCount: 0,
  })

  const fetchShopSummary = useCallback(() => {
    const token = typeof localStorage !== 'undefined' ? localStorage.getItem(AUTH_TOKEN_KEY) : null
    if (!token) return Promise.resolve()
    return apiFetch('/api/shops/summary', { headers: { ...getAuthHeaders() }, cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (!j || typeof j !== 'object') return
        setShopSummary({
          totalAuthorized: Number((j as { totalAuthorized?: number }).totalAuthorized ?? 0),
          enabledCount: Number((j as { enabledCount?: number }).enabledCount ?? 0),
          todayOrderShopCount: Number((j as { todayOrderShopCount?: number }).todayOrderShopCount ?? 0),
          abnormalCount: Number((j as { abnormalCount?: number }).abnormalCount ?? 0),
        })
        setMysqlAbnormalShopCount(Number((j as { abnormalCount?: number }).abnormalCount ?? 0))
      })
      .catch(() => {})
  }, [])

  const fetchMysqlShopHealthSummary = useCallback(() => {
    const token = typeof localStorage !== 'undefined' ? localStorage.getItem(AUTH_TOKEN_KEY) : null
    if (!token) return Promise.resolve()
    return apiFetch('/api/shops/health', { headers: { ...getAuthHeaders() } })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (!j?.shops || !Array.isArray(j.shops)) return
        const n = j.shops.filter(
          (s: { last_health_status?: string; status?: string }) =>
            String(s.status || '') !== 'deleted' && String(s.last_health_status || 'unknown') !== 'normal',
        ).length
        setMysqlAbnormalShopCount(n)
      })
      .catch(() => {})
  }, [])

  useEffect(() => {
    void fetchShopSummary()
    void fetchMysqlShopHealthSummary()
  }, [fetchShopSummary, fetchMysqlShopHealthSummary, data?.meta?.updatedAt])

  useEffect(() => {
    const u = new URL(window.location.href)
    if (u.searchParams.get('orderFilter') === orderFilter) return
    u.searchParams.set('orderFilter', orderFilter)
    window.history.replaceState({}, '', `${u.pathname}${u.search}${u.hash}`)
  }, [orderFilter])

  useEffect(() => {
    try {
      localStorage.setItem(LS_BASE_CURRENCY, baseCurrency)
      localStorage.setItem(LS_TARGET_CURRENCY, targetCurrency)
    } catch {
      /* ignore */
    }
  }, [baseCurrency, targetCurrency])

  useEffect(() => {
    try {
      localStorage.setItem(LS_TIME_RANGE, timeRange)
    } catch {
      /* ignore */
    }
  }, [timeRange])

  useEffect(() => {
    try {
      localStorage.setItem(LS_CUSTOM_START, customStart)
      localStorage.setItem(LS_CUSTOM_END, customEnd)
    } catch {
      /* ignore */
    }
  }, [customStart, customEnd])

  useEffect(() => {
    const updateNow = () => {
      const now = new Date()
      const { clockIana } = getMarketStatsTimezoneDisplay(selectedRegion)
      if (!clockIana) {
        setNowText(tx('clock.browserLocal', { time: formatBrowserLocalClock(now) }))
      } else {
        setNowText(tx('clock.marketLocal', { time: formatClockInIanaZone(now, clockIana) }))
      }
    }
    updateNow()
    const timer = window.setInterval(updateNow, 1000)
    return () => window.clearInterval(timer)
  }, [selectedRegion, tx])

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const auth = params.get('shop_auth')
    if (!auth) return

    const stripAuthParams = () => {
      params.delete('shop_auth')
      params.delete('reason')
      params.delete('imported')
      params.delete('updated')
      params.delete('skipped')
      const qs = params.toString()
      const next = `${window.location.pathname}${qs ? `?${qs}` : ''}${window.location.hash}`
      window.history.replaceState({}, '', next)
    }

    if (auth === 'ok') {
      const imported = params.get('imported') || '0'
      const skipped = params.get('skipped') || '0'
      if (Number(skipped) > 0) {
        try {
          alert(`${tx('auth.alertPrefix')}imported=${imported}, skipped=${skipped} (max_shops)`)
        } catch {
          /* ignore */
        }
      }
      void fetchShopSummary()
      void handleOpenShopsPanel()
    } else if (auth === 'error') {
      const reason = params.get('reason') || 'unknown'
      try {
        alert(`${tx('auth.alertPrefix')}${decodeURIComponent(reason)}`)
      } catch {
        alert(`${tx('auth.alertPrefix')}${reason}`)
      }
    }
    stripAuthParams()
  }, [tx])

  useEffect(() => {
    void fetchShopSummary()
  }, [fetchShopSummary])

  useEffect(() => {
    const onTenantView = () => {
      void fetchShopSummary()
      void loadGmvFnRef.current?.({ force: true })
      void loadRankingFnRef.current?.({ force: true })
    }
    window.addEventListener('daping:platform-view-tenant', onTenantView)
    return () => window.removeEventListener('daping:platform-view-tenant', onTenantView)
  }, [fetchShopSummary])

  useEffect(() => {
    let isAlive = true
    const loadRankingData = async (force = false) => {
      if (platformScope && !getPlatformViewTenantId()) {
        if (isAlive) setRankingData(null)
        return
      }
      if (!force && rankingLoadingRef.current) return
      rankingControllerRef.current?.abort()
      const controller = new AbortController()
      rankingControllerRef.current = controller
      rankingLoadingRef.current = true
      try {
        const regionParam = selectedRegion === 'all' ? 'all' : selectedRegion.toUpperCase()
        const marketParam = selectedRegion === 'all' ? 'ALL' : selectedRegion.toUpperCase()
        const params = new URLSearchParams({
          shopId: 'all',
          region: regionParam,
          market: marketParam,
          orderFilter,
          baseCurrency,
          targetCurrency,
        })
        appendDashboardTimeQuery(params, timeRange, customStart, customEnd)
        params.set('_t', String(Date.now()))
        const res = await fetchWithTimeout(`/api/dashboard?${params.toString()}`, {
          cache: 'no-store',
          signal: controller.signal,
        })
        if (!res.ok) throw new Error(`ranking http ${res.status}`)
        const raw = await res.json()
        const payload = adaptGmvResponse(raw, orderFilter, 'all')
        if (isAlive) setRankingData(payload)
      } catch (err) {
        if (isRequestAbortedError(err)) return
        if (isAlive) setRankingData(null)
      } finally {
        if (rankingControllerRef.current === controller) {
          rankingLoadingRef.current = false
        }
      }
    }
    loadRankingFnRef.current = (opts) => loadRankingData(opts?.force === true)
    void loadRankingData()
    const timer = window.setInterval(loadRankingData, 300000)
    return () => {
      isAlive = false
      rankingControllerRef.current?.abort()
      rankingControllerRef.current = null
      rankingLoadingRef.current = false
      loadRankingFnRef.current = null
      window.clearInterval(timer)
    }
  }, [baseCurrency, targetCurrency, orderFilter, selectedRegion, timeRange, customApplyNonce, platformScope, viewCtx?.viewingTenantId])

  useEffect(() => {
    let isAlive = true

    const loadGmv = async (force = false) => {
      if (platformScope && !getPlatformViewTenantId()) {
        if (isAlive) {
          setGmvLoading(false)
          setData(null)
        }
        return
      }
      if (!force && gmvLoadingRef.current) return
      gmvControllerRef.current?.abort()
      const controller = new AbortController()
      gmvControllerRef.current = controller
      gmvLoadingRef.current = true

      if (isAlive) {
        setGmvLoading(true)
        setGmvError(false)
        setGmvErrorText(null)
      }

      const timeoutTimer = window.setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
      try {
        const params = new URLSearchParams({
          shopId: selectedShopId,
          region: selectedRegion === 'all' ? 'all' : selectedRegion.toUpperCase(),
          market: selectedRegion === 'all' ? 'ALL' : selectedRegion.toUpperCase(),
          orderFilter,
          baseCurrency,
          targetCurrency,
        })
        appendDashboardTimeQuery(params, timeRange, customStart, customEnd)
        params.set('_t', String(Date.now()))
        const gmvUrl = `/api/dashboard?${params.toString()}`
        const res = await fetchWithAuth(gmvUrl, { signal: controller.signal, cache: 'no-store' })
        if (!res.ok) throw new Error(`gmv http ${res.status}`)
        const raw = await res.json()

        const payload = adaptGmvResponse(raw, orderFilter, selectedShopId)
        console.log('[GMV RAW]', payload)
        console.log('[GMV SUMMARY]', payload?.summary)

        if (isAlive) {
          if (payload) {
            setData(payload)
            setGmvError(false)
            setGmvErrorText(null)
            setRateData((prev) =>
              prev ?? {
                baseCurrency: payload.baseCurrency,
                targetCurrency: payload.targetCurrency,
                rate: payload.exchangeRate,
                updatedAt: payload.meta.updatedAt,
                source: 'gmv',
                status: 'normal',
              },
            )
          } else {
            setGmvError(true)
            setGmvErrorText('PAYLOAD_NULL')
          }
        }
      } catch (err) {
        if (isRequestAbortedError(err)) {
          console.debug('[GMV request aborted, keep previous data]')
          return
        }
        console.error('[GMV API ERROR]', err)
        if (isAlive) {
          setGmvError(true)
          setGmvErrorText(String((err as Error)?.message || err))
        }
      } finally {
        window.clearTimeout(timeoutTimer)
        if (gmvControllerRef.current === controller) {
          gmvLoadingRef.current = false
          if (isAlive) setGmvLoading(false)
        }
      }
    }

    loadGmvFnRef.current = (opts) => loadGmv(opts?.force === true)

    const applyRateFallback = () => {
      if (!isAlive) return
      setRateData(buildFallbackExchangeRate(baseCurrency, targetCurrency))
      setRateError(false)
    }

    const fetchRate = async (force = false, isAutoRetry = false) => {
      try {
        const rateUrl = `/api/exchange-rate?base=${baseCurrency}&target=${targetCurrency}${force ? '&force=1' : ''}`
        const rateResponse = await fetchWithTimeout(rateUrl)
        if (!rateResponse.ok) throw new Error('rate request failed')
        const payload: ExchangeRatePayload = await rateResponse.json()
        const rate = Number(payload.rate)
        if (!Number.isFinite(rate) || rate <= 0) throw new Error('empty rate')
        writeExchangeRateCache(baseCurrency, targetCurrency, payload)
        if (isAlive) {
          setRateData(payload)
          setRateError(payload.status !== 'normal' && payload.status !== 'warning')
        }
      } catch {
        if (!isAlive) return
        applyRateFallback()
        if (!isAutoRetry && rateRetryTimerRef.current == null) {
          rateRetryTimerRef.current = setTimeout(() => {
            rateRetryTimerRef.current = null
            void fetchRate(true, true)
          }, 30000)
        }
      }
    }

    const cachedRate = readExchangeRateCache(baseCurrency, targetCurrency)
    if (cachedRate) {
      setRateData({ ...cachedRate, source: 'cache', status: 'cached' })
      setRateError(false)
    } else {
      setRateData(buildLoadingExchangeRate(baseCurrency, targetCurrency))
      setRateError(false)
    }

    loadGmv()
    void fetchRate(false)
    // 轮询间隔改为 300 秒，避免重叠与 pending 堆积
    const gmvTimer = window.setInterval(loadGmv, 300000)
    const rateTimer = window.setInterval(() => fetchRate(false), 10 * 60 * 1000)
    return () => {
      isAlive = false
      window.clearInterval(gmvTimer)
      window.clearInterval(rateTimer)
      if (rateRetryTimerRef.current != null) {
        clearTimeout(rateRetryTimerRef.current)
        rateRetryTimerRef.current = null
      }
      gmvControllerRef.current?.abort()
      gmvLoadingRef.current = false
    }
  }, [selectedShopId, selectedRegion, orderFilter, baseCurrency, targetCurrency, timeRange, customApplyNonce, platformScope, viewCtx?.viewingTenantId])

  const gmvCompareQueryBounds = useMemo(
    () => getDashboardBoundsForQuery(timeRange, customStart, customEnd),
    [timeRange, customStart, customEnd],
  )

  const resolvedGmvErrorText = useMemo(() => {
    if (!gmvErrorText) return null
    if (gmvErrorText === 'PAYLOAD_NULL') return tx('app.gmvPayloadError')
    return gmvErrorText
  }, [gmvErrorText, tx])

  const orderFilterLabel = useMemo(() => {
    switch (orderFilter) {
      case 'all':
        return tx('filter.order.all')
      case 'unpaid':
        return tx('filter.order.unpaid')
      case 'sample':
        return tx('filter.order.sample')
      case 'cancelled':
        return tx('filter.order.cancelled')
      default:
        return tx('filter.order.valid')
    }
  }, [tx, orderFilter])

  const shopScopeLabel = useMemo(() => {
    if (selectedShopId === 'all') return tx('table.allShops')
    const hit = data?.shops?.find((s) => normalizeShopId(s.shopId, s.shopName) === selectedShopId)
    return hit?.shopName ?? selectedShopId
  }, [data, selectedShopId, tx])

  const regionScopeLabel = selectedRegion === 'all' ? tx('market.all') : selectedRegion
  const marketStatsTimezoneHeadline = useMemo(() => {
    const { headline } = getMarketStatsTimezoneDisplay(selectedRegion)
    return headline === 'Multi Timezone' ? tx('ui.multiTimezone') : headline
  }, [selectedRegion, tx])
  const chartScopeSuffix = useMemo(() => {
    const sep = tx('chart.scopeSep')
    return [orderFilterLabel, shopScopeLabel, regionScopeLabel].join(sep)
  }, [tx, orderFilterLabel, shopScopeLabel, regionScopeLabel])

  const regionsWithAuthorizedShop = useMemo(() => {
    const set = new Set<string>()
    for (const s of shops) {
      const r = String(s?.region || '').trim().toUpperCase()
      if (r) set.add(r)
    }
    return set
  }, [shops])

  /** 固定五国 + 已授权但不在固定列表中的 region（排序追加），不读取 dashboard shops */
  const marketFilterButtons = useMemo(() => {
    const fixed = [...MARKET_FILTER_CODES]
    const extra = [...regionsWithAuthorizedShop]
      .filter((r) => !(MARKET_FILTER_CODES as readonly string[]).includes(r))
      .sort()
    return [...fixed, ...extra]
  }, [regionsWithAuthorizedShop])

  const rankingShops = useMemo(() => {
    const shopSource =
      selectedShopId === 'all' && (data?.shops?.length ?? 0) > 0 ? data!.shops! : rankingData?.shops ?? []
    const rows = [...shopSource].map((s) => ({
      ...s,
      shopId: normalizeShopId(s.shopId, s.shopName),
    }))
    rows.sort((a, b) => {
      if (b.todayOrders !== a.todayOrders) return b.todayOrders - a.todayOrders
      return a.shopName.localeCompare(b.shopName, 'en')
    })
    return rows.map((item, index) => ({ ...item, rank: index + 1 }))
  }, [rankingData, data?.shops, selectedShopId])

  const shopOrdersById = useMemo(() => {
    const m = new Map<string, number>()
    for (const s of rankingShops) {
      m.set(normalizeShopId(s.shopId, s.shopName), Number(s.todayOrders || 0))
    }
    return m
  }, [rankingShops])

  const activeShopCount = useMemo(
    () => rankingShops.filter((s) => Number(s.todayOrders || 0) > 0).length,
    [rankingShops],
  )

  const shopsPanelTotalPages = Math.max(1, Math.ceil(shops.length / SHOPS_PANEL_PAGE_SIZE))
  const shopsPanelPagedList = useMemo(() => {
    const start = (shopsPanelPage - 1) * SHOPS_PANEL_PAGE_SIZE
    return shops.slice(start, start + SHOPS_PANEL_PAGE_SIZE)
  }, [shops, shopsPanelPage])

  useEffect(() => {
    if (selectedRegion === 'all') return
    if (!marketFilterButtons.includes(selectedRegion)) setSelectedRegion('all')
  }, [marketFilterButtons, selectedRegion])

  const handleSelectShop = (shopId: string, shopName?: string) => {
    const next = normalizeShopId(shopId, shopName) || 'all'
    setSelectedShopId(next)
  }

  /** 与核心看板 summary.todayOrders 同源（orderId 去重后）；选中「全部店铺」时与 KPI 一致 */
  const allShopsOrderTotal = useMemo(() => {
    if (selectedShopId === 'all') {
      return Number(data?.summary?.todayOrders ?? rankingData?.summary?.todayOrders ?? 0)
    }
    return Number(
      rankingData?.summary?.todayOrders ??
        rankingShops.reduce((sum, s) => sum + (Number.isFinite(s.todayOrders) ? s.todayOrders : 0), 0),
    )
  }, [selectedShopId, data?.summary?.todayOrders, rankingData?.summary?.todayOrders, rankingShops])

  const totals = useMemo(() => {
    const s = data?.summary
    if (!s) {
      return { count: 0, gmvBase: 0, gmvTarget: 0, avgBase: 0, avgTarget: 0 }
    }
    return {
      count: s.todayOrders,
      gmvBase: safeNum(s.todayGmvBase, 2),
      gmvTarget: safeNum(s.todayGmvTarget, 2),
      avgBase: safeNum(s.avgOrderValueBase, 2),
      avgTarget: safeNum(s.avgOrderValueTarget, 2),
    }
  }, [data])

  const displayTarget = rateData?.targetCurrency ?? data?.targetCurrency ?? targetCurrency
  const displayBase = rateData?.baseCurrency ?? data?.baseCurrency ?? baseCurrency

  const ordersOption = useMemo(
    () => ({
      backgroundColor: 'transparent',
      tooltip: { trigger: 'axis' },
      grid: { left: 52, right: 24, top: 32, bottom: 40 },
      xAxis: {
        type: 'category',
        data: data?.trend.map((item) => item.time) ?? [],
        boundaryGap: false,
        axisLabel: { color: '#8FA3B8' },
        axisLine: { lineStyle: { color: '#29415D' } },
      },
      yAxis: {
        type: 'value',
        axisLabel: { color: '#8FA3B8' },
        splitLine: { lineStyle: { color: '#1A2A41' } },
      },
      series: [
        {
          name: tx('chart.orderVolume'),
          type: 'line',
          smooth: true,
          showSymbol: false,
          lineStyle: { color: '#20D6B5', width: 3 },
          areaStyle: { color: 'rgba(32, 214, 181, 0.15)' },
          data: data?.trend.map((item) => Math.round(item.orders)) ?? [],
        },
      ],
    }),
    [data, tx],
  )

  const ordersChartRef = useRef<HTMLDivElement>(null)
  const ordersChartSize = useChartResize(ordersChartRef, [data?.trend?.length, ordersOption])

  useEffect(() => {
    document.documentElement.classList.add('legacy-dashboard-route')
    return () => {
      document.documentElement.classList.remove('legacy-dashboard-route')
    }
  }, [])

  const collectWarning =
    data?.summary?.status === 'warning' &&
    (data?.meta?.dataSource === 'seller_center' || data?.meta?.dataSource === 'seller_center_stale')
  const statusText = useMemo(() => {
    if (gmvError) return tx('kpi.status.dataError')
    if (collectWarning) return tx('kpi.status.collectWarning')
    if (data?.summary?.status === 'normal') return tx('kpi.status.normal')
    return tx('kpi.status.abnormal')
  }, [gmvError, collectWarning, data?.summary?.status, tx])
  const statusClass = gmvError
    ? 'danger'
    : collectWarning
      ? 'warn'
      : data?.summary?.status !== 'normal'
        ? 'danger'
        : 'normal'
  const fallbackRate =
    rateData?.rate && Number.isFinite(rateData.rate) && rateData.rate > 0
      ? rateData.rate
      : buildFallbackExchangeRate(baseCurrency, targetCurrency).rate
  const rawRate = rateData?.rate ?? data?.exchangeRate ?? fallbackRate
  const effectiveRate = Number.isFinite(rawRate) && rawRate > 0 ? rawRate : fallbackRate
  const rateStatusClass =
    isSoftRateStatus(rateData?.status)
      ? 'normal'
      : rateError || rateData?.status !== 'normal' || !Number.isFinite(rawRate) || rawRate <= 0
        ? 'danger'
        : 'normal'
  const displayRate = safeNum(effectiveRate, 4)
  const rateUpdatedAt =
    rateData?.status === 'loading'
      ? tx('rate.loading')
      : rateData?.updatedAt ?? data?.meta?.updatedAt ?? nowText
  const authConnected = shopSummary.totalAuthorized > 0
  const dataSourceKey = String(data?.meta?.dataSource || '').toLowerCase()
  const collectAtText = String(data?.meta?.lastCollectAt || data?.meta?.updatedAt || '--')
  const isOverviewSource = dataSourceKey === 'tiktok_overview'
  const isOpenApiOrdersSource = dataSourceKey === 'tiktok_open_api_orders'
  const hasOrderStatusDimension =
    isOpenApiOrdersSource ||
    dataSourceKey.includes('order_detail') ||
    dataSourceKey.includes('tiktok_orders') ||
    (Array.isArray(data?.orders) && data.orders.some((o) => String(o?.orderStatus || '').trim() !== ''))
  const ordersCacheHasRows = Number(data?.meta?.ordersLoadedCount ?? 0) > 0

  const productRankingEmptyMessage = useMemo(() => {
    if (isOpenApiOrdersSource && ordersCacheHasRows) return tx('empty.products.filtered')
    return tx('empty.products.noData')
  }, [isOpenApiOrdersSource, ordersCacheHasRows, tx])

  const handleAuth = () => {
    window.location.href = tiktokOAuthStartUrl()
  }

  function mapMysqlShopForPanel(row: Record<string, unknown>) {
    const st = String(row.status || '').toLowerCase()
    const syncOn = !(row.sync_enabled === 0 || row.sync_enabled === false)
    return {
      id: Number(row.id),
      shopId: String(row.platform_shop_id || ''),
      shopName: String(row.display_name || row.shop_name || row.platform_shop_id || ''),
      region: String(row.region || row.market || '').toUpperCase(),
      enabled: st === 'active' && syncOn,
      tokenStatus: String(row.auth_status || row.last_health_status || 'unknown'),
      lastSyncAt: String(row.last_sync_at || row.last_authorized_at || row.updated_at || ''),
      status: st,
    }
  }

  const handleOpenShopsPanel = async () => {
    try {
      const res = await apiFetch('/api/shops', { headers: { ...getAuthHeaders() }, cache: 'no-store' })
      const payload = await res.json().catch(() => ({}))
      if (res.ok) {
        const rows = Array.isArray((payload as { shops?: unknown[] }).shops)
          ? ((payload as { shops: Record<string, unknown>[] }).shops.map(mapMysqlShopForPanel))
          : []
        setShops(rows)
      }
    } catch {
      // keep previous rows
    } finally {
      setShopsPanelOpen(true)
    }
  }

  const handleHeaderOpenShops = () => {
    if (authConnected) {
      if (isAdminLike(appRole)) nav('/shops')
      else void handleOpenShopsPanel()
    } else {
      handleAuth()
    }
  }

  const handleRefreshRate = async () => {
    try {
      const rateResp = await fetchWithTimeout(
        `/api/exchange-rate?base=${baseCurrency}&target=${targetCurrency}&force=1`,
      )
      if (!rateResp.ok) throw new Error('rate refresh failed')
      const ratePayload: ExchangeRatePayload = await rateResp.json()
      const rate = Number(ratePayload.rate)
      if (!Number.isFinite(rate) || rate <= 0) throw new Error('empty rate')
      writeExchangeRateCache(baseCurrency, targetCurrency, ratePayload)
      setRateData(ratePayload)
      setRateError(ratePayload.status !== 'normal' && ratePayload.status !== 'warning')
    } catch {
      setRateData(buildFallbackExchangeRate(baseCurrency, targetCurrency))
      setRateError(false)
    }
  }

  return (
    <div className="legacy-dashboard">
    <div className="war-room war-room--viewport">
      {gmvLoading && !data ? (
        <div className="loading" style={{ padding: 16 }}>
          {tx('app.gmvLoading')}
        </div>
      ) : null}
      {gmvError && resolvedGmvErrorText ? (
        <div className="warn-text" style={{ padding: 16 }}>
          {tx('app.gmvErrorDetail', { prefix: tx('app.gmvErrorPrefix'), detail: resolvedGmvErrorText })}
        </div>
      ) : null}
      {platformScope && !viewCtx?.viewingTenantId ? (
        <div className="warn-text" style={{ padding: '12px 16px', marginBottom: 8 }}>
          请选择租户查看数据
        </div>
      ) : null}
      {!platformScope && !authConnected && !gmvLoading ? (
        <div className="warn-text" style={{ padding: '12px 16px', marginBottom: 8 }}>
          {tx('dashboard.authorizeShopsFirst')}
        </div>
      ) : null}
      <DashboardHeader
        appRole={appRole}
        appUserScope={appUserScope}
        appUsername={appUsername}
        appAccess={appAccess}
        platformScope={platformScope}
        authConnected={authConnected}
        shopSummary={shopSummary}
        activeShopCount={activeShopCount}
        nowText={nowText}
        marketStatsTimezoneHeadline={marketStatsTimezoneHeadline}
        displayBase={displayBase}
        displayTarget={displayTarget}
        displayRate={displayRate}
        rateUpdatedAt={rateUpdatedAt}
        baseCurrency={baseCurrency}
        targetCurrency={targetCurrency}
        onBaseCurrencyChange={setBaseCurrency}
        onTargetCurrencyChange={setTargetCurrency}
        onRefreshRate={handleRefreshRate}
        onLogout={onLogout}
        onOpenShops={handleHeaderOpenShops}
        metaSlot={
          <>
            {platformScope ? <TenantViewSelector /> : null}
            <div className="debug-meta-hint">
              {tx('meta.dataLine', {
                label: tx('meta.dataCollectAt'),
                collectAt: collectAtText,
                orders: data?.summary?.todayOrders ?? 0,
                shops: shopSummary.totalAuthorized,
                trend: data?.trend?.length ?? 0,
              })}
            </div>
            {data?.meta?.collectWarning ? <div className="warn-text">{data.meta.collectWarning}</div> : null}
            {import.meta.env.DEV ? (
              <div className="debug-meta-hint">
                {`meta: dataSource=${String(data?.meta?.dataSource ?? '∅')} | insightsOverview=${String(data?.meta?.insightsOverview)} | insightsProductRankings=${String(data?.meta?.insightsProductRankings)} | timeRange=${String(data?.meta?.timeRange ?? '')}`}
              </div>
            ) : null}
          </>
        }
      />
      

      {shopsPanelOpen ? (
        <div
          role="dialog"
          aria-modal="true"
          onClick={() => setShopsPanelOpen(false)}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.55)',
            zIndex: 1000,
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'center',
            padding: 24,
            overflowX: 'hidden',
            boxSizing: 'border-box',
          }}
        >
          <div
            className="shops-authorized-modal"
            onClick={(e) => e.stopPropagation()}
            style={{
              width: '100%',
              maxWidth: 960,
              boxSizing: 'border-box',
              background: '#0E1B2C',
              border: '1px solid #1A2A41',
              borderRadius: 12,
              padding: 16,
              overflowX: 'hidden',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
              <div>
                <div style={{ fontSize: 16, fontWeight: 700 }}>{tx('shops.panelTitle')}</div>
                <div className="debug-meta-hint">{tx('shops.connectedCount', { n: shopSummary.totalAuthorized })}</div>
              </div>
              <button
                type="button"
                className="refresh-btn"
                onClick={() => {
                  setShopsPanelOpen(false)
                }}
              >
                {tx('shops.close')}
              </button>
            </div>

            <div style={{ marginTop: 12, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
              {isAdminLike(appRole) ? (
                <>
                  <button
                    type="button"
                    className="refresh-btn"
                    onClick={() => {
                      window.location.href = tiktokOAuthStartUrl()
                    }}
                    style={{ fontWeight: 600 }}
                  >
                    {tx('shops.addAuth')}
                  </button>
                  <span className="debug-meta-hint">{tx('shops.addAuthHint')}</span>
                </>
              ) : (
                <span className="debug-meta-hint">{tx('dashboard.viewerReadonlyHint')}</span>
              )}
            </div>

            <div className="table-wrap" style={{ marginTop: 12 }}>
              <table>
                <thead>
                  <tr>
                    <th>{tx('shops.thShopName')}</th>
                    <th>{tx('shops.thMarket')}</th>
                    <th>{tx('shops.thShopId')}</th>
                    <th>{tx('shops.thEnabled')}</th>
                    <th>{tx('shops.thToken')}</th>
                    <th>{tx('shops.thSync')}</th>
                    <th>{tx('shops.thAction')}</th>
                  </tr>
                </thead>
                <tbody>
                  {shops.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="empty-cell">
                        {tx('shops.emptyList')}
                      </td>
                    </tr>
                  ) : (
                    shopsPanelPagedList.map((s) => {
                      const shopId = String(s.shopId || '')
                      const shopName = String(s.shopName || shopId || 'TikTok Shop')
                      const region = String(s.region || '').toUpperCase() || '--'
                      const tokenStatus = String(s.tokenStatus || s.status || '--')
                      const lastSyncAt = String(s.lastSyncAt || (s as { updatedAt?: string })?.updatedAt || '--')
                      const enabled = s.enabled !== false
                      const normalizedShopId = normalizeShopId(shopId, shopName)
                      const todayOrders = shopOrdersById.get(normalizedShopId) ?? 0
                      return (
                        <tr key={shopId || shopName}>
                          <td>{shopName}</td>
                          <td>{region}</td>
                          <td>{shopId || '--'}</td>
                          <td>{enabled ? 'enabled' : 'disabled'}</td>
                          <td>{todayOrders > 0 ? tokenStatus : tx('shops.noOrdersToday', { status: tokenStatus })}</td>
                          <td>{lastSyncAt}</td>
                          <td>
                            {isViewerLike(appRole) ? (
                              '—'
                            ) : (
                              <button
                                type="button"
                                className="refresh-btn"
                                onClick={async () => {
                                  const mysqlId = Number((s as { id?: number }).id)
                                  if (!Number.isFinite(mysqlId)) return
                                  await apiFetch(`/api/shops/${mysqlId}/status`, {
                                    method: 'PATCH',
                                    headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
                                    body: JSON.stringify({ status: enabled ? 'disabled' : 'active' }),
                                  }).catch(() => null)
                                  const latest = await apiFetch('/api/shops', {
                                    headers: { ...getAuthHeaders() },
                                    cache: 'no-store',
                                  })
                                    .then((r) => r.json())
                                    .catch(() => null)
                                  const rows = Array.isArray((latest as { shops?: Record<string, unknown>[] })?.shops)
                                    ? (latest as { shops: Record<string, unknown>[] }).shops.map(mapMysqlShopForPanel)
                                    : []
                                  setShops(rows)
                                  void fetchShopSummary()
                                }}
                              >
                                {enabled ? tx('shops.disable') : tx('shops.enable')}
                              </button>
                            )}
                          </td>
                        </tr>
                      )
                    })
                  )}
                </tbody>
              </table>
            </div>
            {shops.length > 0 ? (
              <div className="shops-panel-pager">
                <button
                  type="button"
                  className="refresh-btn"
                  disabled={shopsPanelPage <= 1}
                  onClick={() => setShopsPanelPage((p) => Math.max(1, p - 1))}
                >
                  {tx('shops.prev')}
                </button>
                <span className="shops-panel-pager-info">{`${shopsPanelPage} / ${shopsPanelTotalPages}`}</span>
                <button
                  type="button"
                  className="refresh-btn"
                  disabled={shopsPanelPage >= shopsPanelTotalPages}
                  onClick={() => setShopsPanelPage((p) => Math.min(shopsPanelTotalPages, p + 1))}
                >
                  {tx('shops.next')}
                </button>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      <main className="legacy-war-room-grid three-column war-room-grid">
        <section className="col left-col left-column">
          <div className="tech-panel filter-panel filter-panel--stacked">
            <div className="filter-cluster-title">{tx('market.heading')}</div>
            <div className="filter-buttons">
              <button type="button" className={selectedRegion === 'all' ? 'active' : ''} onClick={() => setSelectedRegion('all')}>
                {tx('market.all')}
              </button>
              {marketFilterButtons.map((r) => {
                const hasAuth = regionsWithAuthorizedShop.has(r)
                return (
                  <button
                    type="button"
                    key={r}
                    className={`${selectedRegion === r ? 'active' : ''}${!hasAuth ? ' market-filter-muted' : ''}`}
                    onClick={() => setSelectedRegion(r)}
                  >
                    {r}
                  </button>
                )
              })}
            </div>
          </div>
          <div className="tech-panel table-panel ranking-panel rank-panel">
            <h3 className="ranking-panel-heading">
              <span>{tx('shop.rankTitle')}</span>
              {data?.meta?.dataSource === 'tiktok_insights' && selectedShopId === 'all' ? (
                <small className="ranking-mock-hint">{tx('ranking.mockHint')}</small>
              ) : null}
              {isAdminLike(appRole) && mysqlAbnormalShopCount > 0 ? (
                <button
                  type="button"
                  className="ranking-abnormal-entry"
                  onClick={() => nav('/shops?healthFilter=abnormal')}
                >
                  {tx('header.abnormalShopsEntry', { n: mysqlAbnormalShopCount })}
                </button>
              ) : null}
            </h3>
            <div className="table-wrap">
              <table className="shop-ranking-table">
                <colgroup>
                  <col className="shop-ranking-col-rank" />
                  <col className="shop-ranking-col-name" />
                  <col className="shop-ranking-col-region" />
                  <col className="shop-ranking-col-gmv" />
                  <col className="shop-ranking-col-orders" />
                </colgroup>
                <thead>
                  <tr>
                    <th>{tx('table.rank')}</th>
                    <th>{tx('table.shopName')}</th>
                    <th>{tx('table.market')}</th>
                    <th className="num">{tx('table.shopGmv')}</th>
                    <th className="num">{tx(`table.ordersCount.${timeRange}`)}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr
                    className={`shop-ranking-row shop-ranking-row--all ${selectedShopId === 'all' ? 'shop-ranking-row--active' : ''}`}
                    onClick={() => handleSelectShop('all')}
                    role="presentation"
                  >
                    <td className="rank-all">—</td>
                    <td className="cell-shop">{tx('table.allShops')}</td>
                    <td>{tx('market.all')}</td>
                    <td className="num">{formatCurrency(displayTarget, totals.gmvTarget)}</td>
                    <td className="num cell-orders-hl">
                      {selectedShopId === 'all' ? totals.count : allShopsOrderTotal}
                    </td>
                  </tr>
                  {rankingShops.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="table-empty">
                        {tx('empty.shops')}
                      </td>
                    </tr>
                  ) : (
                    rankingShops.map((item) => (
                      <tr
                        key={item.shopId}
                        className={`shop-ranking-row ${selectedShopId === item.shopId ? 'shop-ranking-row--active' : ''}`}
                        onClick={() => handleSelectShop(item.shopId, item.shopName)}
                        role="presentation"
                      >
                        <td
                          className={
                            item.rank === 1 ? 'rank-1' : item.rank === 2 ? 'rank-2' : item.rank === 3 ? 'rank-3' : ''
                          }
                        >
                          {item.rank}
                        </td>
                        <td className="cell-shop">{item.shopName}</td>
                        <td>{formatMarket(item.market || item.region)}</td>
                        <td className="num">{formatCurrency(displayTarget, shopGmvDisplayValue(item))}</td>
                        <td className="num cell-orders-hl">{item.todayOrders}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>

          <div className="tech-panel table-panel product-ranking-panel product-panel">
            <h3>{tx(`product.rankTitle.${timeRange}`)}</h3>
            <div className="table-wrap product-ranking-wrap product-ranking-table-wrap">
              {(data?.productRankings ?? []).length === 0 ? (
                <div className="empty-cell product-ranking-empty">{productRankingEmptyMessage}</div>
              ) : (
                <table className="product-ranking-table">
                  <colgroup>
                    <col className="pr-col-rank" />
                    <col className="pr-col-name-col" />
                    <col className="pr-col-qty" />
                  </colgroup>
                  <thead>
                    <tr>
                      <th className="pr-col-rank">#</th>
                      <th className="pr-col-name-head">{tx('table.productName')}</th>
                      <th className="num pr-col-qty">{tx(`table.qty.${timeRange}`)}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(data?.productRankings ?? []).slice(0, PRODUCT_RANK_CARD_ROWS).map((item) => {
                      const shopLabel = String(item.shop_name || item.shopName || '—')
                      const marketCode = formatMarket(item.market || item.region)
                      const metaLine = tx('product.metaLine', { market: marketCode, shop: shopLabel })
                      const qty = item.soldQuantity ?? item.todaySales ?? item.quantity ?? item.todayQuantity
                      const titleMain = `${item.productName} (${item.productId})`
                      return (
                        <tr key={`${String(item.shopId || '')}-${item.productId}-${item.rank}`}>
                          <td className="pr-col-rank">{item.rank}</td>
                          <td className="pr-col-name">
                            <div className="pr-name-stack">
                              <div className="pr-name-line1" title={titleMain}>
                                {truncateProductTitle(item.productName, 42)}
                              </div>
                              <div className="pr-name-line2" title={metaLine}>
                                {metaLine}
                              </div>
                            </div>
                          </td>
                          <td className="num pr-col-qty">{qty == null ? '—' : String(qty)}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              )}
            </div>
          </div>

        </section>

        <section className="col center-col center-column">
          <div className="tech-panel hero-panel">
            <h3>{tx('kpi.coreTitle', { shop: shopScopeLabel })}</h3>
            <div className="hero-kpi">
              <div>
                <span>{tx(`kpi.ordersCount.${timeRange}`)}</span>
                <strong className="glow-num hero-kpi-num">{totals.count}</strong>
              </div>
              <div>
                <span>{tx(`kpi.gmvPrimary.${timeRange}`, { target: displayTarget })}</span>
                <strong className="gold-num hero-kpi-num gmv-value">{formatAmount(displayTarget, totals.gmvTarget)}</strong>
                <small>{formatAmount(displayBase, totals.gmvBase)}</small>
              </div>
            </div>
            <div className="core-grid core-grid--quad">
              <div>
                <span>{tx(`kpi.gmvBase.${timeRange}`, { base: displayBase })}</span>
                <strong>{formatAmount(displayBase, totals.gmvBase)}</strong>
              </div>
              <div>
                <span>{tx('kpi.aov', { target: displayTarget })}</span>
                <strong>{formatAmount(displayTarget, totals.avgTarget)}</strong>
              </div>
              <div>
                <span>{tx('kpi.fxPair', { base: displayBase, target: displayTarget })}</span>
                <strong className={rateStatusClass}>{displayRate.toFixed(4)}</strong>
              </div>
              <div>
                <span>{tx('kpi.collectStatus')}</span>
                <strong className={statusClass}>{statusText}</strong>
              </div>
            </div>
            {data?.meta?.insightsOverview && (
              <div className="core-grid core-grid--pair insights-mini-kpi">
                <div>
                  <span>{tx('kpi.itemSold')}</span>
                  <strong className="glow-num">{Math.round(data.summary.itemSoldCount ?? 0).toLocaleString('en-US')}</strong>
                </div>
                <div>
                  <span>{tx('kpi.skuOrders')}</span>
                  <strong className="glow-num">{Math.round(data.summary.skuOrderCount ?? 0).toLocaleString('en-US')}</strong>
                </div>
              </div>
            )}
            <div className="core-grid core-grid--pair">
              <div>
                <span>{tx('meta.rateUpdatedAt')}</span>
                <strong>{rateUpdatedAt}</strong>
              </div>
              <div>
                <span>{tx('meta.dataUpdatedAt')}</span>
                <strong>{data?.summary?.updatedAt ?? '--'}</strong>
              </div>
            </div>
            {rateData?.status === 'warning' &&
            rateData?.source !== 'fallback' &&
            rateData?.source !== 'cache' &&
            rateData?.source !== 'loading' ? (
              <div className="warn-text">{tx('rate.fallbackWarn')}</div>
            ) : null}
          </div>

          <RealtimeOrdersPanel
            title={tx('orders.realtimeTitle')}
            marketRegion={selectedRegion}
            shopId={selectedShopId}
            orderFilter={orderFilter}
            timeRange={timeRange}
            customStart={customStart}
            customEnd={customEnd}
            baseCurrency={baseCurrency}
            targetCurrency={targetCurrency}
            seedOrders={
              data?.orders?.map((o) => ({
                id: o.id,
                orderId: o.id,
                shopName: o.shopName,
                shopId: o.shopId,
                region: o.region,
                orderStatus: o.orderStatus,
                orderAmountBase: o.orderAmountBase,
                orderAmountTarget: o.orderAmountTarget,
                currency: o.currency,
                orderTime: o.orderTime,
                usdAmount: (o as { usdAmount?: number }).usdAmount,
                isSample: o.isSample,
                isCancelled: o.isCancelled,
              })) ?? []
            }
            onMarketFilter={(m) => setSelectedRegion(m === 'ALL' ? 'all' : m)}
          />
          {orderFilter === 'unpaid' && String(data?.meta?.dataSource || '').toLowerCase() === 'tiktok_overview' ? (
            <div className="warn-text">{tx('warn.overviewUnpaid')}</div>
          ) : null}
        </section>

        <section className="col right-col right-column">
          <div className="right-col-filters-stack">
            <div className="tech-panel filter-panel filter-panel--stacked right-col-filter-block">
              <div className="filter-cluster-title">{tx('time.heading')}</div>
              <div className="filter-buttons time-filter">
                <button type="button" className={timeRange === 'today' ? 'active' : ''} onClick={() => setTimeRange('today')}>
                  {tx('time.today')}
                </button>
                <button
                  type="button"
                  className={timeRange === 'yesterday' ? 'active' : ''}
                  onClick={() => setTimeRange('yesterday')}
                >
                  {tx('time.yesterday')}
                </button>
                <button type="button" className={timeRange === 'last7' ? 'active' : ''} onClick={() => setTimeRange('last7')}>
                  {tx('time.last7')}
                </button>
                <button type="button" className={timeRange === 'last30' ? 'active' : ''} onClick={() => setTimeRange('last30')}>
                  {tx('time.last30')}
                </button>
                <button type="button" className={timeRange === 'custom' ? 'active' : ''} onClick={() => setTimeRange('custom')}>
                  {tx('time.custom')}
                </button>
              </div>
              {timeRange === 'custom' ? (
                <div className="custom-range-row date-range">
                  <label>
                    {tx('time.customStart')}
                    <input type="date" value={customStart} onChange={(e) => setCustomStart(e.target.value)} />
                  </label>
                  <label>
                    {tx('time.customEnd')}
                    <input type="date" value={customEnd} onChange={(e) => setCustomEnd(e.target.value)} />
                  </label>
                  <button type="button" className="refresh-btn" onClick={() => setCustomApplyNonce((n) => n + 1)}>
                    {tx('time.apply')}
                  </button>
                </div>
              ) : null}
            </div>
            <div className="tech-panel filter-panel filter-panel--stacked right-col-filter-block">
              <div className="filter-cluster-title">{tx('filter.order.heading')}</div>
              <div className="filter-buttons">
                <button type="button" className={orderFilter === 'all' ? 'active' : ''} onClick={() => setOrderFilter('all')}>
                  {tx('filter.order.all')}
                </button>
                <button type="button" className={orderFilter === 'valid' ? 'active' : ''} onClick={() => setOrderFilter('valid')}>
                  {tx('filter.order.valid')}
                </button>
                <button type="button" className={orderFilter === 'unpaid' ? 'active' : ''} onClick={() => setOrderFilter('unpaid')}>
                  {tx('filter.order.unpaid')}
                </button>
                <button type="button" className={orderFilter === 'sample' ? 'active' : ''} onClick={() => setOrderFilter('sample')}>
                  {tx('filter.order.sample')}
                </button>
                <button
                  type="button"
                  className={orderFilter === 'cancelled' ? 'active' : ''}
                  onClick={() => setOrderFilter('cancelled')}
                >
                  {tx('filter.order.cancelled')}
                </button>
              </div>
            </div>
          </div>
          <div className="tech-panel chart-panel chart-panel--tall chart-panel--responsive-chart">
            <GmvCompareTrendPanel
              market={selectedRegion}
              shopId={selectedShopId}
              status={orderFilter}
              hours={24}
              groupBy="hour"
              title={tx('chart.gmvTrendTitle')}
              baseCurrency={baseCurrency}
              targetCurrency={targetCurrency}
              range={gmvCompareQueryBounds.range}
              startDate={gmvCompareQueryBounds.startDate}
              endDate={gmvCompareQueryBounds.endDate}
            />
            {isOverviewSource && orderFilter === 'valid' ? (
              <div className="warn-text">{tx('warn.overviewValid')}</div>
            ) : null}
            {isOverviewSource && orderFilter === 'unpaid' ? (
              <div className="warn-text">{tx('warn.overviewUnpaidDetail')}</div>
            ) : null}
            {!isOverviewSource && !hasOrderStatusDimension ? (
              <div className="warn-text">{tx('warn.noOrderStatusDim')}</div>
            ) : null}
          </div>
          <div className="tech-panel chart-panel chart-panel--tall chart-panel--responsive-chart">
            <h3>
              {chartScopeSuffix
                ? tx('chart.titleWithScope', { title: tx('chart.ordersTrend'), scope: chartScopeSuffix })
                : tx('chart.ordersTrend')}
            </h3>
            <div ref={ordersChartRef} className="chart-canvas-wrap chart-canvas-wrap--responsive">
              <Suspense fallback={<div className="loading">{tx('chart.loading')}</div>}>
                <ReactECharts
                  key={`orders-echart-${ordersChartSize.w}x${ordersChartSize.h}`}
                  option={ordersOption}
                  style={{ height: '100%', width: '100%' }}
                  opts={{ renderer: 'canvas' }}
                />
              </Suspense>
            </div>
          </div>
        </section>
      </main>
    </div>
    </div>
  )
}
