import {
  Fragment,
  type CSSProperties,
  type FormEvent,
  useEffect,
  useMemo,
  useState,
} from 'react'
import { Link } from 'react-router-dom'
import { apiFetch } from './apiClient'
import { getAuthHeaders } from './authStorage'
import { previewImportCache, runImportCache, runOrdersReconcile } from './services/api/ops'
import { fetchShopsList, fetchShopsSummary } from './services/api/shops'
import { tiktokOAuthStartUrl } from './tiktokOAuth'
import { useT } from './i18n'
import {
  actionLabel,
  buildItemReconcileIssueLines,
  buildReconcileIssueLines,
  formatAuditResult,
  healthStatusLabel,
  resolveAuditShopName,
} from './i18n/shopMgmtLabels'

export type ShopMgmtPanelProps = {
  username: string
  variant: 'page' | 'modal'
  /** 全屏页由 SaasLayout 提供顶栏；不再使用 ShopMgmtShell */
  shellChrome?: boolean
  /** 服务端分页（/api/shops?page=&page_size=） */
  serverPagination?: boolean
  /** 页面模式：退出登录 */
  onLogout?: () => void
  /** 大屏抽屉：打开时默认健康筛选（如 abnormal） */
  initialHealthFilter?: string | null
  /** admin / super_admin 显示「刷新健康状态」 */
  canRefreshHealth?: boolean
  /** users.scope=platform 或 super_admin：全平台导入/刷新/统计 */
  hasPlatformScope?: boolean
  /** 仅 super_admin 可查看店铺操作日志（与 /api/operation-logs 一致） */
  canViewOperationLogs?: boolean
  /** 大屏抽屉：店铺变更成功后刷新 GMV + 排行（不传则不影响 /shops 独立页） */
  onDashboardRefresh?: (opts?: { force?: boolean }) => void | Promise<void>
  /** 由 ShopMgmtPage 绑定：顶栏「订单对账」触发 */
  onBindReconcile?: (api: { runReconcile: () => void }) => void
  reconcileLoading?: boolean
  onReconcileLoadingChange?: (loading: boolean) => void
}

type ReconcileMeta = {
  windowHours?: number
  diffCount?: number
  cutoffEpochSec?: number
  tenantId?: number
  platformMode?: boolean
  database?: string | null
  mysqlOrdersTableTotal?: number
  mysqlOrderItemsTableTotal?: number
  mysqlOrdersWindow?: number
  cacheOrdersWindow?: number
  scopeShops?: number
  timeField?: string
  itemCacheRows?: number
  itemMysqlRows?: number
  itemDiffCount?: number
  noItems?: number
}

type ReconcilePayload = {
  cacheOrders: number
  mysqlOrders: number
  missingInMysql: { platform: string; platform_order_id: string; shopId?: string | null }[]
  missingInCache: { platform: string; platform_order_id: string; mysqlAmount: number }[]
  duplicatedOrders: { platform: string; platform_order_id: string; count: number }[]
  mismatchAmountOrders: {
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
  summary?: { ok?: boolean; itemsOk?: boolean }
  meta?: ReconcileMeta
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

function normalizeReconcilePayload(raw: unknown): ReconcilePayload {
  const j = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const summaryObj = j.summary && typeof j.summary === 'object' ? (j.summary as Record<string, unknown>) : {}
  const metaRaw = j.meta && typeof j.meta === 'object' ? (j.meta as Record<string, unknown>) : {}
  return {
    cacheOrders: Number(j.cacheOrders) || 0,
    mysqlOrders: Number(j.mysqlOrders) || 0,
    missingInMysql: Array.isArray(j.missingInMysql) ? (j.missingInMysql as ReconcilePayload['missingInMysql']) : [],
    missingInCache: Array.isArray(j.missingInCache) ? (j.missingInCache as ReconcilePayload['missingInCache']) : [],
    duplicatedOrders: Array.isArray(j.duplicatedOrders) ? (j.duplicatedOrders as ReconcilePayload['duplicatedOrders']) : [],
    mismatchAmountOrders: Array.isArray(j.mismatchAmountOrders)
      ? (j.mismatchAmountOrders as ReconcilePayload['mismatchAmountOrders'])
      : [],
    mismatchStatusOrders: Array.isArray(j.mismatchStatusOrders)
      ? (j.mismatchStatusOrders as ReconcilePayload['mismatchStatusOrders'])
      : [],
    summary: {
      ok: summaryObj.ok === true,
      itemsOk: summaryObj.itemsOk === true,
    },
    meta: {
      windowHours: metaRaw.windowHours != null && Number.isFinite(Number(metaRaw.windowHours)) ? Number(metaRaw.windowHours) : 48,
      diffCount:
        metaRaw.diffCount != null && Number.isFinite(Number(metaRaw.diffCount)) ? Number(metaRaw.diffCount) : 0,
      cutoffEpochSec: metaRaw.cutoffEpochSec != null ? Number(metaRaw.cutoffEpochSec) : undefined,
      tenantId: metaRaw.tenantId != null ? Number(metaRaw.tenantId) : undefined,
      itemCacheRows:
        metaRaw.itemCacheRows != null && Number.isFinite(Number(metaRaw.itemCacheRows))
          ? Number(metaRaw.itemCacheRows)
          : 0,
      itemMysqlRows:
        metaRaw.itemMysqlRows != null && Number.isFinite(Number(metaRaw.itemMysqlRows))
          ? Number(metaRaw.itemMysqlRows)
          : 0,
      itemDiffCount:
        metaRaw.itemDiffCount != null && Number.isFinite(Number(metaRaw.itemDiffCount))
          ? Number(metaRaw.itemDiffCount)
          : 0,
      noItems: metaRaw.noItems != null && Number.isFinite(Number(metaRaw.noItems)) ? Number(metaRaw.noItems) : 0,
      platformMode: metaRaw.platformMode === true,
      database: metaRaw.database != null ? String(metaRaw.database) : null,
      mysqlOrdersTableTotal:
        metaRaw.mysqlOrdersTableTotal != null && Number.isFinite(Number(metaRaw.mysqlOrdersTableTotal))
          ? Number(metaRaw.mysqlOrdersTableTotal)
          : undefined,
      mysqlOrderItemsTableTotal:
        metaRaw.mysqlOrderItemsTableTotal != null && Number.isFinite(Number(metaRaw.mysqlOrderItemsTableTotal))
          ? Number(metaRaw.mysqlOrderItemsTableTotal)
          : undefined,
      scopeShops:
        metaRaw.scopeShops != null && Number.isFinite(Number(metaRaw.scopeShops))
          ? Number(metaRaw.scopeShops)
          : undefined,
      mysqlOrdersWindow:
        metaRaw.mysqlOrdersWindow != null && Number.isFinite(Number(metaRaw.mysqlOrdersWindow))
          ? Number(metaRaw.mysqlOrdersWindow)
          : undefined,
      cacheOrdersWindow:
        metaRaw.cacheOrdersWindow != null && Number.isFinite(Number(metaRaw.cacheOrdersWindow))
          ? Number(metaRaw.cacheOrdersWindow)
          : undefined,
      timeField: metaRaw.timeField != null ? String(metaRaw.timeField) : undefined,
    },
    itemMissingInMysql: Array.isArray(j.itemMissingInMysql)
      ? (j.itemMissingInMysql as ReconcilePayload['itemMissingInMysql'])
      : [],
    itemMissingInCache: Array.isArray(j.itemMissingInCache)
      ? (j.itemMissingInCache as ReconcilePayload['itemMissingInCache'])
      : [],
    itemMismatchQuantity: Array.isArray(j.itemMismatchQuantity)
      ? (j.itemMismatchQuantity as ReconcilePayload['itemMismatchQuantity'])
      : [],
    itemMismatchAmount: Array.isArray(j.itemMismatchAmount)
      ? (j.itemMismatchAmount as ReconcilePayload['itemMismatchAmount'])
      : [],
  }
}

type LogRow = {
  id: number
  user_id: number | null
  username: string | null
  action: string
  module: string
  target_type: string | null
  target_id: string | number | null
  detail_json: unknown
  created_at: string
}

type ShopRow = {
  id: number
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
  last_order_seen_at?: string | null
  last_order_count?: number
  last_gmv_amount?: number | string
  last_health_status?: string | null
  last_health_message?: string | null
  last_health_checked_at?: string | null
  last_sync_at?: string | null
  today_orders?: number
  today_gmv?: number | string
  latest_order_at?: string | null
  latest_sync_success_at?: string | null
  latest_sync_status?: string | null
  health_status?: string | null
  health_reason?: string | null
  health_debug?: Record<string, unknown>
}

function yn(v: number | boolean | undefined) {
  return v === true || v === 1
}

function rowMatchesHealthFilter(s: ShopRow, f: string): boolean {
  const h = String(s.health_status || s.last_health_status || 'unknown')
  const st = String(s.status || '').toLowerCase()
  const activeVisible = st === 'active' && !yn(s.hidden)
  const syncOffVisible = activeVisible && !yn(s.sync_enabled)

  if (f === 'all') return true
  if (f === 'normal') {
    if (syncOffVisible) return false
    return h === 'normal'
  }
  if (f === 'abnormal') {
    if (syncOffVisible) return false
    return (
      h === 'auth_error' ||
      h === 'permission_error' ||
      h === 'region_error' ||
      h === 'sync_stale' ||
      h === 'token_risk' ||
      h === 'unknown'
    )
  }
  if (f === 'no_orders_today') return h === 'no_orders_today' || (h === 'normal' && Number(s.last_order_count ?? 0) === 0)
  if (f === 'sync_stale') return h === 'sync_stale'
  if (f === 'sync_off') return syncOffVisible || h === 'sync_off'
  if (f === 'hidden') return h === 'hidden' || yn(s.hidden)
  if (f === 'disabled') return h === 'disabled' || st === 'disabled'
  return true
}

function healthPillStyle(status: string): CSSProperties {
  const base: CSSProperties = {
    display: 'inline-block',
    padding: '2px 8px',
    borderRadius: 999,
    fontSize: 11,
    fontWeight: 600,
    whiteSpace: 'nowrap',
  }
  switch (status) {
    case 'normal':
      return { ...base, background: 'rgba(52,168,124,0.2)', color: '#9ee6c8', border: '1px solid rgba(72,200,150,0.35)' }
    case 'no_orders_today':
      return { ...base, background: 'rgba(80,120,160,0.22)', color: '#b8d8f0', border: '1px solid rgba(100,150,200,0.35)' }
    case 'order_cache_pending':
      return { ...base, background: 'rgba(100,160,200,0.2)', color: '#b8e0ff', border: '1px solid rgba(120,180,220,0.4)' }
    case 'api_error':
      return { ...base, background: 'rgba(255,90,90,0.18)', color: '#ffaaaa', border: '1px solid rgba(255,120,100,0.4)' }
    case 'sync_stale':
      return { ...base, background: 'rgba(255,140,90,0.15)', color: '#ffb38a', border: '1px solid rgba(255,140,90,0.35)' }
    case 'sync_off':
      return { ...base, background: 'rgba(120,160,220,0.22)', color: '#b8d4ff', border: '1px solid rgba(100,150,220,0.4)' }
    case 'auth_error':
    case 'token_risk':
      return { ...base, background: 'rgba(255,90,120,0.18)', color: '#ffaac8', border: '1px solid rgba(255,90,120,0.4)' }
    case 'permission_error':
      return { ...base, background: 'rgba(255,120,80,0.18)', color: '#ffc4a8', border: '1px solid rgba(255,120,80,0.4)' }
    case 'region_error':
      return { ...base, background: 'rgba(180,120,255,0.18)', color: '#d4b8ff', border: '1px solid rgba(180,120,255,0.4)' }
    case 'disabled':
    case 'hidden':
      return { ...base, background: 'rgba(120,130,150,0.25)', color: '#c5cedd', border: '1px solid rgba(120,130,150,0.4)' }
    default:
      return { ...base, background: 'rgba(90,120,180,0.2)', color: '#a8c4e8', border: '1px solid rgba(90,120,180,0.35)' }
  }
}

/** 表格操作按钮 loading：仅 `${shop.id}:${action}` 匹配时显示「处理中」 */
type ShopRowAction = 'edit' | 'hide' | 'show' | 'disable' | 'enable' | 'sync_off' | 'sync_on' | 'delete'

function rowActionKey(id: number, action: ShopRowAction) {
  return `${id}:${action}`
}

function fmtOrderSeenAt(v: string | null | undefined) {
  if (v == null || v === '') return '—'
  return String(v).replace('T', ' ').slice(0, 19)
}

const SHOP_TABLE_PAGE_SIZE = 20

type ShopSummaryState = {
  totalAuthorized: number
  enabledCount: number
  todayOrderShopCount: number
  abnormalCount: number
  scope: 'platform' | 'tenant'
  max_shops: number | null
  perTenantDefaultMaxShops?: number
  currentShops?: number
}

export function ShopMgmtPanel({
  username,
  variant,
  shellChrome = false,
  serverPagination = false,
  onLogout,
  onDashboardRefresh,
  initialHealthFilter,
  canRefreshHealth = false,
  hasPlatformScope = false,
  canViewOperationLogs = false,
  onBindReconcile,
  onReconcileLoadingChange,
}: ShopMgmtPanelProps) {
  const t = useT()
  const isModal = variant === 'modal'

  const logHeaders = useMemo(
    () => [
      t('shopMgmt.logColTime'),
      t('shopMgmt.logColUser'),
      t('shopMgmt.logColAction'),
      t('shopMgmt.logColShop'),
      t('shopMgmt.logColResult'),
      t('shopMgmt.logColDetail'),
    ],
    [t],
  )
  const [subView, setSubView] = useState<'shops' | 'logs'>('shops')
  const [shops, setShops] = useState<ShopRow[]>([])
  const [shopSummary, setShopSummary] = useState<ShopSummaryState>({
    totalAuthorized: 0,
    enabledCount: 0,
    todayOrderShopCount: 0,
    abnormalCount: 0,
    scope: 'tenant',
    max_shops: 20,
  })
  const [importTenantId, setImportTenantId] = useState('')
  const isPlatformScope = hasPlatformScope || shopSummary.scope === 'platform'
  /** Ops API（对账 / import-cache）仅平台管理员；与后端 requirePlatformOps 一致 */
  const canUseOpsApi = isPlatformScope
  const [searchQuery, setSearchQuery] = useState('')
  const [marketFilter, setMarketFilter] = useState('all')
  const [syncFilter, setSyncFilter] = useState('all')
  const [tablePage, setTablePage] = useState(1)
  const [serverTotal, setServerTotal] = useState(0)

  const [msg, setMsg] = useState('')
  const [loading, setLoading] = useState(true)
  const [healthRowFilter, setHealthRowFilter] = useState<string>(() => initialHealthFilter || 'all')
  const [healthRefreshing, setHealthRefreshing] = useState(false)
  const [preview, setPreview] = useState<{ count: number; items: unknown[] } | null>(null)
  const [editing, setEditing] = useState<ShopRow | null>(null)
  const [editForm, setEditForm] = useState({
    display_name: '',
    shop_name: '',
    market: '',
    sort_order: 0,
    remarks: '',
  })
  const [logPage, setLogPage] = useState(1)
  const [logTotal, setLogTotal] = useState(0)
  const [logItems, setLogItems] = useState<LogRow[]>([])
  const [logLoading, setLogLoading] = useState(false)
  const [logMsg, setLogMsg] = useState('')
  const [detailOpenLogId, setDetailOpenLogId] = useState<number | null>(null)

  useEffect(() => {
    if (subView === 'logs' && !canViewOperationLogs) {
      setSubView('shops')
      setLogMsg('')
      setDetailOpenLogId(null)
    }
  }, [subView, canViewOperationLogs])

  const [reconcileOpen, setReconcileOpen] = useState(false)
  const [reconcileLoading, setReconcileLoading] = useState(false)
  const [reconcileData, setReconcileData] = useState<ReconcilePayload | null>(null)
  const [reconcileErr, setReconcileErr] = useState('')

  /** 当前进行中的店铺操作键，形如 `12:sync_off`；同行其他按钮仅 disabled，不改变文案 */
  const [actionLoadingKey, setActionLoadingKey] = useState<string | null>(null)

  function tryBeginRowAction(id: number, action: ShopRowAction): boolean {
    const prefix = `${id}:`
    if (actionLoadingKey != null && actionLoadingKey.startsWith(prefix)) {
      setMsg(t('shopMgmt.shopBusy'))
      return false
    }
    setActionLoadingKey(rowActionKey(id, action))
    return true
  }

  function endRowAction(id: number, action: ShopRowAction) {
    const k = rowActionKey(id, action)
    setActionLoadingKey((cur) => (cur === k ? null : cur))
  }

  /** 同步列：仅读 sync_enabled，与健康、隐藏无关 */
  function displaySyncCell(s: ShopRow) {
    return yn(s.sync_enabled) ? t('common.on') : t('common.off')
  }

  /** 健康列：优先 API 返回的 health_status / health_reason */
  function healthDisplayForRow(s: ShopRow): { key: string; label: string; title?: string } {
    const st = String(s.status || '').toLowerCase()
    const reason = String(s.health_reason || s.last_health_message || '').trim()
    const rule = String((s as ShopRow & { health_rule?: string }).health_rule || '').trim()
    const title = [reason, rule ? `[${rule}]` : ''].filter(Boolean).join(' ')
    if (st === 'disabled') return { key: 'disabled', label: healthStatusLabel(t, 'disabled'), title }
    if (yn(s.hidden)) return { key: 'hidden', label: healthStatusLabel(t, 'hidden'), title }
    if (!yn(s.sync_enabled)) return { key: 'sync_off', label: t('shopMgmt.syncOffLabel'), title }
    const h = String(s.health_status || s.last_health_status || 'unknown')
    return { key: h, label: healthStatusLabel(t, h), title: title || undefined }
  }

  async function runReconcile() {
    if (!canUseOpsApi) return
    setReconcileErr('')
    setReconcileData(null)
    setReconcileOpen(true)
    setReconcileLoading(true)
    onReconcileLoadingChange?.(true)
    try {
      const raw = await runOrdersReconcile()
      setReconcileData(normalizeReconcilePayload(raw))
    } catch (e) {
      setReconcileData(null)
      setReconcileErr(e instanceof Error ? e.message : '对账失败')
    } finally {
      setReconcileLoading(false)
      onReconcileLoadingChange?.(false)
    }
  }

  useEffect(() => {
    if (!canUseOpsApi) return
    onBindReconcile?.({ runReconcile: () => void runReconcile() })
  }, [onBindReconcile, canUseOpsApi])

  async function refresh(opts?: { silent?: boolean }) {
    const silent = opts?.silent === true
    if (!silent) setLoading(true)
    try {
      const summaryRes = await fetchShopsSummary()
      let list: ShopRow[] = []
      if (serverPagination) {
        const q: Record<string, string | number> = {
          page: tablePage,
          page_size: SHOP_TABLE_PAGE_SIZE,
        }
        if (searchQuery.trim()) q.keyword = searchQuery.trim()
        if (marketFilter !== 'all') q.region = marketFilter
        const j = await fetchShopsList(q)
        list = (j.list || j.shops || []) as ShopRow[]
        setServerTotal(Number(j.total) || 0)
      } else {
        const headers = { ...getAuthHeaders() }
        const shopsRes = await apiFetch('/api/shops', { headers, cache: 'no-store' })
        const j = await shopsRes.json()
        if (!shopsRes.ok) throw new Error(j.error || 'load_failed')
        list = Array.isArray(j.shops) ? j.shops : []
        setServerTotal(list.length)
      }
      setShops(list)
      const dbgAll = list
        .map((s: ShopRow) => (s as ShopRow & { health_debug?: Record<string, unknown> }).health_debug)
        .filter(Boolean)
      const named = dbgAll.filter((d: Record<string, unknown> | undefined) =>
        Boolean(
          d &&
            (/cq\s*chic|a&b|cavera/i.test(String((d as { shop_name?: string }).shop_name || '')) ||
              String((d as { platform_shop_id?: string }).platform_shop_id || '') ===
                '8646969730649196387'),
        ),
      )
      if (named.length) console.info('[shop-health-debug-named]', named)
      else if (dbgAll.length) console.info('[shop-health-debug]', dbgAll.slice(0, 5))
      const scope = summaryRes.scope === 'platform' ? 'platform' : 'tenant'
      setShopSummary({
        totalAuthorized: Number(summaryRes.totalAuthorized ?? 0),
        enabledCount: Number(summaryRes.enabledCount ?? 0),
        todayOrderShopCount: Number(summaryRes.todayOrderShopCount ?? 0),
        abnormalCount: Number(summaryRes.abnormalCount ?? 0),
        scope,
        max_shops: scope === 'platform' ? null : Number(summaryRes.max_shops ?? 20) || 20,
        perTenantDefaultMaxShops:
          scope === 'platform' ? Number(summaryRes.perTenantDefaultMaxShops ?? 20) || 20 : undefined,
        currentShops:
          summaryRes.currentShops != null
            ? Number(summaryRes.currentShops)
            : Number(summaryRes.totalAuthorized ?? 0),
      })
      setMsg('')
    } catch {
      setMsg(t('shopMgmt.loadFailed'))
    } finally {
      if (!silent) setLoading(false)
    }
  }

  useEffect(() => {
    void refresh()
  }, [])

  useEffect(() => {
    if (!serverPagination) return
    void refresh({ silent: true })
  }, [tablePage, searchQuery, marketFilter, serverPagination])

  useEffect(() => {
    if (initialHealthFilter === undefined) return
    setHealthRowFilter(initialHealthFilter || 'all')
  }, [initialHealthFilter])

  /** 弹窗打开时禁止 body 横向/纵向滚动，避免页面级滚动条与穿透 */
  useEffect(() => {
    const locked = reconcileOpen || editing != null
    if (!locked) return
    const prevOverflow = document.body.style.overflow
    const prevOverflowX = document.body.style.overflowX
    document.body.style.overflow = 'hidden'
    document.body.style.overflowX = 'hidden'
    return () => {
      document.body.style.overflow = prevOverflow
      document.body.style.overflowX = prevOverflowX
    }
  }, [reconcileOpen, editing])

  const marketOptions = useMemo(() => {
    const set = new Set<string>()
    for (const s of shops) {
      const m = String(s.market || s.region || '').trim().toUpperCase()
      if (m) set.add(m)
    }
    return [...set].sort()
  }, [shops])

  const filteredShops = useMemo(() => {
    const q = searchQuery.trim().toLowerCase()
    return shops.filter((s) => {
      if (!rowMatchesHealthFilter(s, healthRowFilter)) return false
      if (marketFilter !== 'all') {
        const m = String(s.market || s.region || '').trim().toUpperCase()
        if (m !== marketFilter) return false
      }
      if (syncFilter === 'on' && !yn(s.sync_enabled)) return false
      if (syncFilter === 'off' && yn(s.sync_enabled)) return false
      if (q) {
        const name = String(s.display_name || s.shop_name || '').toLowerCase()
        const pid = String(s.platform_shop_id || '').toLowerCase()
        if (!name.includes(q) && !pid.includes(q)) return false
      }
      return true
    })
  }, [shops, healthRowFilter, marketFilter, syncFilter, searchQuery])

  const tableTotalPages = serverPagination
    ? Math.max(1, Math.ceil(serverTotal / SHOP_TABLE_PAGE_SIZE))
    : Math.max(1, Math.ceil(filteredShops.length / SHOP_TABLE_PAGE_SIZE))

  const pagedShops = useMemo(() => {
    if (serverPagination) {
      return shops.filter((s) => {
        if (!rowMatchesHealthFilter(s, healthRowFilter)) return false
        if (syncFilter === 'on' && !yn(s.sync_enabled)) return false
        if (syncFilter === 'off' && yn(s.sync_enabled)) return false
        return true
      })
    }
    const start = (tablePage - 1) * SHOP_TABLE_PAGE_SIZE
    return filteredShops.slice(start, start + SHOP_TABLE_PAGE_SIZE)
  }, [filteredShops, tablePage, serverPagination, shops, healthRowFilter, syncFilter])

  useEffect(() => {
    setTablePage(1)
  }, [healthRowFilter, marketFilter, syncFilter, searchQuery])

  useEffect(() => {
    if (tablePage > tableTotalPages) setTablePage(tableTotalPages)
  }, [tablePage, tableTotalPages])

  /** 静默 POST 健康扫描（不写操作提示；失败仅 console.warn） */
  async function refreshHealthSilent(): Promise<boolean> {
    if (!canRefreshHealth) return true
    try {
      const r = await apiFetch('/api/shops/health/refresh', {
        method: 'POST',
        headers: { ...getAuthHeaders() },
        cache: 'no-store',
      })
      if (!r.ok) {
        console.warn('[shop-health] POST /api/shops/health/refresh failed', r.status)
        return false
      }
      return true
    } catch (e) {
      console.warn('[shop-health] refresh error', e)
      return false
    }
  }

  async function refreshHealthFromCache(opts?: { scope?: 'all' }) {
    if (!canRefreshHealth) return
    setHealthRefreshing(true)
    setMsg('')
    try {
      const qs = opts?.scope === 'all' ? '?scope=all' : ''
      const r = await apiFetch(`/api/shops/health/refresh${qs}`, {
        method: 'POST',
        headers: { ...getAuthHeaders() },
        cache: 'no-store',
      })
      const j = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(String(j.error || 'refresh_failed'))
      await refresh({ silent: true })
      if (j.scope === 'all') {
        setMsg(
          t('shopMgmt.refreshAllDone', {
            checked: j.checked ?? 0,
            abnormal: j.abnormal ?? 0,
          }),
        )
      } else {
        setMsg(t('shopMgmt.healthScanDone', { checked: j.checked ?? 0, abnormal: j.abnormal ?? 0 }))
      }
      if (onDashboardRefresh) await Promise.resolve(onDashboardRefresh({ force: true }))
    } catch {
      setMsg(t('shopMgmt.healthScanFailed'))
    } finally {
      setHealthRefreshing(false)
    }
  }

  /**
   * 影响大屏统计的操作成功后：拉列表 → 健康重算 → 再拉列表（含 health 字段）→ 强刷大屏。
   * 不使用乐观更新作为最终态；中间刷新使用 silent，避免整表 loading 闪烁。
   */
  async function afterDashboardAffectingMutation() {
    await refresh({ silent: true })
    await refreshHealthSilent()
    await refresh({ silent: true })
    if (onDashboardRefresh) await Promise.resolve(onDashboardRefresh({ force: true }))
  }

  async function loadLogs(page: number) {
    if (!canViewOperationLogs) {
      setLogMsg(t('shopMgmt.logsSuperAdminOnly'))
      return
    }
    setDetailOpenLogId(null)
    setLogLoading(true)
    setLogMsg('')
    try {
      const p = Math.max(1, page)
      const r = await apiFetch(`/api/operation-logs?page=${p}&pageSize=20&module=shops`, { headers: { ...getAuthHeaders() } })
      const j = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(String(j.error || '日志加载失败'))
      setLogPage(Number(j.page) || p)
      setLogTotal(Number(j.total) || 0)
      setLogItems(Array.isArray(j.items) ? (j.items as LogRow[]) : [])
    } catch (e) {
      setLogMsg(e instanceof Error ? e.message : '日志加载失败')
    } finally {
      setLogLoading(false)
    }
  }

  async function loadPreview() {
    if (!canUseOpsApi) return
    setMsg('')
    try {
      const j = await previewImportCache()
      setPreview({ count: j.count ?? 0, items: Array.isArray(j.items) ? j.items : [] })
    } catch {
      setMsg('预览失败')
    }
  }

  async function runImport(opts?: { scope?: 'all'; tenantId?: string }) {
    if (!canUseOpsApi) return
    setMsg('')
    try {
      const j = await runImportCache({
        scope: opts?.scope,
        tenantId: opts?.tenantId,
      })
      setPreview(null)
      await afterDashboardAffectingMutation()
      let importMsg: string
      if (j.scope === 'all') {
        const tenantCount = Array.isArray(j.tenants) ? j.tenants.length : 0
        importMsg = t('shopMgmt.importAllDone', {
          tenantCount,
          inserted: j.inserted ?? 0,
          updated: j.updated ?? 0,
          skipped: j.skipped ?? 0,
        })
      } else {
        importMsg = t('shopMgmt.importDone', {
          inserted: j.inserted ?? 0,
          updated: j.updated ?? 0,
          skipped: j.skipped ?? 0,
          scanned: j.scanned ?? 0,
        })
      }
      const skippedMax = Number(j.skipped_max_shops ?? 0)
      if (skippedMax > 0) {
        importMsg += ` · ${t('shopMgmt.importSkippedMax', { n: skippedMax })}`
      }
      setMsg(importMsg)
    } catch {
      setMsg(t('shopMgmt.importRequestFailed'))
    }
  }

  async function patchShop(id: number, body: Record<string, unknown>, action: ShopRowAction): Promise<boolean> {
    if (!tryBeginRowAction(id, action)) {
      return false
    }
    try {
      const r = await apiFetch(`/api/shops/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
        body: JSON.stringify(body),
        cache: 'no-store',
      })
      const j = await r.json().catch(() => ({}))
      if (!r.ok) {
        setMsg(String(j.error || j.message || '操作失败'))
        return false
      }
      if (!j.shop || typeof j.shop !== 'object') {
        console.warn('[shops] PATCH ok but response missing shop payload; relying on list refresh')
      }
      setMsg('')
      await afterDashboardAffectingMutation()
      return true
    } finally {
      endRowAction(id, action)
    }
  }

  async function setStatus(id: number, status: string, action: 'disable' | 'enable'): Promise<boolean> {
    if (!tryBeginRowAction(id, action)) {
      return false
    }
    try {
      const r = await apiFetch(`/api/shops/${id}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
        body: JSON.stringify({ status }),
        cache: 'no-store',
      })
      const j = await r.json().catch(() => ({}))
      if (!r.ok) {
        setMsg(String(j.error || j.message || '状态更新失败'))
        return false
      }
      if (!j.shop || typeof j.shop !== 'object') {
        console.warn('[shops] status PATCH ok but response missing shop payload; relying on list refresh')
      }
      await afterDashboardAffectingMutation()
      return true
    } finally {
      endRowAction(id, action)
    }
  }

  async function removeShop(id: number) {
    if (!confirm(t('shopMgmt.confirmDelete'))) return
    const action: ShopRowAction = 'delete'
    if (!tryBeginRowAction(id, action)) {
      return
    }
    try {
      const r = await apiFetch(`/api/shops/${id}`, {
        method: 'DELETE',
        headers: { ...getAuthHeaders() },
        cache: 'no-store',
      })
      const j = await r.json().catch(() => ({}))
      if (!r.ok) {
        setMsg(String(j.error || j.message || '删除失败'))
        return
      }
      if (!j.shop || typeof j.shop !== 'object') {
        console.warn('[shops] DELETE ok but response missing shop payload; relying on list refresh')
      }
      await afterDashboardAffectingMutation()
    } finally {
      endRowAction(id, action)
    }
  }

  function openEdit(s: ShopRow) {
    setEditing(s)
    setEditForm({
      display_name: s.display_name || '',
      shop_name: s.shop_name || '',
      market: s.market || '',
      sort_order: Number(s.sort_order) || 0,
      remarks: s.remarks || '',
    })
  }

  async function saveEdit(e: FormEvent) {
    e.preventDefault()
    if (!editing) return
    const ok = await patchShop(
      editing.id,
      {
        display_name: editForm.display_name.trim() || null,
        shop_name: editForm.shop_name.trim(),
        market: editForm.market.trim() || null,
        sort_order: Number(editForm.sort_order) || 0,
        remarks: editForm.remarks.trim() || null,
      },
      'edit',
    )
    if (ok) setEditing(null)
  }

  function formatDetailJsonForPanel(d: unknown): string {
    if (d == null || d === '') return '（无附加数据）'
    if (typeof d === 'string') {
      const t = d.trim()
      if (!t) return '（无附加数据）'
      try {
        const parsed = JSON.parse(t) as unknown
        return JSON.stringify(parsed, null, 2)
      } catch {
        return d
      }
    }
    try {
      return JSON.stringify(d, null, 2)
    } catch {
      return String(d)
    }
  }

  function parseLogDetail(d: unknown): Record<string, unknown> | null {
    if (d == null || d === '') return null
    if (typeof d === 'string') {
      const t = d.trim()
      if (!t) return null
      try {
        const o = JSON.parse(t) as unknown
        return typeof o === 'object' && o !== null && !Array.isArray(o) ? (o as Record<string, unknown>) : null
      } catch {
        return null
      }
    }
    if (typeof d === 'object' && !Array.isArray(d)) return d as Record<string, unknown>
    return null
  }

  function logHasDetailPayload(d: unknown): boolean {
    if (d == null) return false
    if (typeof d === 'string') return d.trim().length > 0
    if (typeof d === 'object') return Object.keys(d as object).length > 0
    return true
  }

  const blockMax = isModal ? '100%' : 900
  const tableScroll: CSSProperties = {
    width: '100%',
    maxWidth: '100%',
    minWidth: 0,
    overflowX: 'hidden',
    border: '1px solid rgba(90, 180, 255, 0.22)',
    borderRadius: 12,
    boxShadow: 'inset 0 0 0 1px rgba(12, 40, 80, 0.35)',
  }

  const editZ = isModal ? 2600 : 50
  const reconcileZ = isModal ? 2680 : 70

  const reconcileReady = reconcileData != null && !reconcileLoading && !reconcileErr
  /** 完全以后端 summary.ok 为准，仅严格等于 true 视为健康 */
  const reconcileHealthy = reconcileReady && reconcileData.summary?.ok === true
  const reconcileDiffTotal = reconcileReady ? reconcileData.meta?.diffCount ?? 0 : 0
  const reconcileIssueLines = reconcileReady ? buildReconcileIssueLines(t, reconcileData, 20) : []
  const reconcileItemDiffTotal = reconcileReady ? reconcileData.meta?.itemDiffCount ?? 0 : 0
  const reconcileItemsHealthy = reconcileReady && reconcileData.summary?.itemsOk === true
  const reconcileItemIssueLines = reconcileReady ? buildItemReconcileIssueLines(t, reconcileData, 20) : []

  return (
    <div
      className={shellChrome ? 'shop-mgmt-panel shop-mgmt-panel--shell shops-page' : 'shop-mgmt-panel shops-page'}
      style={{
        color: '#e8f0ff',
        fontFamily: 'system-ui, sans-serif',
        width: '100%',
        maxWidth: '100%',
        minWidth: 0,
        overflow: 'visible',
      }}
    >
      {!isModal && !shellChrome ? (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20, flexWrap: 'wrap', gap: 12 }}>
          <div>
            <Link to="/" style={{ color: '#7ecbff', marginRight: 16 }}>
              ← {t('btn.backDashboard')}
            </Link>
            <strong>{t('shopMgmt.pageTitle')}</strong>
            <span style={{ marginLeft: 12, opacity: 0.8 }}>{username}</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            {subView === 'shops' ? (
              <>
                {canUseOpsApi ? (
                  <button type="button" style={btn} disabled={reconcileLoading} onClick={() => void runReconcile()}>
                    {reconcileLoading ? t('shopMgmt.reconciling') : t('shopMgmt.reconcileBtn')}
                  </button>
                ) : null}
                {canViewOperationLogs ? (
                  <button type="button" style={btn} onClick={() => { setSubView('logs'); void loadLogs(1) }}>
                    {t('shopMgmt.auditLogs')}
                  </button>
                ) : null}
              </>
            ) : (
              <>
                <button type="button" style={btn} onClick={() => { setSubView('shops'); setLogMsg(''); setDetailOpenLogId(null) }}>
                  {t('shopMgmt.backToShops')}
                </button>
                {canViewOperationLogs ? (
                  <button type="button" style={btn} onClick={() => void loadLogs(logPage)}>
                    {t('shopMgmt.refreshLogs')}
                  </button>
                ) : null}
              </>
            )}
            {onLogout ? (
              <button
                type="button"
                onClick={onLogout}
                style={{ padding: '8px 14px', borderRadius: 8, border: '1px solid #355a88', background: 'transparent', color: '#fff', cursor: 'pointer' }}
              >
                {t('btn.logout')}
              </button>
            ) : null}
          </div>
        </div>
      ) : isModal ? (
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            flexWrap: 'wrap',
            gap: 10,
            marginBottom: 16,
            fontSize: 13,
          }}
        >
          <div style={{ opacity: 0.85 }}>
            {t('shopMgmt.loggedIn')}<strong style={{ color: '#b8e0ff' }}>{username}</strong>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {subView === 'shops' ? (
              <>
                {canUseOpsApi ? (
                  <button type="button" style={btn} disabled={reconcileLoading} onClick={() => void runReconcile()}>
                    {reconcileLoading ? t('shopMgmt.reconciling') : t('shopMgmt.reconcileBtn')}
                  </button>
                ) : null}
                {canViewOperationLogs ? (
                  <button type="button" style={btn} onClick={() => { setSubView('logs'); void loadLogs(1) }}>
                    {t('shopMgmt.auditLogs')}
                  </button>
                ) : null}
              </>
            ) : (
              <>
                <button type="button" style={btn} onClick={() => { setSubView('shops'); setLogMsg(''); setDetailOpenLogId(null) }}>
                  {t('shopMgmt.backToShops')}
                </button>
                {canViewOperationLogs ? (
                  <button type="button" style={btn} onClick={() => void loadLogs(logPage)}>
                    {t('shopMgmt.refreshLogs')}
                  </button>
                ) : null}
              </>
            )}
          </div>
        </div>
      ) : null}

      {subView === 'logs' ? (
        <div key="logs" className="shop-panel-view shop-panel-view--logs" style={{ maxWidth: blockMax }}>
          {shellChrome ? (
            <div style={{ marginBottom: 12 }}>
              <button
                type="button"
                className="shop-mgmt-btn"
                style={btn}
                onClick={() => {
                  setSubView('shops')
                  setLogMsg('')
                  setDetailOpenLogId(null)
                }}
              >
                {t('shopMgmt.backToShops')}
              </button>
            </div>
          ) : null}
          <div style={{ marginBottom: 4 }}>
            <div style={{ fontWeight: 700, fontSize: 16, color: '#e8f4ff', letterSpacing: 0.3 }}>{t('shopMgmt.auditTitle')}</div>
            <div style={{ fontSize: 12, color: '#8aa4c8', marginTop: 4 }}>{t('shopMgmt.auditSubtitle')}</div>
          </div>
          {logMsg ? <div style={{ color: '#ffcc80', marginBottom: 12 }}>{logMsg}</div> : null}
          {logLoading ? <div style={{ color: '#8fb8e8', marginBottom: 12 }}>{t('common.loading')}</div> : null}
          <div style={{ ...tableScroll, background: 'linear-gradient(180deg, rgba(14,28,48,0.55) 0%, rgba(8,18,32,0.4) 100%)' }}>
            <table style={{ width: '100%', tableLayout: 'fixed', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ background: 'linear-gradient(90deg, #152a45 0%, #1a3352 100%)' }}>
                  {logHeaders.map((h, i) => (
                    <th
                      key={h}
                      style={{
                        textAlign: i === logHeaders.length - 1 ? 'right' : 'left',
                        padding: '10px 12px',
                        whiteSpace: 'nowrap',
                        color: '#b8dcff',
                        fontWeight: 600,
                        fontSize: 12,
                        borderBottom: '1px solid rgba(90, 160, 255, 0.2)',
                      }}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {logItems.length === 0 && !logLoading ? (
                  <tr>
                    <td colSpan={6} style={{ ...td, color: '#8fb8e8', padding: '20px 12px' }}>
                      {t('shopMgmt.logEmpty')}
                    </td>
                  </tr>
                ) : null}
                {logItems.map((row) => {
                  const detail = parseLogDetail(row.detail_json)
                  const shopCol = resolveAuditShopName(t, row, detail, shops)
                  const opLabel = actionLabel(t, String(row.action || ''))
                  const resultText = formatAuditResult(t, row, detail)
                  const hasDetail = logHasDetailPayload(row.detail_json)
                  const jsonStr = formatDetailJsonForPanel(row.detail_json)
                  const detailOpen = detailOpenLogId === row.id
                  return (
                    <Fragment key={row.id}>
                      <tr style={{ borderTop: '1px solid rgba(26, 42, 65, 0.9)' }}>
                        <td style={{ ...td, padding: '10px 12px', color: '#c5daf5' }}>
                          {row.created_at ? String(row.created_at).replace('T', ' ').slice(0, 19) : '—'}
                        </td>
                        <td style={{ ...td, padding: '10px 12px', color: '#dfe9ff' }}>
                          {row.username ||
                            (row.user_id != null ? t('shopMgmt.logUserId', { id: row.user_id }) : t('common.dash'))}
                        </td>
                        <td style={{ ...td, padding: '10px 12px', fontWeight: 500, color: '#e8f4ff' }}>{opLabel}</td>
                        <td style={{ ...td, padding: '10px 12px', maxWidth: 220, wordBreak: 'break-word', color: '#b8e0ff' }}>
                          {shopCol}
                        </td>
                        <td style={{ ...td, padding: '10px 12px', maxWidth: 320 }}>
                          <span
                            style={{
                              display: 'inline-block',
                              padding: '4px 10px',
                              borderRadius: 999,
                              background: 'rgba(52, 168, 124, 0.18)',
                              border: '1px solid rgba(72, 200, 150, 0.35)',
                              color: '#9ee6c8',
                              fontSize: 12,
                              lineHeight: 1.45,
                            }}
                          >
                            {resultText}
                          </span>
                        </td>
                        <td style={{ ...td, padding: '10px 12px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                          {hasDetail ? (
                            <button
                              type="button"
                              style={detailOpen ? { ...btn, borderColor: 'rgba(120, 190, 255, 0.75)', background: 'rgba(30, 70, 120, 0.5)' } : btn}
                              onClick={() => setDetailOpenLogId((id) => (id === row.id ? null : row.id))}
                            >
                              {detailOpen ? t('shopMgmt.logCollapseDetail') : t('shopMgmt.logDetailBtn')}
                            </button>
                          ) : (
                            <span style={{ fontSize: 12, color: '#5a7399' }}>—</span>
                          )}
                        </td>
                      </tr>
                      {detailOpen ? (
                        <tr style={{ background: 'rgba(6, 14, 28, 0.65)' }}>
                          <td colSpan={6} style={{ padding: '0 12px 14px', borderTop: 'none' }}>
                            <div style={{ fontSize: 11, color: '#7a9cc4', marginBottom: 8, paddingTop: 4 }}>{t('shopMgmt.logDetailJson')}</div>
                            <pre
                              style={{
                                margin: 0,
                                padding: 12,
                                borderRadius: 8,
                                border: '1px solid rgba(60, 100, 150, 0.35)',
                                background: 'rgba(4, 10, 22, 0.85)',
                                whiteSpace: 'pre-wrap',
                                wordBreak: 'break-word',
                                fontSize: 11,
                                color: '#a8c4e8',
                                maxHeight: 280,
                                overflow: 'auto',
                                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
                              }}
                            >
                              {jsonStr}
                            </pre>
                          </td>
                        </tr>
                      ) : null}
                    </Fragment>
                  )
                })}
              </tbody>
            </table>
          </div>
          <div style={{ display: 'flex', gap: 12, marginTop: 16, alignItems: 'center', flexWrap: 'wrap' }}>
            <button type="button" style={btn} disabled={logPage <= 1 || logLoading} onClick={() => void loadLogs(logPage - 1)}>
              {t('analytics.pagerPrev')}
            </button>
            <span style={{ opacity: 0.85, fontSize: 13 }}>
              {t('shopMgmt.logPager', { page: logPage, total: logTotal })}
            </span>
            <button
              type="button"
              style={btn}
              disabled={logLoading || logPage * 20 >= logTotal || logTotal === 0}
              onClick={() => void loadLogs(logPage + 1)}
            >
              {t('analytics.pagerNext')}
            </button>
          </div>
        </div>
      ) : (
        <div key="shops" className="shop-panel-view shop-panel-view--shops">
      {!isModal && !shellChrome ? (
        <header className="shop-mgmt-page-header">
          <h1 className="shop-mgmt-page-title">{t('shopMgmt.drawerTitle')}</h1>
          <p className="shop-mgmt-page-subtitle">{t('shopMgmt.pageSubtitle')}</p>
        </header>
      ) : null}

      <section className="shop-mgmt-stats" aria-label={t('shopMgmt.drawerTitle')}>
        <div className="shop-mgmt-stat-card">
          <div className="shop-mgmt-stat-label">{isPlatformScope ? t('shopMgmt.platformTotal') : t('shopMgmt.tenantAuthorizedQuota')}</div>
          <div className="shop-mgmt-stat-value">
            {isPlatformScope
              ? t('shopMgmt.platformUnlimited', { n: shopSummary.totalAuthorized })
              : t('shopMgmt.quotaUsed', {
                  current: shopSummary.totalAuthorized,
                  max: shopSummary.max_shops ?? 20,
                })}
          </div>
        </div>
        {isPlatformScope ? null : (
        <div className="shop-mgmt-stat-card">
          <div className="shop-mgmt-stat-label">{t('shopMgmt.statEnabled')}</div>
          <div className="shop-mgmt-stat-value">{shopSummary.enabledCount}</div>
        </div>
        )}
        <div className="shop-mgmt-stat-card">
          <div className="shop-mgmt-stat-label">{t('shopMgmt.statTodayOrders')}</div>
          <div className="shop-mgmt-stat-value">{shopSummary.todayOrderShopCount}</div>
        </div>
        <div className="shop-mgmt-stat-card">
          <div className="shop-mgmt-stat-label">{t('shopMgmt.statAbnormal')}</div>
          <div className="shop-mgmt-stat-value">{shopSummary.abnormalCount}</div>
        </div>
        {isPlatformScope ? (
          <div className="shop-mgmt-stat-card">
            <div className="shop-mgmt-stat-label">
              {t('shopMgmt.perTenantMaxHint', { n: shopSummary.perTenantDefaultMaxShops ?? 20 })}
            </div>
            <div className="shop-mgmt-stat-value shop-mgmt-stat-value--muted" style={{ fontSize: 13 }}>
              {t('shopMgmt.statEnabled')}: {shopSummary.enabledCount}
            </div>
          </div>
        ) : null}
      </section>

      <div className="shop-mgmt-primary-actions">
        <button
          type="button"
          className="shop-mgmt-btn shop-mgmt-btn--oauth"
          style={btnPrimary}
          onClick={() => {
            window.location.href = tiktokOAuthStartUrl()
          }}
        >
          {t('shopMgmt.authorizeShop')}
        </button>
        {canUseOpsApi ? (
          <button type="button" className="shop-mgmt-btn" style={btnPrimary} onClick={() => void runImport()}>
            {t('shopMgmt.runImportBtn')}
          </button>
        ) : null}
        {canRefreshHealth ? (
          <button
            type="button"
            className="shop-mgmt-btn"
            style={btnPrimary}
            disabled={healthRefreshing}
            onClick={() => void refreshHealthFromCache()}
          >
            {healthRefreshing ? t('shopMgmt.scanning') : t('shopMgmt.refreshHealth')}
          </button>
        ) : null}
        {isPlatformScope ? (
          <div className="shop-mgmt-platform-actions">
            <input
              type="number"
              min={1}
              className="shop-mgmt-search shop-mgmt-tenant-id-input"
              style={{ ...inp, width: 100, minWidth: 100 }}
              placeholder={t('shopMgmt.importTenantLabel')}
              value={importTenantId}
              onChange={(e) => setImportTenantId(e.target.value)}
            />
            <button
              type="button"
              className="shop-mgmt-btn"
              style={btn}
              onClick={() => {
                const tid = importTenantId.trim()
                if (!tid) {
                  setMsg(t('shopMgmt.importTenantLabel'))
                  return
                }
                void runImport({ tenantId: tid })
              }}
            >
              {t('shopMgmt.importForTenant')}
            </button>
            <button type="button" className="shop-mgmt-btn" style={btn} onClick={() => void runImport({ scope: 'all' })}>
              {t('shopMgmt.importAllTenants')}
            </button>
            <button
              type="button"
              className="shop-mgmt-btn"
              style={btn}
              disabled={healthRefreshing}
              onClick={() => void refreshHealthFromCache({ scope: 'all' })}
            >
              {healthRefreshing ? t('shopMgmt.scanning') : t('shopMgmt.refreshHealthAll')}
            </button>
          </div>
        ) : null}
      </div>

      <div className="shop-mgmt-toolbar">
        <input
          type="search"
          className="shop-mgmt-search"
          style={inp}
          placeholder={t('shopMgmt.searchPlaceholder')}
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
        />
        <select value={marketFilter} onChange={(e) => setMarketFilter(e.target.value)} style={{ ...inp, minWidth: 120 }}>
          <option value="all">{t('shopMgmt.filterMarketAll')}</option>
          {marketOptions.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
        <select value={healthRowFilter} onChange={(e) => setHealthRowFilter(e.target.value)} style={{ ...inp, minWidth: 140 }}>
          <option value="all">{t('shopMgmt.filterAll')}</option>
          <option value="normal">{t('shopMgmt.filterNormal')}</option>
          <option value="abnormal">{t('shopMgmt.filterAbnormal')}</option>
          <option value="no_orders_today">{t('shopMgmt.filterNoOrdersToday')}</option>
          <option value="sync_stale">{t('shopMgmt.filterSyncStale')}</option>
          <option value="sync_off">{t('shopMgmt.filterSyncOffHealth')}</option>
          <option value="hidden">{t('shopMgmt.filterHidden')}</option>
          <option value="disabled">{t('shopMgmt.filterDisabled')}</option>
        </select>
        <select value={syncFilter} onChange={(e) => setSyncFilter(e.target.value)} style={{ ...inp, minWidth: 120 }}>
          <option value="all">{t('shopMgmt.filterSyncAll')}</option>
          <option value="on">{t('shopMgmt.filterSyncOn')}</option>
          <option value="off">{t('shopMgmt.filterSyncOff')}</option>
        </select>
        {canViewOperationLogs ? (
          <button type="button" className="shop-mgmt-btn" style={btn} onClick={() => { setSubView('logs'); void loadLogs(1) }}>
            {t('shopMgmt.auditLogs')}
          </button>
        ) : null}
        {!shellChrome && canUseOpsApi ? (
          <button type="button" className="shop-mgmt-btn" style={btn} disabled={reconcileLoading} onClick={() => void runReconcile()}>
            {reconcileLoading ? t('shopMgmt.reconciling') : t('shopMgmt.reconcileBtn')}
          </button>
        ) : null}
        {canUseOpsApi ? (
          <>
            <button type="button" className="shop-mgmt-btn" style={btn} onClick={() => void loadPreview()}>
              {t('shopMgmt.previewImport')}
            </button>
            {preview ? (
              <span className="debug-meta-hint" style={{ color: '#9ec5ff', fontSize: 12 }}>
                {t('shopMgmt.previewCount', { n: preview.count })}
              </span>
            ) : null}
          </>
        ) : null}
      </div>

      {reconcileOpen ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="reconcile-title"
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.75)',
            zIndex: reconcileZ,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 16,
            overflowX: 'hidden',
            overflowY: 'auto',
          }}
          onClick={() => {
            setReconcileOpen(false)
            setReconcileErr('')
          }}
        >
          <div
            role="document"
            onClick={(e) => e.stopPropagation()}
            style={{
              width: 'min(520px, 100%)',
              maxWidth: '100%',
              maxHeight: 'min(88vh, 640px)',
              overflow: 'auto',
              overflowX: 'hidden',
              background: 'linear-gradient(165deg, #0c1828 0%, #08121e 100%)',
              border: '1px solid rgba(100, 190, 255, 0.4)',
              borderRadius: 14,
              padding: '20px 22px',
              boxShadow: '0 20px 56px rgba(0,0,0,0.5)',
            }}
          >
            <h2 id="reconcile-title" style={{ margin: '0 0 8px', fontSize: 17, color: '#e8f4ff', fontWeight: 700 }}>
              {t('shopMgmt.reconcileModalTitle')}
            </h2>
            <p style={{ margin: '0 0 10px', fontSize: 12, color: '#7a9cc4', lineHeight: 1.5 }}>
              {t('shopMgmt.reconcileDesc', { hours: reconcileReady ? reconcileData.meta?.windowHours ?? 48 : 48 })}
            </p>
            {reconcileReady && reconcileData.meta?.database ? (
              <p style={{ margin: '0 0 6px', fontSize: 12, color: '#9ec5ff' }}>
                {t('shopMgmt.reconcileDatabase', { name: reconcileData.meta.database })}
              </p>
            ) : null}
            {reconcileReady && reconcileData.meta?.scopeShops != null ? (
              <p style={{ margin: '0 0 8px', fontSize: 12, color: '#8aa4c8' }}>
                {t('shopMgmt.reconcileScopeShops', { n: reconcileData.meta.scopeShops })}
                {reconcileData.meta?.timeField
                  ? ` · ${t('shopMgmt.reconcileTimeField', { field: reconcileData.meta.timeField })}`
                  : ''}
              </p>
            ) : null}
            {reconcileReady ? (
              <p style={{ margin: '0 0 12px', fontSize: 12, color: '#7a9cc4', lineHeight: 1.5 }}>
                {t('shopMgmt.reconcileWindowHint')}
              </p>
            ) : (
              <div style={{ marginBottom: 12 }} />
            )}
            {reconcileLoading ? <div style={{ color: '#8fb8e8', marginBottom: 12 }}>{t('shopMgmt.reconciling')}</div> : null}
            {reconcileErr ? <div style={{ color: '#ffaa88', marginBottom: 12, fontSize: 13 }}>{reconcileErr}</div> : null}
            {reconcileData && !reconcileLoading && !reconcileErr ? (
              <div>
                <div style={{ fontWeight: 700, marginBottom: 10, fontSize: 13, color: '#b8dcff' }}>
                  {t('shopMgmt.reconcileOrdersTable')}
                </div>
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
                    gap: 10,
                    marginBottom: 10,
                    fontSize: 14,
                    color: '#d4e6ff',
                  }}
                >
                  <div>
                    {t('shopMgmt.reconcileMysqlTableTotalOrders')}
                    <div style={{ fontSize: 20, fontWeight: 700, color: '#9eb8d8' }}>
                      {reconcileData.meta?.mysqlOrdersTableTotal ?? '—'}
                    </div>
                    <div style={{ fontSize: 11, color: '#6d8aac', marginTop: 2 }}>{t('shopMgmt.reconcileTableTotalNote')}</div>
                  </div>
                  <div>
                    {t('shopMgmt.reconcileMysqlWindowOrders')}
                    <div style={{ fontSize: 22, fontWeight: 700, color: '#8ec8ff' }}>{reconcileData.mysqlOrders}</div>
                  </div>
                  <div>
                    {t('shopMgmt.reconcileCacheWindowOrders')}
                    <div style={{ fontSize: 22, fontWeight: 700, color: '#8ec8ff' }}>{reconcileData.cacheOrders}</div>
                  </div>
                  <div>
                    {t('shopMgmt.reconcileDiffCount')}
                    <div
                      style={{
                        fontSize: 22,
                        fontWeight: 700,
                        color: reconcileHealthy && reconcileDiffTotal === 0 ? '#9ee6c8' : '#ffcc80',
                      }}
                    >
                      {reconcileDiffTotal}
                    </div>
                  </div>
                </div>
                <div style={{ marginBottom: 16, display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 13, color: '#a8c4e8' }}>{t('shopMgmt.reconcileIsHealthy')}</span>
                  <span
                    style={{
                      display: 'inline-block',
                      padding: '4px 12px',
                      borderRadius: 999,
                      fontSize: 12,
                      fontWeight: 600,
                      background: reconcileHealthy
                        ? 'rgba(52, 168, 124, 0.2)'
                        : 'rgba(255, 100, 90, 0.2)',
                      color: reconcileHealthy ? '#9ee6c8' : '#ffaaaa',
                      border: reconcileHealthy
                        ? '1px solid rgba(72, 200, 150, 0.4)'
                        : '1px solid rgba(255, 120, 100, 0.45)',
                    }}
                  >
                    {reconcileHealthy ? t('shopMgmt.reconcileHealthy') : t('shopMgmt.reconcileUnhealthy')}
                  </span>
                </div>
                <div style={{ marginBottom: 8 }}>
                  <div style={{ fontSize: 12, color: '#8aa4c8', marginBottom: 8 }}>{t('shopMgmt.reconcileDiffDetail')}</div>
                  {reconcileIssueLines.length === 0 ? (
                    <div
                      style={{
                        fontSize: 13,
                        color: '#8fb8e8',
                        padding: '12px 0',
                        borderTop: '1px solid rgba(60, 100, 140, 0.35)',
                      }}
                    >
                      {t('shopMgmt.reconcileNoDiff')}
                    </div>
                  ) : (
                    <ul
                      style={{
                        margin: 0,
                        padding: '0 0 0 18px',
                        fontSize: 12,
                        lineHeight: 1.55,
                        color: '#c5daf5',
                        maxHeight: 220,
                        overflow: 'auto',
                      }}
                    >
                      {reconcileIssueLines.map((line, i) => (
                        <li key={i} style={{ marginBottom: 6 }}>
                          {line}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>

                <div
                  style={{
                    marginTop: 18,
                    paddingTop: 16,
                    borderTop: '1px solid rgba(80, 140, 200, 0.35)',
                  }}
                >
                  <div style={{ fontWeight: 700, marginBottom: 10, fontSize: 13, color: '#b8dcff' }}>
                    {t('shopMgmt.reconcileItemsTable')}
                  </div>
                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns: '1fr 1fr',
                      gap: 10,
                      marginBottom: 12,
                      fontSize: 14,
                      color: '#d4e6ff',
                    }}
                  >
                    <div>
                      {t('shopMgmt.reconcileItemCacheRows')}
                      <div style={{ fontSize: 22, fontWeight: 700, color: '#8ec8ff' }}>
                        {reconcileData.meta?.itemCacheRows ?? 0}
                      </div>
                    </div>
                    <div>
                      {t('shopMgmt.reconcileItemMysqlRows')}
                      <div style={{ fontSize: 22, fontWeight: 700, color: '#8ec8ff' }}>
                        {reconcileData.meta?.itemMysqlRows ?? 0}
                      </div>
                    </div>
                  </div>
                  <div style={{ marginBottom: 10, fontSize: 13, color: '#a8c4e8' }}>
                    商品差异项数：
                    <strong
                      style={{
                        color:
                          reconcileItemsHealthy && reconcileItemDiffTotal === 0 ? '#9ee6c8' : '#ffcc80',
                      }}
                    >
                      {reconcileItemDiffTotal}
                    </strong>
                  </div>
                  <div style={{ marginBottom: 12, fontSize: 13, color: '#a8c4e8' }}>
                    无商品明细订单数（不计异常）
                    <strong style={{ color: '#cfe6ff', marginLeft: 6 }}>{reconcileData.meta?.noItems ?? 0}</strong>
                  </div>
                  <div style={{ marginBottom: 12, display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 13, color: '#a8c4e8' }}>明细是否健康</span>
                    <span
                      style={{
                        display: 'inline-block',
                        padding: '4px 12px',
                        borderRadius: 999,
                        fontSize: 12,
                        fontWeight: 600,
                        background: reconcileItemsHealthy
                          ? 'rgba(52, 168, 124, 0.2)'
                          : 'rgba(255, 100, 90, 0.2)',
                        color: reconcileItemsHealthy ? '#9ee6c8' : '#ffaaaa',
                        border: reconcileItemsHealthy
                          ? '1px solid rgba(72, 200, 150, 0.4)'
                          : '1px solid rgba(255, 120, 100, 0.45)',
                      }}
                    >
                      {reconcileItemsHealthy ? '正常' : '异常'}
                    </span>
                  </div>
                  {reconcileItemDiffTotal === 0 && reconcileItemsHealthy ? (
                    <div style={{ fontSize: 14, color: '#9ee6c8', fontWeight: 600 }}>商品明细正常</div>
                  ) : reconcileItemIssueLines.length > 0 ? (
                    <div>
                      <div style={{ fontSize: 12, color: '#8aa4c8', marginBottom: 8 }}>商品明细差异（最多 20 条）</div>
                      <ul
                        style={{
                          margin: 0,
                          padding: '0 0 0 18px',
                          fontSize: 12,
                          lineHeight: 1.55,
                          color: '#ffc9a8',
                          maxHeight: 220,
                          overflow: 'auto',
                        }}
                      >
                        {reconcileItemIssueLines.map((line, i) => (
                          <li key={`it-${i}`} style={{ marginBottom: 6 }}>
                            {line}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : (
                    <div style={{ fontSize: 13, color: '#8fb8e8' }}>商品明细无展开差异行（请核对差异项数）</div>
                  )}
                </div>
              </div>
            ) : null}
            <button
              type="button"
              style={{ ...btn, marginTop: 18, width: '100%', padding: '10px 12px' }}
              onClick={() => {
                setReconcileOpen(false)
                setReconcileErr('')
              }}
            >
              关闭
            </button>
          </div>
        </div>
      ) : null}

      {msg ? <div style={{ color: '#ffcc80', marginBottom: 12 }}>{msg}</div> : null}
      {loading ? <div style={{ color: '#8fb8e8' }}>加载中…</div> : null}

      <p style={{ margin: '0 0 12px', fontSize: 12, color: '#6d86a8' }}>
        {isPlatformScope
          ? t('shopMgmt.platformListMeta', {
              page: tablePage,
              pages: tableTotalPages,
              pageSize: SHOP_TABLE_PAGE_SIZE,
              total: shops.length,
            })
          : t('shopMgmt.tenantQuotaSummary', {
              current: shopSummary.totalAuthorized,
              max: shopSummary.max_shops ?? 20,
              today: shopSummary.todayOrderShopCount,
              abnormal: shopSummary.abnormalCount,
            })}
      </p>

      {editing ? (
        <div
          role="dialog"
          aria-modal="true"
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.65)',
            zIndex: editZ,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 16,
            overflowX: 'hidden',
            overflowY: 'auto',
          }}
          onClick={() => setEditing(null)}
        >
          <form
            onSubmit={saveEdit}
            onClick={(e) => e.stopPropagation()}
            style={{
              background: 'linear-gradient(165deg, #0e1b2c 0%, #0a1524 100%)',
              border: '1px solid rgba(90, 180, 255, 0.35)',
              borderRadius: 12,
              padding: 20,
              width: 'min(480px, 100%)',
              maxWidth: '100%',
              boxSizing: 'border-box',
              boxShadow: '0 0 32px rgba(40, 120, 220, 0.2)',
            }}
          >
            <div style={{ fontWeight: 700, marginBottom: 12, color: '#dff0ff' }}>编辑 #{editing.id}</div>
            <label style={lbl}>
              店铺名 shop_name
              <input style={inpFull} value={editForm.shop_name} onChange={(e) => setEditForm((f) => ({ ...f, shop_name: e.target.value }))} />
            </label>
            <label style={lbl}>
              显示名称 display_name
              <input style={inpFull} value={editForm.display_name} onChange={(e) => setEditForm((f) => ({ ...f, display_name: e.target.value }))} />
            </label>
            <label style={lbl}>
              市场 market
              <input style={inpFull} value={editForm.market} onChange={(e) => setEditForm((f) => ({ ...f, market: e.target.value }))} />
            </label>
            <label style={lbl}>
              排序 sort_order
              <input
                type="number"
                style={inpFull}
                value={editForm.sort_order}
                onChange={(e) => setEditForm((f) => ({ ...f, sort_order: Number(e.target.value) }))}
              />
            </label>
            <label style={lbl}>
              备注 remarks
              <textarea style={{ ...inpFull, minHeight: 72 }} value={editForm.remarks} onChange={(e) => setEditForm((f) => ({ ...f, remarks: e.target.value }))} />
            </label>
            <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
              <button
                type="submit"
                style={btnPrimary}
                disabled={
                  !!(
                    editing &&
                    actionLoadingKey != null &&
                    actionLoadingKey.startsWith(`${editing.id}:`)
                  )
                }
              >
                {editing && actionLoadingKey === rowActionKey(editing.id, 'edit') ? '处理中…' : '保存'}
              </button>
              <button type="button" style={btn} onClick={() => setEditing(null)}>
                取消
              </button>
            </div>
          </form>
        </div>
      ) : null}

      <div className="shops-table-scroll shop-mgmt-table-wrap">
        <table className="shop-mgmt-table">
          <thead>
            <tr>
              <th>{t('shopMgmt.thShop')}</th>
              {isPlatformScope ? (
                <>
                  <th>{t('shopMgmt.thCustomer')}</th>
                  <th>{t('shopMgmt.thTenant')}</th>
                </>
              ) : null}
              <th>{t('shopMgmt.thMarket')}</th>
              <th>{t('shopMgmt.tableStatus')}</th>
              <th>{t('shopMgmt.thSync')}</th>
              <th>{t('shopMgmt.thTodayOrders')}</th>
              <th>{t('shopMgmt.tableTodayGmv')}</th>
              <th>{t('shopMgmt.thHealth')}</th>
              <th>{t('shopMgmt.tableLastSync')}</th>
              <th>{t('shopMgmt.thActions')}</th>
            </tr>
          </thead>
          <tbody>
            {pagedShops.length === 0 && !loading ? (
              <tr>
                <td colSpan={isPlatformScope ? 11 : 9} style={{ ...td, padding: 24, textAlign: 'center', color: '#8fb8e8' }}>
                  {t('shopMgmt.emptyShops')}
                </td>
              </tr>
            ) : null}
            {pagedShops.map((s) => {
              const hd = healthDisplayForRow(s)
              const gmvNum = Number(s.today_gmv ?? s.last_gmv_amount ?? 0)
              const gmvDisp = Number.isFinite(gmvNum) ? gmvNum.toFixed(2) : '—'
              const ordN = Number(s.today_orders ?? s.last_order_count ?? 0)
              const isRowBusy = actionLoadingKey != null && actionLoadingKey.startsWith(`${s.id}:`)
              const ak = (a: ShopRowAction) => actionLoadingKey === rowActionKey(s.id, a)
              const lastSync = fmtOrderSeenAt(
                s.latest_sync_success_at || s.last_sync_at || s.last_cache_sync_at,
              )
              const label = String(s.display_name || s.shop_name || s.platform_shop_id || '—')
              return (
                <tr key={s.id}>
                  <td className="shop-mgmt-shop-cell">
                    <div className="shop-mgmt-shop-name">{label}</div>
                    <div className="shop-mgmt-shop-id">{s.platform_shop_id}</div>
                  </td>
                  {isPlatformScope ? (
                    <>
                      <td>{String(s.tenant_name || '—')}</td>
                      <td>
                        <div>{String(s.tenant_code || '—')}</div>
                        <div className="shop-mgmt-shop-id">#{s.tenant_id ?? '—'}</div>
                      </td>
                    </>
                  ) : null}
                  <td>{s.market || s.region || '—'}</td>
                  <td>{s.status}</td>
                  <td>{displaySyncCell(s)}</td>
                  <td>{Number.isFinite(ordN) ? ordN : '—'}</td>
                  <td>{gmvDisp}</td>
                  <td>
                    <span style={healthPillStyle(hd.key)} title={hd.title}>
                      {hd.label}
                    </span>
                  </td>
                  <td>{lastSync}</td>
                  <td>
                    <div className="shop-mgmt-actions">
                      <button
                        type="button"
                        className="shop-mgmt-btn"
                        disabled={isRowBusy}
                        onClick={() => {
                          if (isRowBusy) return
                          openEdit(s)
                        }}
                      >
                        {ak('edit') ? t('shopMgmt.processing') : t('shopMgmt.btnEdit')}
                      </button>
                      {yn(s.hidden) ? (
                        <button
                          type="button"
                          className="shop-mgmt-btn"
                          disabled={isRowBusy}
                          onClick={() => {
                            if (isRowBusy) return
                            void patchShop(s.id, { hidden: 0 }, 'show')
                          }}
                        >
                          {ak('show') ? t('shopMgmt.processing') : t('shopMgmt.btnShow')}
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="shop-mgmt-btn"
                          disabled={isRowBusy}
                          onClick={() => {
                            if (isRowBusy) return
                            void patchShop(s.id, { hidden: 1 }, 'hide')
                          }}
                        >
                          {ak('hide') ? t('shopMgmt.processing') : t('shopMgmt.btnHide')}
                        </button>
                      )}
                      {s.status === 'disabled' ? (
                        <button
                          type="button"
                          className="shop-mgmt-btn"
                          disabled={isRowBusy}
                          onClick={() => {
                            if (isRowBusy) return
                            void setStatus(s.id, 'active', 'enable')
                          }}
                        >
                          {ak('enable') ? t('shopMgmt.processing') : t('shopMgmt.btnEnable')}
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="shop-mgmt-btn"
                          disabled={isRowBusy}
                          onClick={() => {
                            if (isRowBusy) return
                            void setStatus(s.id, 'disabled', 'disable')
                          }}
                        >
                          {ak('disable') ? t('shopMgmt.processing') : t('shopMgmt.btnDisable')}
                        </button>
                      )}
                      {yn(s.sync_enabled) ? (
                        <button
                          type="button"
                          className="shop-mgmt-btn"
                          disabled={isRowBusy}
                          onClick={() => {
                            if (isRowBusy) return
                            void patchShop(s.id, { sync_enabled: 0 }, 'sync_off')
                          }}
                        >
                          {ak('sync_off') ? t('shopMgmt.processing') : t('shopMgmt.btnSync')}
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="shop-mgmt-btn"
                          disabled={isRowBusy}
                          onClick={() => {
                            if (isRowBusy) return
                            void patchShop(s.id, { sync_enabled: 1 }, 'sync_on')
                          }}
                        >
                          {ak('sync_on') ? t('shopMgmt.processing') : t('shopMgmt.btnSync')}
                        </button>
                      )}
                      <button
                        type="button"
                        className="shop-mgmt-btn shop-mgmt-btn--danger"
                        disabled={isRowBusy}
                        onClick={() => {
                          if (isRowBusy) return
                          void removeShop(s.id)
                        }}
                      >
                        {ak('delete') ? t('shopMgmt.processing') : t('shopMgmt.btnDelete')}
                      </button>
                    </div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <div className="shop-mgmt-pager">
        <span>
          {t('shopMgmt.pageOf', { page: tablePage, pages: tableTotalPages })}
        </span>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            type="button"
            className="shop-mgmt-btn"
            disabled={tablePage <= 1 || loading}
            onClick={() => setTablePage((p) => Math.max(1, p - 1))}
          >
            {t('shopMgmt.pagerPrev')}
          </button>
          <button
            type="button"
            className="shop-mgmt-btn"
            disabled={tablePage >= tableTotalPages || loading}
            onClick={() => setTablePage((p) => Math.min(tableTotalPages, p + 1))}
          >
            {t('shopMgmt.pagerNext')}
          </button>
        </div>
      </div>
        </div>
      )}
    </div>
  )
}

const td: CSSProperties = { padding: 8, verticalAlign: 'top' }
const inp: CSSProperties = { padding: 8, borderRadius: 6, border: '1px solid #2a4568', background: '#0b1524', color: '#fff' }
const inpFull: CSSProperties = { ...inp, width: '100%', boxSizing: 'border-box' }
const lbl: CSSProperties = { display: 'block', marginBottom: 10, fontSize: 13 }
const btn: CSSProperties = {
  padding: '4px 8px',
  borderRadius: 6,
  border: '1px solid rgba(90, 160, 255, 0.45)',
  background: 'rgba(20, 50, 90, 0.35)',
  color: '#cfe6ff',
  cursor: 'pointer',
  fontSize: 12,
}
const btnPrimary: CSSProperties = {
  ...btn,
  background: 'linear-gradient(90deg, #1e5cff, #3d8dff)',
  borderColor: 'rgba(120, 190, 255, 0.55)',
  color: '#fff',
  fontWeight: 600,
}
