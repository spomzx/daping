import {
  Fragment,
  type CSSProperties,
  type FormEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { Link } from 'react-router-dom'
import {
  deleteShop,
  fetchShopsList,
  fetchShopsSummary,
  patchShop as patchShopApi,
  patchShopStatus,
  postShopsHealthRefreshByScope,
} from './services/api/shops'
import { fetchOperationLogs } from './services/api/operationLogs'
import type { ShopListApiRow } from './types/shopListApi'
import { TikTokOAuthMarketButtons } from './components/TikTokOAuthMarketButtons'
import {
  AdminButton,
  AdminPagination,
  AdminSection,
  AdminStatCard,
  AdminToolbar,
  AdminToolbarField,
  AdminToolbarSearch,
} from './components/admin'
import { useT } from './i18n'
import './pages/Shops/shops-page.css'
import {
  actionLabel,
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

function yn(v: number | boolean | undefined) {
  return v === true || v === 1
}

/** 错误列：仅后端 contract error_label / auth_contract_label */
function shopErrorDisplay(s: ShopListApiRow): string {
  const text = s.error_label ?? s.auth_contract_label
  return text != null && String(text).trim() ? String(text).trim() : ''
}

/**
 * 今日单/GMV：仅用 API 下发的 today_*（MySQL CURDATE），禁止 last_gmv_amount 兜底造成 0 单+正 GMV。
 */
function resolveShopTodayKpi(s: ShopListApiRow): { orders: number; gmv: number } {
  const hasLive =
    s.today_orders != null ||
    s.today_gmv != null ||
    s.stats_source === 'mysql_orders_intraday' || s.stats_source === 'mysql_curdate'
  let orders = hasLive ? Number(s.today_orders ?? 0) : 0
  let gmv = hasLive ? Number(s.today_gmv ?? 0) : 0
  if (!Number.isFinite(orders) || orders < 0) orders = 0
  if (!Number.isFinite(gmv) || gmv < 0) gmv = 0
  if (orders <= 0) gmv = 0
  const syncSt = String(s.sync_status || '').toLowerCase()
  if ((syncSt === 'failed' || syncSt === 'error') && orders <= 0) gmv = 0
  if (s.kpi_trusted === false && orders <= 0) gmv = 0
  return { orders, gmv }
}

type HealthPatchRow = {
  shopId?: number
  shop_id?: number
  healthStatus?: string
  health_status?: string
  healthReason?: string | null
  health_reason?: string | null
  lastSyncAt?: string | null
  last_sync_at?: string | null
  lastOrderAt?: string | null
  last_order_seen_at?: string | null
  latest_order_at?: string | null
  lastApiSuccessAt?: string | null
  latest_sync_success_at?: string | null
  todayOrders?: number
  today_orders?: number
  healthFailCount?: number
  health_fail_count?: number
  applied?: boolean
  retained?: boolean
}

function applyHealthPatches(list: ShopListApiRow[], patches: HealthPatchRow[]): ShopListApiRow[] {
  if (!patches?.length) return list
  const byId = new Map<number, HealthPatchRow>()
  for (const p of patches) {
    const id = Number(p.shopId ?? p.shop_id)
    if (Number.isFinite(id)) byId.set(id, p)
  }
  return list.map((s) => {
    const p = byId.get(s.id)
    if (!p) return s
    const hs = String(p.healthStatus ?? p.health_status ?? s.health_status ?? s.last_health_status ?? '')
    const hr = p.healthReason ?? p.health_reason ?? s.health_reason ?? s.last_health_message
    const today = Number(p.todayOrders ?? p.today_orders ?? s.today_orders ?? 0)
    return {
      ...s,
      health_status: hs || s.health_status,
      health_reason: hr != null ? String(hr) : s.health_reason,
      last_health_status: hs || s.last_health_status,
      last_health_message: hr != null ? String(hr) : s.last_health_message,
      last_sync_at: p.lastSyncAt ?? p.last_sync_at ?? p.lastApiSuccessAt ?? p.latest_sync_success_at ?? s.last_sync_at,
      latest_sync_success_at:
        p.lastApiSuccessAt ?? p.latest_sync_success_at ?? p.lastSyncAt ?? p.last_sync_at ?? s.latest_sync_success_at,
      last_order_seen_at: p.lastOrderAt ?? p.last_order_seen_at ?? p.latest_order_at ?? s.last_order_seen_at,
      latest_order_at: p.latest_order_at ?? p.lastOrderAt ?? s.latest_order_at,
      today_orders: today,
      today_gmv: today > 0 ? Number(s.today_gmv ?? s.last_gmv_amount ?? 0) : 0,
      last_order_count: today,
      last_gmv_amount: today > 0 ? Number(s.today_gmv ?? s.last_gmv_amount ?? 0) : 0,
    }
  })
}

function rowMatchesHealthFilter(s: ShopListApiRow, f: string): boolean {
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
    const ts = String(s.token_status || '').toLowerCase()
    if (ts === 'active') {
      const hl = String(s.health_label || '')
      return /异常|停滞|授权|失效|错误/i.test(hl)
    }
    return ts !== 'active'
  }
  if (f === 'no_orders_today') return h === 'no_orders_today'
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
    case 'sync_failed':
      return { ...base, background: 'rgba(255,90,90,0.18)', color: '#ffaaaa', border: '1px solid rgba(255,120,100,0.4)' }
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

const SHOP_TABLE_PAGE_SIZE = 10
/** 与后端 SHOP_HEALTH_REFRESH_COOLDOWN_MS 默认一致 */
const HEALTH_REFRESH_DEBOUNCE_MS = 30000

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
  const [shops, setShops] = useState<ShopListApiRow[]>([])
  const [shopSummary, setShopSummary] = useState<ShopSummaryState>({
    totalAuthorized: 0,
    enabledCount: 0,
    todayOrderShopCount: 0,
    abnormalCount: 0,
    scope: 'tenant',
    max_shops: 20,
  })
  const isPlatformScope = hasPlatformScope || shopSummary.scope === 'platform'
  const [searchQuery, setSearchQuery] = useState('')
  const [marketFilter, setMarketFilter] = useState('all')
  const [syncFilter, setSyncFilter] = useState('all')
  const [tablePage, setTablePage] = useState(1)
  const [serverTotal, setServerTotal] = useState(0)

  const [msg, setMsg] = useState('')
  const [loading, setLoading] = useState(true)
  const [healthRowFilter, setHealthRowFilter] = useState<string>(() => initialHealthFilter || 'all')
  const [healthRefreshing, setHealthRefreshing] = useState(false)
  const healthRefreshBlockedUntilRef = useRef(0)
  const [editing, setEditing] = useState<ShopListApiRow | null>(null)
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

  function syncStatusLabel(st: string | null | undefined) {
    const key = String(st || '').toLowerCase()
    const map: Record<string, string> = {
      idle: 'idle',
      queueing: 'queueing',
      syncing: 'syncing',
      success: 'success',
      partial_success: 'partial',
      failed: 'failed',
      retry_wait: 'retry',
      rate_limited: 'rate_limited',
      token_expired: 'token_expired',
      disabled: 'disabled',
    }
    return map[key] || key || '—'
  }

  /** 同步开关列：sync_label / sync_status（contract） */
  function displaySyncCell(s: ShopListApiRow) {
    const on = yn(s.sync_enabled)
    const q = s.sync_label?.trim() || syncStatusLabel(s.sync_status)
    if (q && q !== 'idle' && q !== '—') return `${q} (${on ? t('common.on') : t('common.off')})`
    return on ? t('common.on') : t('common.off')
  }

  /** sync_status 列：sync_label / sync_status */
  function syncStatusCell(s: ShopListApiRow): string {
    return s.sync_label?.trim() || syncStatusLabel(s.sync_status) || 'idle'
  }

  function healthPillKeyFromToken(s: ShopListApiRow): string {
    const ts = String(s.token_status || '').toLowerCase()
    if (ts === 'active') return 'normal'
    if (ts === 'expired') return 'sync_failed'
    if (ts === 'missing') return 'sync_off'
    return 'default'
  }

  /** 健康列：health_label；tooltip 用 error_label */
  function healthDisplayForRow(s: ShopListApiRow): { key: string; label: string; title?: string } {
    const st = String(s.status || '').toLowerCase()
    if (st === 'disabled') return { key: 'disabled', label: healthStatusLabel(t, 'disabled') }
    if (yn(s.hidden)) return { key: 'hidden', label: healthStatusLabel(t, 'hidden') }
    if (!yn(s.sync_enabled)) return { key: 'sync_off', label: t('shopMgmt.syncOffLabel') }

    const label = s.health_label?.trim() || '—'
    const title = shopErrorDisplay(s) || undefined
    return { key: healthPillKeyFromToken(s), label, title }
  }

  async function refresh(opts?: { silent?: boolean }) {
    const silent = opts?.silent === true
    if (!silent) setLoading(true)
    try {
      const summaryRes = await fetchShopsSummary()
      let list: ShopListApiRow[] = []
      if (serverPagination) {
        const q: Record<string, string | number> = {
          page: tablePage,
          page_size: SHOP_TABLE_PAGE_SIZE,
        }
        if (searchQuery.trim()) q.keyword = searchQuery.trim()
        if (marketFilter !== 'all') q.region = marketFilter
        const j = await fetchShopsList(q)
        list = j.list || j.shops || []
        setServerTotal(Number(j.total) || 0)
      } else {
        const j = await fetchShopsList({ page: 1, page_size: 100 })
        list = (Array.isArray(j.shops) ? j.shops : []) as ShopListApiRow[]
        setServerTotal(list.length)
      }
      setShops(list)
      const dbgAll = list
        .map((s) => s.health_debug)
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
    if (editing == null) return
    const prevOverflow = document.body.style.overflow
    const prevOverflowX = document.body.style.overflowX
    document.body.style.overflow = 'hidden'
    document.body.style.overflowX = 'hidden'
    return () => {
      document.body.style.overflow = prevOverflow
      document.body.style.overflowX = prevOverflowX
    }
  }, [editing])

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

  /** 静默 POST 健康扫描（不写操作提示；冷却/进行中时跳过，避免 refresh 风暴） */
  async function refreshHealthSilent(): Promise<boolean> {
    if (!canRefreshHealth) return true
    if (Date.now() < healthRefreshBlockedUntilRef.current) return false
    try {
      const j = await postShopsHealthRefreshByScope()
      if (j.error === 'refresh_in_progress' || j.error === 'refresh_cooldown') return false
      if (j.error) {
        console.warn('[shop-health] POST /api/shops/health/refresh failed', j.error)
        return false
      }
      healthRefreshBlockedUntilRef.current = Date.now() + HEALTH_REFRESH_DEBOUNCE_MS
      return true
    } catch (e) {
      console.warn('[shop-health] refresh error', e)
      return false
    }
  }

  async function refreshHealthFromCache(opts?: { scope?: 'all' }) {
    if (!canRefreshHealth) return
    const now = Date.now()
    if (healthRefreshing) {
      setMsg(t('shopMgmt.healthRefreshInProgress'))
      return
    }
    if (now < healthRefreshBlockedUntilRef.current) {
      const sec = Math.max(1, Math.ceil((healthRefreshBlockedUntilRef.current - now) / 1000))
      setMsg(t('shopMgmt.healthRefreshCooldownSecs', { seconds: sec }))
      return
    }
    setHealthRefreshing(true)
    try {
      const j = await postShopsHealthRefreshByScope(opts?.scope)
      if (j.error) {
        if (j.error === 'refresh_in_progress') {
          setMsg(t('shopMgmt.healthRefreshInProgress'))
          return
        }
        if (j.error === 'refresh_cooldown') {
          const retryMs = Number(j.retry_after_ms) || HEALTH_REFRESH_DEBOUNCE_MS
          healthRefreshBlockedUntilRef.current = Date.now() + retryMs
          const sec = Math.max(1, Math.ceil(retryMs / 1000))
          setMsg(t('shopMgmt.healthRefreshCooldownSecs', { seconds: sec }))
          return
        }
        if (j.keep_previous || j.error === 'refresh_failed') {
          setMsg(t('shopMgmt.healthRefreshFailedKept'))
          return
        }
        throw new Error(String(j.error))
      }
      const allPatches = (Array.isArray(j.shops) ? j.shops : []) as HealthPatchRow[]
      const patches = allPatches.filter((p) => p.applied !== false && p.retained !== true)
      if (patches.length) {
        setShops((prev) => applyHealthPatches(prev, patches))
      }
      const partial = Boolean(j.partial) || Number(j.retained_count) > 0
      try {
        const summaryRes = await fetchShopsSummary()
        const scope = summaryRes.scope === 'platform' ? 'platform' : 'tenant'
        setShopSummary((prev) => ({
          ...prev,
          totalAuthorized: Number(summaryRes.totalAuthorized ?? prev?.totalAuthorized ?? 0),
          enabledCount: Number(summaryRes.enabledCount ?? prev?.enabledCount ?? 0),
          todayOrderShopCount: Number(summaryRes.todayOrderShopCount ?? prev?.todayOrderShopCount ?? 0),
          abnormalCount: Number(summaryRes.abnormalCount ?? j.abnormal ?? prev?.abnormalCount ?? 0),
          scope,
          max_shops: scope === 'platform' ? null : Number(summaryRes.max_shops ?? 20) || 20,
          perTenantDefaultMaxShops:
            scope === 'platform' ? Number(summaryRes.perTenantDefaultMaxShops ?? 20) || 20 : undefined,
          currentShops:
            summaryRes.currentShops != null
              ? Number(summaryRes.currentShops)
              : Number(summaryRes.totalAuthorized ?? prev?.currentShops ?? 0),
        }))
      } catch (e) {
        console.warn('[shop-health] summary refresh failed', e)
        setShopSummary((prev) =>
          prev ? { ...prev, abnormalCount: Number(j.abnormal ?? prev.abnormalCount ?? 0) } : prev,
        )
      }
      if (partial) {
        setMsg(
          t('shopMgmt.healthRefreshPartial', {
            applied: Number(j.applied_count ?? patches.length) || 0,
            retained: Number(j.retained_count ?? 0) || 0,
            abnormal: Number(j.abnormal ?? 0) || 0,
          }),
        )
      } else if (j.scope === 'all') {
        setMsg(
          t('shopMgmt.refreshAllDone', {
            checked: Number(j.checked ?? 0) || 0,
            abnormal: Number(j.abnormal ?? 0) || 0,
          }),
        )
      } else {
        setMsg(
          t('shopMgmt.healthScanDone', {
            checked: Number(j.checked ?? 0) || 0,
            abnormal: Number(j.abnormal ?? 0) || 0,
          }),
        )
      }
      if (onDashboardRefresh) await Promise.resolve(onDashboardRefresh({ force: true }))
      healthRefreshBlockedUntilRef.current = Date.now() + HEALTH_REFRESH_DEBOUNCE_MS
    } catch {
      setMsg(t('shopMgmt.healthRefreshFailedKept'))
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
      const j = await fetchOperationLogs({ page: p, pageSize: 20, module: 'shops' })
      setLogPage(Number(j.page) || p)
      setLogTotal(Number(j.total) || 0)
      setLogItems(Array.isArray(j.items) ? (j.items as LogRow[]) : [])
    } catch (e) {
      setLogMsg(e instanceof Error ? e.message : '日志加载失败')
    } finally {
      setLogLoading(false)
    }
  }

  async function patchShop(id: number, body: Record<string, unknown>, action: ShopRowAction): Promise<boolean> {
    if (!tryBeginRowAction(id, action)) {
      return false
    }
    try {
      const j = await patchShopApi(id, body)
      if (j.error) {
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
      const j = await patchShopStatus(id, status)
      if (j.error) {
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
      const j = await deleteShop(id)
      if (j.error) {
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

  function openEdit(s: ShopListApiRow) {
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

      <AdminSection variant="stats" bare aria-label={t('shopMgmt.drawerTitle')}>
      <div className="admin-stats-grid shop-mgmt-stats">
        <AdminStatCard
          label={isPlatformScope ? t('shopMgmt.platformTotal') : t('shopMgmt.tenantAuthorizedQuota')}
          value={
            isPlatformScope
              ? t('shopMgmt.platformUnlimited', { n: shopSummary.totalAuthorized })
              : t('shopMgmt.quotaUsed', {
                  current: shopSummary.totalAuthorized,
                  max: shopSummary.max_shops ?? 20,
                })
          }
        />
        {isPlatformScope ? null : (
          <AdminStatCard label={t('shopMgmt.statEnabled')} value={shopSummary.enabledCount} />
        )}
        <AdminStatCard label={t('shopMgmt.statTodayOrders')} value={shopSummary.todayOrderShopCount} />
        <AdminStatCard label={t('shopMgmt.statAbnormal')} value={shopSummary.abnormalCount} />
        {isPlatformScope ? (
          <AdminStatCard
            label={t('shopMgmt.perTenantMaxHint', { n: shopSummary.perTenantDefaultMaxShops ?? 20 })}
            value={`${t('shopMgmt.statEnabled')}: ${shopSummary.enabledCount}`}
            className="shop-mgmt-stat-card--platform-hint"
          />
        ) : null}
      </div>
      </AdminSection>

      <AdminSection
        variant="auth"
        className="shop-auth-card"
        title="店铺授权"
        description="连接 TikTok Shop 店铺，完成订单与销售数据同步。"
        actions={
          canRefreshHealth ? (
            <>
              <AdminButton
                variant="secondary"
                disabled={healthRefreshing}
                onClick={() => void refreshHealthFromCache()}
              >
                {healthRefreshing ? t('shopMgmt.healthRefreshing') : t('shopMgmt.refreshHealth')}
              </AdminButton>
              {isPlatformScope ? (
                <AdminButton
                  variant="secondary"
                  disabled={healthRefreshing}
                  onClick={() => void refreshHealthFromCache({ scope: 'all' })}
                >
                  {healthRefreshing ? t('shopMgmt.healthRefreshing') : t('shopMgmt.refreshHealthAll')}
                </AdminButton>
              ) : null}
            </>
          ) : null
        }
      >
        <TikTokOAuthMarketButtons />
      </AdminSection>

      <AdminSection variant="filter" bare>
      <AdminToolbar
        className="shop-mgmt-toolbar"
        filters={
          <>
            <AdminToolbarField label={t('shopMgmt.searchPlaceholder')}>
              <AdminToolbarSearch
                value={searchQuery}
                onChange={setSearchQuery}
                placeholder={t('shopMgmt.searchPlaceholder')}
                className="shop-mgmt-search"
              />
            </AdminToolbarField>
            <AdminToolbarField label={t('shopMgmt.filterMarketAll')}>
              <select
                value={marketFilter}
                onChange={(e) => setMarketFilter(e.target.value)}
                className="locale-select"
                style={{ ...inp, minWidth: 120 }}
              >
                <option value="all">{t('shopMgmt.filterMarketAll')}</option>
                {marketOptions.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </AdminToolbarField>
            <AdminToolbarField label={t('shopMgmt.filterAll')}>
              <select
                value={healthRowFilter}
                onChange={(e) => setHealthRowFilter(e.target.value)}
                className="locale-select"
                style={{ ...inp, minWidth: 140 }}
              >
                <option value="all">{t('shopMgmt.filterAll')}</option>
                <option value="normal">{t('shopMgmt.filterNormal')}</option>
                <option value="abnormal">{t('shopMgmt.filterAbnormal')}</option>
                <option value="no_orders_today">{t('shopMgmt.filterNoOrdersToday')}</option>
                <option value="sync_stale">{t('shopMgmt.filterSyncStale')}</option>
                <option value="sync_off">{t('shopMgmt.filterSyncOffHealth')}</option>
                <option value="hidden">{t('shopMgmt.filterHidden')}</option>
                <option value="disabled">{t('shopMgmt.filterDisabled')}</option>
              </select>
            </AdminToolbarField>
            <AdminToolbarField label={t('shopMgmt.filterSyncAll')}>
              <select
                value={syncFilter}
                onChange={(e) => setSyncFilter(e.target.value)}
                className="locale-select"
                style={{ ...inp, minWidth: 120 }}
              >
                <option value="all">{t('shopMgmt.filterSyncAll')}</option>
                <option value="on">{t('shopMgmt.filterSyncOn')}</option>
                <option value="off">{t('shopMgmt.filterSyncOff')}</option>
              </select>
            </AdminToolbarField>
          </>
        }
        actions={
          canViewOperationLogs ? (
            <AdminButton variant="secondary" onClick={() => { setSubView('logs'); void loadLogs(1) }}>
              {t('shopMgmt.auditLogs')}
            </AdminButton>
          ) : null
        }
      />
      </AdminSection>

      <AdminSection variant="table">
      {msg ? <div className="shop-mgmt-inline-msg">{msg}</div> : null}
      {loading ? <div className="shop-mgmt-inline-loading">加载中…</div> : null}

      <p className="admin-section__meta shop-mgmt-list-meta">
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

      <div className="admin-table-wrap shop-mgmt-table-section shops-table-scroll shop-mgmt-table-wrap">
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
              <th>{t('shopMgmt.syncStatus')}</th>
              <th>{t('shopMgmt.lastSuccessSync')}</th>
              <th>{t('shopMgmt.syncFailCount')}</th>
              <th>{t('shopMgmt.lastSyncError')}</th>
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
                <td colSpan={isPlatformScope ? 15 : 13} style={{ ...td, padding: 24, textAlign: 'center', color: '#8fb8e8' }}>
                  {t('shopMgmt.emptyShops')}
                </td>
              </tr>
            ) : null}
            {pagedShops.map((s) => {
              const hd = healthDisplayForRow(s)
              const kpi = resolveShopTodayKpi(s)
              const gmvDisp = Number.isFinite(kpi.gmv) ? kpi.gmv.toFixed(2) : '—'
              const ordN = kpi.orders
              const errTitle = shopErrorDisplay(s)
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
                  <td>{syncStatusCell(s)}</td>
                  <td>
                    {fmtOrderSeenAt(s.last_success_sync_at || s.latest_sync_success_at)}
                  </td>
                  <td>{Number(s.sync_fail_count ?? 0) > 0 ? String(s.sync_fail_count) : '0'}</td>
                  <td className="shop-mgmt-sync-err" title={errTitle || undefined}>
                    {errTitle || '—'}
                  </td>
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
                      <AdminButton
                        variant="secondary"
                        className="shop-mgmt-btn"
                        disabled={isRowBusy}
                        onClick={() => {
                          if (isRowBusy) return
                          openEdit(s)
                        }}
                      >
                        {ak('edit') ? t('shopMgmt.processing') : t('shopMgmt.btnEdit')}
                      </AdminButton>
                      {yn(s.hidden) ? (
                        <AdminButton
                          variant="secondary"
                          className="shop-mgmt-btn"
                          disabled={isRowBusy}
                          onClick={() => {
                            if (isRowBusy) return
                            void patchShop(s.id, { hidden: 0 }, 'show')
                          }}
                        >
                          {ak('show') ? t('shopMgmt.processing') : t('shopMgmt.btnShow')}
                        </AdminButton>
                      ) : (
                        <AdminButton
                          variant="secondary"
                          className="shop-mgmt-btn"
                          disabled={isRowBusy}
                          onClick={() => {
                            if (isRowBusy) return
                            void patchShop(s.id, { hidden: 1 }, 'hide')
                          }}
                        >
                          {ak('hide') ? t('shopMgmt.processing') : t('shopMgmt.btnHide')}
                        </AdminButton>
                      )}
                      {s.status === 'disabled' ? (
                        <AdminButton
                          variant="secondary"
                          className="shop-mgmt-btn"
                          disabled={isRowBusy}
                          onClick={() => {
                            if (isRowBusy) return
                            void setStatus(s.id, 'active', 'enable')
                          }}
                        >
                          {ak('enable') ? t('shopMgmt.processing') : t('shopMgmt.btnEnable')}
                        </AdminButton>
                      ) : (
                        <AdminButton
                          variant="secondary"
                          className="shop-mgmt-btn"
                          disabled={isRowBusy}
                          onClick={() => {
                            if (isRowBusy) return
                            void setStatus(s.id, 'disabled', 'disable')
                          }}
                        >
                          {ak('disable') ? t('shopMgmt.processing') : t('shopMgmt.btnDisable')}
                        </AdminButton>
                      )}
                      {yn(s.sync_enabled) ? (
                        <AdminButton
                          variant="secondary"
                          className="shop-mgmt-btn"
                          disabled={isRowBusy}
                          onClick={() => {
                            if (isRowBusy) return
                            void patchShop(s.id, { sync_enabled: 0 }, 'sync_off')
                          }}
                        >
                          {ak('sync_off') ? t('shopMgmt.processing') : t('shopMgmt.btnSync')}
                        </AdminButton>
                      ) : (
                        <AdminButton
                          variant="secondary"
                          className="shop-mgmt-btn"
                          disabled={isRowBusy}
                          onClick={() => {
                            if (isRowBusy) return
                            void patchShop(s.id, { sync_enabled: 1 }, 'sync_on')
                          }}
                        >
                          {ak('sync_on') ? t('shopMgmt.processing') : t('shopMgmt.btnSync')}
                        </AdminButton>
                      )}
                      <AdminButton
                        variant="danger"
                        className="shop-mgmt-btn shop-mgmt-btn--danger"
                        disabled={isRowBusy}
                        onClick={() => {
                          if (isRowBusy) return
                          void removeShop(s.id)
                        }}
                      >
                        {ak('delete') ? t('shopMgmt.processing') : t('shopMgmt.btnDelete')}
                      </AdminButton>
                    </div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <AdminPagination
        className="shop-mgmt-pager"
        page={tablePage}
        totalPages={tableTotalPages}
        disabled={loading}
        info={t('shopMgmt.pageOf', { page: tablePage, pages: tableTotalPages })}
        prevLabel={t('shopMgmt.pagerPrev')}
        nextLabel={t('shopMgmt.pagerNext')}
        onPrev={() => setTablePage((p) => Math.max(1, p - 1))}
        onNext={() => setTablePage((p) => Math.min(tableTotalPages, p + 1))}
      />
      </AdminSection>
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
