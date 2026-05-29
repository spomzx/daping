import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { DashboardShell } from './components/DashboardShell'
import { isPlatformScope, type MeRole, type UserScope } from './authRole'
import { useAppShellHeader } from './hooks/useAppShellHeader'
import { formatMoneyByCurrency } from './currencyDisplay'
import type { GmvCompareStatusFilter } from './GmvCompareTrendPanel'
import { AnalyticsGmvCompareTrendPanel } from './analytics/AnalyticsGmvCompareTrendPanel'
import {
  AdminButton,
  AdminPagination,
  AdminSection,
  AdminStatCard,
  AdminTable,
  AdminTableBody,
  AdminTableCell,
  AdminTableEmpty,
  AdminTableFooter,
  AdminTableHeader,
  AdminTableLoading,
  AdminTableRow,
  AdminToolbar,
  AdminToolbarField,
  AdminToolbarSearch,
} from './components/admin'
import {
  AnalyticsColumn,
  AnalyticsGrid,
  AnalyticsLayout,
  AnalyticsTopFilters,
} from './components/admin/analytics'
import { abbrevPlatformOrderId, analyticsMarketBadgeStyle } from './analyticsUi'
import { useT } from './i18n'
import { formatOrderTimeHms } from './components/RealtimeOrdersPanel'
import type { ShopListApiRow } from './types/shopListApi'
import type { OrderRealtimeDto } from './types/orderRealtimeDto'
import {
  fetchAnalyticsJson,
  fetchAnalyticsRecentOrders,
  fetchAnalyticsSearchSku,
  fetchAnalyticsSummary,
  fetchAnalyticsTopProducts,
  fetchAnalyticsTopShops,
} from './services/api/analytics'
import { fetchShopsList } from './services/api/shops'
import {
  buildDashboardQueryParams,
  setDashboardQueryState,
  useDashboardQueryStore,
  type DashboardRange,
} from './stores/dashboardQueryStore'

/** 每页展示条数（与需求「30 条」一致） */
const ANALYTICS_LIST_PAGE_SIZE = 30

/**
 * 接口 limit：拉取上限以便前端 slice 分页（后端 top-products≤200，top-shops/recent≤100）
 * 查询参数仍传 limit=30 时无法分页，故这里取允许的最大值。
 */
const FETCH_LIMIT = {
  products: '200',
  shops: '100',
  recent: '100',
} as const

type AnalyticsShopOption = Partial<Pick<ShopListApiRow, 'id' | 'platform_shop_id' | 'shop_name' | 'market'>>

type TopProductRow = {
  product_name: string
  sku_name: string
  qty: number
  gmv: number
  gmv_currency?: string
  orders: number
  market: string
  shop_name: string
}

type TopShopRow = {
  shop_id?: number
  shop_name?: string
  market?: string
  gmv: number
  orders: number
  items: number
}

type OrderStatusFilter = GmvCompareStatusFilter

type SearchSkuRow = {
  sku_id: string
  product_id: string
  sku_name: string
  product_name: string
  quantity: number
  total_amount: number
  market: string
  shop_name: string
  platform_order_id: string
}

const MARKETS = ['ALL', 'TH', 'MY', 'SG', 'PH', 'VN'] as const

function rangeToHours(range: DashboardRange): number {
  if (range === '7d') return 168
  if (range === '30d') return 720
  return 24
}

type AnalyticsSummaryKpi = {
  orders: number | null
  gmv: number | null
  shops: number | null
  gmvCurrency: string
}

function readFiniteNumber(v: unknown): number | null {
  if (v == null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function parseAnalyticsSummary(raw: unknown): AnalyticsSummaryKpi {
  if (!raw || typeof raw !== 'object') {
    return { orders: null, gmv: null, shops: null, gmvCurrency: 'USD' }
  }
  const o = raw as Record<string, unknown>
  return {
    orders: readFiniteNumber(o.orders),
    gmv: readFiniteNumber(o.gmv ?? o.gmv_usd),
    shops: readFiniteNumber(o.shops ?? o.shop_count ?? o.shopCount),
    gmvCurrency: String(o.gmv_currency ?? 'USD'),
  }
}

function analyticsRangeLabel(range: DashboardRange, t: (key: string) => string): string {
  if (range === '7d') return t('analytics.range7dLabel')
  if (range === '30d') return t('analytics.range30dLabel')
  return t('analytics.rangeToday')
}

function analyticsOrderFilterLabel(filter: OrderStatusFilter, t: (key: string) => string): string {
  if (filter === 'valid') return t('filter.order.valid')
  if (filter === 'sample') return t('filter.order.sample')
  if (filter === 'cancelled') return t('filter.order.cancelled')
  if (filter === 'unpaid') return t('filter.order.unpaid')
  return t('filter.order.all')
}

function isAbortError(reason: unknown): boolean {
  const name = String((reason as { name?: unknown })?.name ?? '')
  return name === 'AbortError'
}

function settleErrorMessage(reason: unknown): string {
  return String((reason as Error)?.message || reason)
}

function asTypedArray<T>(input: unknown): T[] {
  return Array.isArray(input) ? (input as T[]) : []
}

function rankMedalClass(rank: number): string {
  if (rank === 1) return 'analytics-rank-badge analytics-rank-badge--1'
  if (rank === 2) return 'analytics-rank-badge analytics-rank-badge--2'
  if (rank === 3) return 'analytics-rank-badge analytics-rank-badge--3'
  return 'analytics-rank-badge analytics-rank-badge--n'
}

function totalPages(totalItems: number, pageSize: number): number {
  return Math.max(1, Math.ceil(Math.max(0, totalItems) / pageSize))
}

type ProductSortKey = 'qty' | 'gmv' | 'orders'
type ShopSortKey = 'gmv' | 'orders' | 'items'

function productRankingTitle(sort: ProductSortKey, t: (key: string) => string): string {
  if (sort === 'gmv') return t('analytics.productsGmvTitle')
  if (sort === 'orders') return t('analytics.productsOrdersTitle')
  return t('analytics.productsTitle')
}

function productMetricLabel(sort: ProductSortKey, t: (key: string) => string): string {
  if (sort === 'gmv') return t('analytics.gmvUsdCol')
  if (sort === 'orders') return t('analytics.sortOrders')
  return t('table.salesQty')
}

function formatRankMetricNumber(v: unknown): string {
  if (v == null || v === '') return '0'
  const n = Number(v)
  return Number.isFinite(n) ? String(n) : '—'
}

function renderProductMetricValue(row: TopProductRow, sort: ProductSortKey): string {
  if (sort === 'gmv') {
    const n = Number(row.gmv)
    return Number.isFinite(n) ? formatMoneyByCurrency('USD', n) : '—'
  }
  if (sort === 'orders') return formatRankMetricNumber(row.orders)
  return formatRankMetricNumber(row.qty)
}

function renderShopGmvValue(row: TopShopRow): string {
  const n = Number(row.gmv)
  return Number.isFinite(n) ? formatMoneyByCurrency('USD', n) : '—'
}

function renderShopOrdersValue(row: TopShopRow): string {
  return formatRankMetricNumber(row.orders)
}

const AnalyticsSeg = memo(function AnalyticsSeg({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: string
  options: { value: string; label: string }[]
  onChange: (v: string) => void
}) {
  return (
    <div className="analytics-inline-seg" role="group" aria-label={label}>
      <span className="analytics-inline-seg__label">{label}</span>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          className={`analytics-inline-seg__btn${value === o.value ? ' analytics-inline-seg__btn--active' : ''}`}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
})

const AnalyticsPager = memo(function AnalyticsPager({
  page,
  totalItems,
  pageSize,
  onPage,
}: {
  page: number
  totalItems: number
  pageSize: number
  onPage: (p: number) => void
}) {
  const t = useT()
  const tp = totalPages(totalItems, pageSize)
  const prev = () => onPage(Math.max(1, page - 1))
  const next = () => onPage(Math.min(tp, page + 1))
  return (
    <div className="analytics-pager" role="navigation" aria-label={t('analytics.pagerAria')}>
      <button type="button" className="analytics-pager-btn" disabled={page <= 1} onClick={prev}>
        {t('analytics.pagerPrev')}
      </button>
      <span className="analytics-pager-status">
        {page} / {tp}
      </span>
      <button type="button" className="analytics-pager-btn" disabled={page >= tp} onClick={next}>
        {t('analytics.pagerNext')}
      </button>
    </div>
  )
})

const AnalyticsProductsSection = memo(function AnalyticsProductsSection({
  rows,
  rankOffset,
  page,
  totalItems,
  onPage,
  sortProducts,
  onSortProductsChange,
  busy,
  moduleLoading,
  moduleErr,
  emptyLabel,
  embedSaas = false,
}: {
  rows: TopProductRow[]
  rankOffset: number
  page: number
  totalItems: number
  onPage: (p: number) => void
  sortProducts: ProductSortKey
  onSortProductsChange: (v: ProductSortKey) => void
  busy?: boolean
  moduleLoading?: boolean
  moduleErr?: string | null
  emptyLabel?: string
  embedSaas?: boolean
}) {
  const t = useT()
  const empty = emptyLabel ?? t('empty.noData')
  const colCount = 3
  const productsTitle = productRankingTitle(sortProducts, t)
  const metricLabel = productMetricLabel(sortProducts, t)

  if (embedSaas) {
    return (
      <AdminSection
        variant="table"
        className="analytics-overview-card"
        title={productsTitle}
        actions={
          <select
            className="locale-select"
            value={sortProducts}
            onChange={(e) => onSortProductsChange(e.target.value as ProductSortKey)}
          >
            <option value="qty">{t('analytics.sortQty')}</option>
            <option value="gmv">{t('analytics.sortGmv')}</option>
            <option value="orders">{t('analytics.sortOrders')}</option>
          </select>
        }
      >
        {moduleErr ? <p className="warn-text analytics-module-err">{moduleErr}</p> : null}
        <div className="analytics-overview-table-body">
          <AdminTable scroll={false} zebra density="compact" stickyHeader className="analytics-table--products">
            <colgroup>
              <col className="analytics-table-col-rank" />
              <col className="analytics-table-col-product" />
              <col className="analytics-table-col-metric" />
            </colgroup>
            <AdminTableHeader>
              <AdminTableRow>
                <AdminTableCell as="th" className="analytics-td-rank">
                  #
                </AdminTableCell>
                <AdminTableCell as="th" className="analytics-td-product">
                  {t('analytics.productSkuCol')}
                </AdminTableCell>
                <AdminTableCell as="th" className="num analytics-td-metric">
                  {metricLabel}
                </AdminTableCell>
              </AdminTableRow>
            </AdminTableHeader>
            <AdminTableBody>
              {moduleLoading ? (
                <AdminTableLoading colSpan={colCount} rows={4} />
              ) : rows.length === 0 ? (
                <AdminTableEmpty colSpan={colCount} description={moduleErr || empty} />
              ) : (
                rows.map((r, i) => {
                  const rank = rankOffset + i + 1
                  return (
                    <AdminTableRow key={`${page}-${rank}-${r.product_name}-${r.sku_name}`}>
                      <AdminTableCell className="analytics-td-rank">
                        <span className={rankMedalClass(rank)}>{rank}</span>
                      </AdminTableCell>
                      <AdminTableCell className="analytics-td-product">
                        <div className="analytics-product-name" title={r.product_name || ''}>
                          {r.product_name || '—'}
                        </div>
                        <div className="analytics-sku-sub" title={r.sku_name || ''}>
                          {r.sku_name || '—'}
                        </div>
                      </AdminTableCell>
                      <AdminTableCell className="num analytics-td-metric analytics-rank-metric-value">
                        {renderProductMetricValue(r, sortProducts)}
                      </AdminTableCell>
                    </AdminTableRow>
                  )
                })
              )}
            </AdminTableBody>
          </AdminTable>
        </div>
        <AdminTableFooter>
          {totalItems > 0 ? (
            <AdminPagination
              page={page}
              totalPages={totalPages(totalItems, ANALYTICS_LIST_PAGE_SIZE)}
              density="compact"
              onPrev={() => onPage(Math.max(1, page - 1))}
              onNext={() => onPage(Math.min(totalPages(totalItems, ANALYTICS_LIST_PAGE_SIZE), page + 1))}
            />
          ) : (
            <span className="admin-pagination-bar__info" aria-hidden>
              &nbsp;
            </span>
          )}
        </AdminTableFooter>
      </AdminSection>
    )
  }

  return (
    <section
      className={`tech-panel table-panel analytics-card analytics-card--products analytics-table-card-h${busy || moduleLoading ? ' analytics-card--module-busy' : ''}`}
    >
      <div className="analytics-card-title-row">
        <h3 className="analytics-card-title">{t('analytics.productsTitle')}</h3>
        <AnalyticsSeg
          label={t('analytics.sort')}
          value={sortProducts}
          options={[
            { value: 'qty', label: t('analytics.sortQty') },
            { value: 'gmv', label: t('analytics.sortGmv') },
            { value: 'orders', label: t('analytics.sortOrders') },
          ]}
          onChange={(v) => onSortProductsChange(v as ProductSortKey)}
        />
      </div>
      {moduleErr ? <div className="warn-text analytics-module-err">{moduleErr}</div> : null}
      <div className="analytics-card-stack">
        <div className="analytics-table-scroll-y">
          <table className="analytics-table analytics-table--products">
            <thead>
              <tr>
                <th className="analytics-th-rank">#</th>
                <th>{t('analytics.productSkuCol')}</th>
                <th className="num">{t('table.salesQty')}</th>
                <th className="num">{t('analytics.gmvUsdCol')}</th>
                <th className="num">{t('analytics.sortOrders')}</th>
                <th className="analytics-th-market">{t('table.market')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={6} className="analytics-empty-cell">
                    {moduleLoading ? t('common.loading') : moduleErr || empty}
                  </td>
                </tr>
              ) : (
                rows.map((r, i) => {
                  const rank = rankOffset + i + 1
                  const m = String(r.market || '').trim().toUpperCase()
                  return (
                    <tr key={`${page}-${rank}-${r.product_name}-${r.sku_name}`} className="analytics-tr-fixed">
                      <td className="analytics-td-rank">
                        <span className={rankMedalClass(rank)}>{rank}</span>
                      </td>
                      <td className="analytics-td-product">
                        <div className="analytics-product-name" title={r.product_name || ''}>
                          {r.product_name || '—'}
                        </div>
                        <div className="analytics-sku-sub" title={r.sku_name || ''}>
                          {r.sku_name || '—'}
                        </div>
                      </td>
                      <td className="num analytics-td-num">{r.qty}</td>
                      <td className="num analytics-td-num">{formatMoneyByCurrency('USD', r.gmv)}</td>
                      <td className="num analytics-td-num">{r.orders}</td>
                      <td className="analytics-td-market">
                        {m ? (
                          <span className="analytics-market-pill" style={analyticsMarketBadgeStyle(m)}>
                            {m}
                          </span>
                        ) : (
                          '—'
                        )}
                      </td>
                    </tr>
                  )
                })
              )}
            </tbody>
          </table>
        </div>
        {totalItems > 0 ? (
          <AnalyticsPager page={page} totalItems={totalItems} pageSize={ANALYTICS_LIST_PAGE_SIZE} onPage={onPage} />
        ) : null}
      </div>
    </section>
  )
})

const AnalyticsShopsSection = memo(function AnalyticsShopsSection({
  rows,
  rankOffset,
  page,
  totalItems,
  onPage,
  sortShops,
  onSortShopsChange,
  busy,
  moduleLoading,
  moduleErr,
  emptyLabel,
  embedSaas = false,
}: {
  rows: TopShopRow[]
  rankOffset: number
  page: number
  totalItems: number
  onPage: (p: number) => void
  sortShops: ShopSortKey
  onSortShopsChange: (v: ShopSortKey) => void
  busy?: boolean
  moduleLoading?: boolean
  moduleErr?: string | null
  emptyLabel?: string
  embedSaas?: boolean
}) {
  const t = useT()
  const showPager = totalItems > ANALYTICS_LIST_PAGE_SIZE
  const empty = emptyLabel ?? t('empty.noData')
  const colCount = 5

  if (embedSaas) {
    return (
      <AdminSection
        variant="table"
        className="analytics-overview-card"
        title={t('analytics.shopsTitle')}
        actions={
          <select
            className="locale-select"
            value={sortShops === 'orders' ? 'orders' : 'gmv'}
            onChange={(e) => onSortShopsChange(e.target.value as ShopSortKey)}
          >
            <option value="gmv">GMV</option>
            <option value="orders">{t('analytics.sortOrders')}</option>
          </select>
        }
      >
        {moduleErr ? <p className="warn-text analytics-module-err">{moduleErr}</p> : null}
        <div className="analytics-overview-table-body">
          <AdminTable scroll={false} zebra density="compact" stickyHeader className="analytics-table--shops">
            <colgroup>
              <col className="analytics-table-col-rank" />
              <col className="analytics-table-col-shop" />
              <col className="analytics-table-col-market" />
              <col className="analytics-table-col-gmv" />
              <col className="analytics-table-col-orders" />
            </colgroup>
            <AdminTableHeader>
              <AdminTableRow>
                <AdminTableCell as="th" className="analytics-td-rank">
                  #
                </AdminTableCell>
                <AdminTableCell as="th" className="analytics-td-shop">
                  {t('table.shopName')}
                </AdminTableCell>
                <AdminTableCell as="th" className="analytics-td-market">
                  {t('table.market')}
                </AdminTableCell>
                <AdminTableCell as="th" className="num analytics-td-gmv">
                  {t('analytics.gmvUsdCol')}
                </AdminTableCell>
                <AdminTableCell as="th" className="num analytics-td-orders">
                  {t('analytics.sortOrders')}
                </AdminTableCell>
              </AdminTableRow>
            </AdminTableHeader>
            <AdminTableBody>
              {moduleLoading ? (
                <AdminTableLoading colSpan={colCount} rows={4} />
              ) : rows.length === 0 ? (
                <AdminTableEmpty colSpan={colCount} description={moduleErr || empty} />
              ) : (
                rows.map((r, i) => {
                  const rank = rankOffset + i + 1
                  const m = String(r.market || '').trim().toUpperCase()
                  return (
                    <AdminTableRow key={`${page}-${rank}-${r.shop_id ?? i}`}>
                      <AdminTableCell className="analytics-td-rank">
                        <span className={rankMedalClass(rank)}>{rank}</span>
                      </AdminTableCell>
                      <AdminTableCell className="analytics-td-shop">
                        <span className="analytics-shop-ellipsis" title={r.shop_name || ''}>
                          {r.shop_name || '—'}
                        </span>
                      </AdminTableCell>
                      <AdminTableCell className="analytics-td-market">
                        {m ? (
                          <span className="analytics-market-pill" style={analyticsMarketBadgeStyle(m)}>
                            {m}
                          </span>
                        ) : (
                          '—'
                        )}
                      </AdminTableCell>
                      <AdminTableCell className="num analytics-td-gmv">
                        {renderShopGmvValue(r)}
                      </AdminTableCell>
                      <AdminTableCell className="num analytics-td-orders">
                        {renderShopOrdersValue(r)}
                      </AdminTableCell>
                    </AdminTableRow>
                  )
                })
              )}
            </AdminTableBody>
          </AdminTable>
        </div>
        <AdminTableFooter>
          {totalItems > 0 && showPager ? (
            <AdminPagination
              page={page}
              totalPages={totalPages(totalItems, ANALYTICS_LIST_PAGE_SIZE)}
              density="compact"
              onPrev={() => onPage(Math.max(1, page - 1))}
              onNext={() => onPage(Math.min(totalPages(totalItems, ANALYTICS_LIST_PAGE_SIZE), page + 1))}
            />
          ) : (
            <span className="admin-pagination-bar__info" aria-hidden>
              &nbsp;
            </span>
          )}
        </AdminTableFooter>
      </AdminSection>
    )
  }

  return (
    <section
      className={`tech-panel table-panel analytics-card analytics-card--shops analytics-table-card-h${busy || moduleLoading ? ' analytics-card--module-busy' : ''}`}
    >
      <div className="analytics-card-title-row">
        <h3 className="analytics-card-title">{t('analytics.shopsTitle')}</h3>
        <AnalyticsSeg
          label={t('analytics.sort')}
          value={sortShops}
          options={[
            { value: 'gmv', label: 'GMV' },
            { value: 'orders', label: t('analytics.sortOrder') },
            { value: 'items', label: t('analytics.sortItems') },
          ]}
          onChange={(v) => onSortShopsChange(v as ShopSortKey)}
        />
      </div>
      {moduleErr ? <div className="warn-text analytics-module-err">{moduleErr}</div> : null}
      <div className="analytics-card-stack">
        <div className="analytics-table-scroll-y">
          <table className="analytics-table analytics-table--shops">
            <thead>
              <tr>
                <th className="analytics-th-rank">#</th>
                <th>{t('table.shopName')}</th>
                <th className="analytics-th-market">{t('table.market')}</th>
                <th className="num">{t('analytics.gmvUsdCol')}</th>
                <th className="num">{t('analytics.sortOrder')}</th>
                <th className="num">{t('analytics.sortItems')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={6} className="analytics-empty-cell">
                    {moduleLoading ? t('common.loading') : moduleErr || empty}
                  </td>
                </tr>
              ) : (
                rows.map((r, i) => {
                  const rank = rankOffset + i + 1
                  const m = String(r.market || '').trim().toUpperCase()
                  return (
                    <tr key={`${page}-${rank}-${r.shop_id ?? i}`} className="analytics-tr-fixed">
                      <td className="analytics-td-rank">
                        <span className={rankMedalClass(rank)}>{rank}</span>
                      </td>
                      <td className="analytics-td-shop">
                        <span className="analytics-shop-ellipsis" title={r.shop_name || ''}>
                          {r.shop_name || '—'}
                        </span>
                      </td>
                      <td className="analytics-td-market">
                        {m ? (
                          <span className="analytics-market-pill" style={analyticsMarketBadgeStyle(m)}>
                            {m}
                          </span>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td className="num analytics-td-num analytics-td-gmv">{formatMoneyByCurrency('USD', r.gmv)}</td>
                      <td className="num analytics-td-num">{r.orders}</td>
                      <td className="num analytics-td-num">{r.items}</td>
                    </tr>
                  )
                })
              )}
            </tbody>
          </table>
        </div>
        {totalItems === 0 ? null : showPager ? (
          <AnalyticsPager page={page} totalItems={totalItems} pageSize={ANALYTICS_LIST_PAGE_SIZE} onPage={onPage} />
        ) : (
          <div className="analytics-pager analytics-pager--layout-only" aria-hidden>
            <button type="button" className="analytics-pager-btn" tabIndex={-1} disabled>
              {t('analytics.pagerPrev')}
            </button>
            <span className="analytics-pager-status">&nbsp;</span>
            <button type="button" className="analytics-pager-btn" tabIndex={-1} disabled>
              {t('analytics.pagerNext')}
            </button>
          </div>
        )}
      </div>
    </section>
  )
})

const AnalyticsRecentOrdersSection = memo(function AnalyticsRecentOrdersSection({
  rows,
  page,
  totalItems,
  onPage,
  moduleLoading,
  moduleErr,
  emptyLabel,
  embedSaas = false,
}: {
  rows: OrderRealtimeDto[]
  page: number
  totalItems: number
  onPage: (p: number) => void
  moduleLoading?: boolean
  moduleErr?: string | null
  emptyLabel?: string
  embedSaas?: boolean
}) {
  const t = useT()
  const empty = emptyLabel ?? t('empty.noData')
  const colCount = 5

  if (embedSaas) {
    return (
      <AdminSection variant="table" className="analytics-overview-card" title={t('analytics.recentOrdersTitle')}>
        <div className="analytics-overview-table-body">
          <AdminTable scroll={false} zebra density="compact" stickyHeader className="analytics-table--recent">
            <colgroup>
              <col className="analytics-table-col-order-id" />
              <col />
              <col className="analytics-table-col-market" />
              <col className="analytics-table-col-amount" />
              <col className="analytics-table-col-time" />
            </colgroup>
            <AdminTableHeader>
              <AdminTableRow>
                <AdminTableCell as="th">{t('table.orderId')}</AdminTableCell>
                <AdminTableCell as="th">{t('table.shopName')}</AdminTableCell>
                <AdminTableCell as="th">{t('table.market')}</AdminTableCell>
                <AdminTableCell as="th" className="num">
                  {t('analytics.amountCol')}
                </AdminTableCell>
                <AdminTableCell as="th" className="num">
                  {t('table.time')}
                </AdminTableCell>
              </AdminTableRow>
            </AdminTableHeader>
            <AdminTableBody>
              {moduleLoading ? (
                <AdminTableLoading colSpan={colCount} rows={4} />
              ) : rows.length === 0 ? (
                <AdminTableEmpty colSpan={colCount} description={moduleErr || empty} />
              ) : (
                rows.map((r) => {
                  const cur = String(r.currency || 'USD').toUpperCase()
                  const usd = r.usd_amount != null && Number.isFinite(r.usd_amount) ? r.usd_amount : null
                  const m = String(r.market || '').trim().toUpperCase()
                  return (
                    <AdminTableRow key={r.platform_order_id}>
                      <AdminTableCell mono className="analytics-td-product">
                        <span className="analytics-order-id" title={r.platform_order_id}>
                          {abbrevPlatformOrderId(r.platform_order_id)}
                        </span>
                      </AdminTableCell>
                      <AdminTableCell className="analytics-td-shop">
                        <span className="analytics-shop-ellipsis" title={r.shop_name || ''}>
                          {r.shop_name || '—'}
                        </span>
                      </AdminTableCell>
                      <AdminTableCell>
                        {m ? (
                          <span className="analytics-market-pill" style={analyticsMarketBadgeStyle(m)}>
                            {m}
                          </span>
                        ) : (
                          '—'
                        )}
                      </AdminTableCell>
                      <AdminTableCell numeric className="analytics-td-amount">
                        <div className="analytics-amt-native">{formatMoneyByCurrency(cur, r.amount)}</div>
                        {usd != null ? (
                          <div className="analytics-amt-usd">{formatMoneyByCurrency('USD', usd)}</div>
                        ) : null}
                      </AdminTableCell>
                      <AdminTableCell numeric className="analytics-td-time">
                        {formatOrderTimeHms(r.created_at_platform)}
                      </AdminTableCell>
                    </AdminTableRow>
                  )
                })
              )}
            </AdminTableBody>
          </AdminTable>
        </div>
        <AdminTableFooter>
          {totalItems > 0 ? (
            <AdminPagination
              page={page}
              totalPages={totalPages(totalItems, ANALYTICS_LIST_PAGE_SIZE)}
              density="compact"
              onPrev={() => onPage(Math.max(1, page - 1))}
              onNext={() => onPage(Math.min(totalPages(totalItems, ANALYTICS_LIST_PAGE_SIZE), page + 1))}
            />
          ) : (
            <span className="admin-pagination-bar__info" aria-hidden>
              &nbsp;
            </span>
          )}
        </AdminTableFooter>
      </AdminSection>
    )
  }

  return (
    <section
      className={`tech-panel table-panel analytics-card analytics-card--recent analytics-table-card-h${moduleLoading ? ' analytics-card--module-busy' : ''}`}
    >
      <h3 className="analytics-card-title">{t('analytics.recentOrdersTitle')}</h3>
      {moduleErr ? <div className="warn-text analytics-module-err">{moduleErr}</div> : null}
      <div className="analytics-card-stack">
        <div className="analytics-recent-card-inner">
          <div className="analytics-recent-grid analytics-recent-grid--head" role="row">
            <div className="analytics-recent-cell" role="columnheader">
              {t('table.orderId')}
            </div>
            <div className="analytics-recent-cell" role="columnheader">
              {t('table.shopName')}
            </div>
            <div className="analytics-recent-cell analytics-recent-cell--market" role="columnheader">
              {t('table.market')}
            </div>
            <div className="analytics-recent-cell analytics-recent-cell--stack" role="columnheader">
              {t('analytics.amountCol')}
            </div>
            <div className="analytics-recent-cell analytics-recent-cell--num" role="columnheader">
              {t('table.qty')}
            </div>
            <div className="analytics-recent-cell analytics-recent-cell--time" role="columnheader">
              {t('table.time')}
            </div>
          </div>
          <div className="analytics-recent-rows-scroll">
            <div className="analytics-recent-grid-wrap">
            {rows.length === 0 ? (
              <div className="analytics-recent-grid analytics-recent-grid--empty" role="row">
                <div className="analytics-recent-cell analytics-recent-cell--empty-span">
                  {moduleLoading ? t('common.loading') : moduleErr || empty}
                </div>
              </div>
            ) : (
              rows.map((r) => {
                const cur = String(r.currency || 'USD').toUpperCase()
                const usd = r.usd_amount != null && Number.isFinite(r.usd_amount) ? r.usd_amount : null
                const m = String(r.market || '').trim().toUpperCase()
                const rowCls = [
                  'analytics-recent-grid',
                  'analytics-recent-row',
                  r.is_large_order ? 'analytics-recent-row--large' : '',
                ]
                  .filter(Boolean)
                  .join(' ')
                return (
                  <div className={rowCls} key={r.platform_order_id} role="row">
                    <div className="analytics-recent-cell analytics-recent-cell--id" title={r.platform_order_id}>
                      {abbrevPlatformOrderId(r.platform_order_id)}
                    </div>
                    <div className="analytics-recent-cell analytics-recent-cell--shop">
                      <span className="analytics-shop-ellipsis" title={r.shop_name || ''}>
                        {r.shop_name || '—'}
                      </span>
                    </div>
                    <div className="analytics-recent-cell analytics-recent-cell--market">
                      {m ? (
                        <span className="analytics-market-pill analytics-market-pill--static" style={analyticsMarketBadgeStyle(m)}>
                          {m}
                        </span>
                      ) : (
                        '—'
                      )}
                    </div>
                    <div className="analytics-recent-cell analytics-recent-cell--stack">
                      <div className="analytics-amt-native">{formatMoneyByCurrency(cur, r.amount)}</div>
                      <div className="analytics-amt-usd">{usd != null ? formatMoneyByCurrency('USD', usd) : '—'}</div>
                    </div>
                    <div className="analytics-recent-cell analytics-recent-cell--num">
                      <span className="analytics-items-inline">
                        <span>{r.items}</span>
                        {r.is_multi_item ? <span className="analytics-multi-tag">{t('orders.realtimeMulti')}</span> : null}
                      </span>
                    </div>
                    <div className="analytics-recent-cell analytics-recent-cell--time">{formatOrderTimeHms(r.created_at_platform)}</div>
                  </div>
                )
              })
            )}
            </div>
          </div>
        </div>
        {totalItems > 0 ? (
          <AnalyticsPager page={page} totalItems={totalItems} pageSize={ANALYTICS_LIST_PAGE_SIZE} onPage={onPage} />
        ) : null}
      </div>
    </section>
  )
})

const AnalyticsSearchSection = memo(function AnalyticsSearchSection({
  searchRows,
}: {
  searchRows: SearchSkuRow[]
}) {
  const t = useT()
  if (searchRows.length === 0) return null
  return (
    <div className="tech-panel analytics-card analytics-search-panel">
      <h4 className="analytics-search-title">{t('analytics.searchResultsTitle')}</h4>
      <div className="analytics-table-wrap">
        <table className="analytics-table analytics-table--search">
          <thead>
            <tr>
              <th>{t('analytics.searchSkuCol')}</th>
              <th>{t('table.product')}</th>
              <th className="num">{t('table.qty')}</th>
              <th>{t('analytics.searchOrderCol')}</th>
            </tr>
          </thead>
          <tbody>
            {searchRows.slice(0, 15).map((r) => (
              <tr key={`${r.platform_order_id}-${r.sku_id}-${r.product_id}`}>
                <td>{r.sku_name}</td>
                <td className="analytics-td-product">
                  <div className="analytics-product-name analytics-product-name--1l">{r.product_name}</div>
                </td>
                <td className="num analytics-td-num">{r.quantity}</td>
                <td className="analytics-td-mono">{r.platform_order_id}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
})

export function AnalyticsPage({
  appUsername,
  appRole,
  appUserScope = 'tenant',
  onLogout,
  saasMode = false,
}: {
  appUsername: string
  appRole: MeRole
  appUserScope?: UserScope
  onLogout: () => void
  /** 嵌入 SaasLayout 时不渲染 DashboardHeader 顶栏 */
  saasMode?: boolean
}) {
  const t = useT()
  const nav = useNavigate()
  const platformScope = isPlatformScope({ scope: appUserScope, role: appRole })
  const { nowText, shopSummary, fetchShopSummary, authConnected } = useAppShellHeader()
  const [searchParams] = useSearchParams()
  const [shops, setShops] = useState<AnalyticsShopOption[]>([])
  const queryStore = useDashboardQueryStore()
  const [sortProducts, setSortProducts] = useState<ProductSortKey>('qty')
  const [sortShops, setSortShops] = useState<ShopSortKey>('gmv')
  const [groupBy, setGroupBy] = useState<'hour' | 'day'>('hour')
  const [debouncedStatus, setDebouncedStatus] = useState<OrderStatusFilter>(queryStore.orderFilter)

  const [topProducts, setTopProducts] = useState<TopProductRow[]>([])
  const [topShops, setTopShops] = useState<TopShopRow[]>([])
  const [recentOrders, setRecentOrders] = useState<OrderRealtimeDto[]>([])
  const [productPage, setProductPage] = useState(1)
  const [shopPage, setShopPage] = useState(1)
  const [orderPage, setOrderPage] = useState(1)

  const [searchQ, setSearchQ] = useState('')
  const [searchRows, setSearchRows] = useState<SearchSkuRow[]>([])
  const [productsLoading, setProductsLoading] = useState(true)
  const [shopsLoading, setShopsLoading] = useState(true)
  const [ordersLoading, setOrdersLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [productsBusy, setProductsBusy] = useState(false)
  const [shopsBusy, setShopsBusy] = useState(false)
  const [productsErr, setProductsErr] = useState<string | null>(null)
  const [shopsErr, setShopsErr] = useState<string | null>(null)
  const [ordersErr, setOrdersErr] = useState<string | null>(null)
  const [summaryKpi, setSummaryKpi] = useState<AnalyticsSummaryKpi>({
    orders: null,
    gmv: null,
    shops: null,
    gmvCurrency: 'USD',
  })
  const [summaryLoading, setSummaryLoading] = useState(true)
  const [summaryErr, setSummaryErr] = useState<string | null>(null)
  const loadedOnceRef = useRef(false)
  const analyticsListAbortRef = useRef<AbortController | null>(null)
  const listFilterKeyRef = useRef<string>('')

  const sortProductsRef = useRef(sortProducts)
  const sortShopsRef = useRef(sortShops)
  sortProductsRef.current = sortProducts
  sortShopsRef.current = sortShops

  const fetchTopProductsRef = useRef<() => Promise<TopProductRow[]>>(async () => [])
  const fetchTopShopsRef = useRef<() => Promise<TopShopRow[]>>(async () => [])

  const market = queryStore.market
  const shopId = queryStore.shopId
  const range = queryStore.range
  const status = queryStore.orderFilter
  const hours = useMemo(() => rangeToHours(range), [range])
  const listFilterKey = useMemo(
    () => `${market}|${shopId}|${range}|${hours}|${debouncedStatus}`,
    [market, shopId, range, hours, debouncedStatus],
  )
  const analyticsListEmptyLabel = useMemo(
    () => (debouncedStatus === 'sample' ? t('empty.sampleOrders') : t('empty.noData')),
    [debouncedStatus, t],
  )

  useEffect(() => {
    const t = window.setTimeout(() => setDebouncedStatus(queryStore.orderFilter), 150)
    return () => window.clearTimeout(t)
  }, [queryStore.orderFilter])

  useEffect(() => {
    const sid = searchParams.get('shop_id')
    if (sid == null || String(sid).trim() === '') return
    const next = String(sid).trim()
    if (queryStore.shopId === next) return
    setDashboardQueryState({ shopId: next })
  }, [searchParams, queryStore.shopId])

  useEffect(() => {
    let alive = true
    fetchShopsList({ page: 1, page_size: 200 })
      .then((j) => {
        if (!alive) return
        const list = j.list || j.shops || []
        setShops(Array.isArray(list) ? list : [])
      })
      .catch(() => {
        if (alive) setShops([])
      })
    return () => {
      alive = false
    }
  }, [])

  const shopQueryParam = shopId === 'all' ? undefined : shopId

  useEffect(() => {
    if (saasMode) return undefined
    document.documentElement.classList.add('analytics-route')
    return () => {
      document.documentElement.classList.remove('analytics-route')
    }
  }, [saasMode])

  const fetchTopProducts = useCallback(
    async (_signal?: AbortSignal): Promise<TopProductRow[]> => {
      const mkt = market === 'ALL' ? undefined : market
      const tp = await fetchAnalyticsTopProducts({
        ...buildDashboardQueryParams(queryStore, {
          market: mkt,
          shop_id: shopQueryParam,
          status: debouncedStatus,
        }),
        limit: FETCH_LIMIT.products,
        sort: sortProductsRef.current,
      })
      return asTypedArray<TopProductRow>(tp)
    },
    [queryStore, market, shopQueryParam, debouncedStatus],
  )

  const fetchTopShops = useCallback(
    async (_signal?: AbortSignal): Promise<TopShopRow[]> => {
      const mkt = market === 'ALL' ? undefined : market
      const ts = await fetchAnalyticsTopShops({
        ...buildDashboardQueryParams(queryStore, {
          market: mkt,
          shop_id: shopQueryParam,
          status: debouncedStatus,
        }),
        sort: sortShopsRef.current,
        limit: FETCH_LIMIT.shops,
      })
      return asTypedArray<TopShopRow>(ts)
    },
    [queryStore, market, shopQueryParam, debouncedStatus],
  )

  const fetchAnalyticsSummaryData = useCallback(async (): Promise<AnalyticsSummaryKpi> => {
    const mkt = market === 'ALL' ? undefined : market
    const raw = await fetchAnalyticsSummary(
      buildDashboardQueryParams(queryStore, {
        market: mkt,
        shop_id: shopQueryParam,
        status: debouncedStatus,
      }),
    )
    return parseAnalyticsSummary(raw)
  }, [queryStore, market, shopQueryParam, debouncedStatus])

  const fetchRecentOrders = useCallback(
    async (_signal?: AbortSignal): Promise<OrderRealtimeDto[]> => {
      const mkt = market === 'ALL' ? undefined : market
      const ro = await fetchAnalyticsRecentOrders({
        ...buildDashboardQueryParams(queryStore, {
          market: mkt,
          shop_id: shopQueryParam,
          status: debouncedStatus,
        }),
        limit: FETCH_LIMIT.recent,
      })
      return asTypedArray<OrderRealtimeDto>(ro)
    },
    [queryStore, market, shopQueryParam, debouncedStatus],
  )

  useEffect(() => {
    fetchTopProductsRef.current = fetchTopProducts
  }, [fetchTopProducts])

  useEffect(() => {
    fetchTopShopsRef.current = fetchTopShops
  }, [fetchTopShops])

  const loadAllFromGlobalFilters = useCallback(async () => {
    analyticsListAbortRef.current?.abort()
    const ac = new AbortController()
    analyticsListAbortRef.current = ac
    const signal = ac.signal

    const initial = !loadedOnceRef.current
    if (initial) {
      setProductsLoading(true)
      setShopsLoading(true)
      if (!saasMode) setOrdersLoading(true)
      setSummaryLoading(true)
    } else {
      setRefreshing(true)
    }
    setProductsErr(null)
    setShopsErr(null)
    if (!saasMode) setOrdersErr(null)
    setSummaryErr(null)

    const listTasks: Promise<unknown>[] = [
      fetchTopProducts(signal),
      fetchTopShops(signal),
      fetchAnalyticsSummaryData(),
    ]
    if (!saasMode) listTasks.push(fetchRecentOrders(signal))
    const settled = await Promise.allSettled(listTasks)
    const productsR = settled[0]
    const shopsR = settled[1]
    const summaryR = settled[2]
    const ordersR = saasMode ? null : settled[3]

    if (signal.aborted) return

    if (productsR.status === 'fulfilled') {
      setTopProducts(productsR.value as TopProductRow[])
      setProductsErr(null)
    } else if (!isAbortError(productsR.reason)) {
      setProductsErr(settleErrorMessage(productsR.reason))
    }

    if (shopsR.status === 'fulfilled') {
      setTopShops(shopsR.value as TopShopRow[])
      setShopsErr(null)
    } else if (!isAbortError(shopsR.reason)) {
      setShopsErr(settleErrorMessage(shopsR.reason))
    }

    if (ordersR) {
      if (ordersR.status === 'fulfilled') {
        setRecentOrders(ordersR.value as OrderRealtimeDto[])
        setOrdersErr(null)
      } else if (!isAbortError(ordersR.reason)) {
        setOrdersErr(settleErrorMessage(ordersR.reason))
      }
    } else {
      setOrdersLoading(false)
    }

    if (summaryR.status === 'fulfilled') {
      setSummaryKpi(summaryR.value as AnalyticsSummaryKpi)
      setSummaryErr(null)
    } else if (!isAbortError(summaryR.reason)) {
      setSummaryErr(settleErrorMessage(summaryR.reason))
      if (import.meta.env.DEV) {
        console.error('[analytics-summary]', summaryR.reason)
      }
    }

    void fetchShopSummary()
    if (listFilterKeyRef.current !== listFilterKey) {
      listFilterKeyRef.current = listFilterKey
      setProductPage(1)
      setShopPage(1)
      setOrderPage(1)
    }

    setProductsLoading(false)
    setShopsLoading(false)
    if (!saasMode) setOrdersLoading(false)
    setSummaryLoading(false)
    setRefreshing(false)
    loadedOnceRef.current = true
  }, [fetchTopProducts, fetchTopShops, fetchRecentOrders, fetchAnalyticsSummaryData, listFilterKey, fetchShopSummary, saasMode])

  useEffect(() => {
    void loadAllFromGlobalFilters()
  }, [loadAllFromGlobalFilters])

  useEffect(() => {
    return () => {
      analyticsListAbortRef.current?.abort()
    }
  }, [])

  /** 开发环境：选择「样品」时拉取各状态计数，便于与 MySQL 口径对照（生产可忽略） */
  useEffect(() => {
    if (!import.meta.env.DEV || debouncedStatus !== 'sample' || productsLoading || refreshing) return
    const qs = new URLSearchParams()
    if (market !== 'ALL') qs.set('market', market)
    if (shopQueryParam) qs.set('shop_id', shopQueryParam)
    qs.set('range', range)
    void fetchAnalyticsJson<Record<string, unknown>>(`/api/analytics/status-debug`, {
      ...buildDashboardQueryParams(queryStore, {
        market: market !== 'ALL' ? market : undefined,
        shop_id: shopQueryParam,
      }),
    })
      .then((j) => console.log('[analytics-status-debug]', j))
      .catch(() => {})
  }, [debouncedStatus, market, shopQueryParam, queryStore, range, productsLoading, refreshing])

  const skipInitialProductSortRef = useRef(true)
  useEffect(() => {
    if (skipInitialProductSortRef.current) {
      skipInitialProductSortRef.current = false
      return
    }
    let cancelled = false
    void (async () => {
      setProductsBusy(true)
      setProductsErr(null)
      try {
        const tp = await fetchTopProductsRef.current()
        if (!cancelled) {
          setTopProducts(tp)
          setProductPage(1)
        }
      } catch (e) {
        if (!cancelled) setProductsErr(settleErrorMessage(e))
      } finally {
        if (!cancelled) setProductsBusy(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [sortProducts])

  const skipInitialShopSortRef = useRef(true)
  useEffect(() => {
    if (skipInitialShopSortRef.current) {
      skipInitialShopSortRef.current = false
      return
    }
    let cancelled = false
    void (async () => {
      setShopsBusy(true)
      setShopsErr(null)
      try {
        const ts = await fetchTopShopsRef.current()
        if (!cancelled) {
          setTopShops(ts)
          setShopPage(1)
        }
      } catch (e) {
        if (!cancelled) setShopsErr(settleErrorMessage(e))
      } finally {
        if (!cancelled) setShopsBusy(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [sortShops])

  useEffect(() => {
    if (hours > 168 && groupBy === 'hour') setGroupBy('day')
  }, [hours, groupBy])

  const runSearch = useCallback(async () => {
    const q = searchQ.trim()
    if (!q) {
      setSearchRows([])
      return
    }
    try {
      const rows = await fetchAnalyticsSearchSku({
        sku: q,
        product_name: q,
        limit: '40',
      })
      setSearchRows(asTypedArray<SearchSkuRow>(rows))
    } catch {
      setSearchRows([])
    }
  }, [searchQ])

  const productSlice = useMemo(() => {
    const start = (productPage - 1) * ANALYTICS_LIST_PAGE_SIZE
    return topProducts.slice(start, start + ANALYTICS_LIST_PAGE_SIZE)
  }, [topProducts, productPage])

  const shopSlice = useMemo(() => {
    const start = (shopPage - 1) * ANALYTICS_LIST_PAGE_SIZE
    return topShops.slice(start, start + ANALYTICS_LIST_PAGE_SIZE)
  }, [topShops, shopPage])

  const orderSlice = useMemo(() => {
    const start = (orderPage - 1) * ANALYTICS_LIST_PAGE_SIZE
    return recentOrders.slice(start, start + ANALYTICS_LIST_PAGE_SIZE)
  }, [recentOrders, orderPage])

  useEffect(() => {
    const tp = totalPages(topProducts.length, ANALYTICS_LIST_PAGE_SIZE)
    if (productPage > tp) setProductPage(tp)
  }, [topProducts.length, productPage])

  useEffect(() => {
    const tp = totalPages(topShops.length, ANALYTICS_LIST_PAGE_SIZE)
    if (shopPage > tp) setShopPage(tp)
  }, [topShops.length, shopPage])

  useEffect(() => {
    const tp = totalPages(recentOrders.length, ANALYTICS_LIST_PAGE_SIZE)
    if (orderPage > tp) setOrderPage(tp)
  }, [recentOrders.length, orderPage])

  const productRankOffset = (productPage - 1) * ANALYTICS_LIST_PAGE_SIZE
  const shopRankOffset = (shopPage - 1) * ANALYTICS_LIST_PAGE_SIZE

  const listInitialLoading = saasMode
    ? productsLoading && shopsLoading
    : productsLoading && shopsLoading && ordersLoading
  const showBlockingLoader = saasMode
    ? listInitialLoading && !topProducts.length && !topShops.length
    : listInitialLoading && !topProducts.length && !topShops.length && !recentOrders.length
  const showListRefreshOverlay = !listInitialLoading && refreshing

  const filterContextHint = t('analytics.filterContextHint', {
    market: market === 'ALL' ? t('analytics.allMarkets') : market,
    range: analyticsRangeLabel(range, t),
    orderFilter: analyticsOrderFilterLabel(debouncedStatus, t),
  })
  const statOrdersValue =
    summaryLoading && summaryKpi.orders == null ? '…' : summaryKpi.orders != null ? String(summaryKpi.orders) : '—'
  const statGmvValue =
    summaryLoading && summaryKpi.gmv == null
      ? '…'
      : summaryKpi.gmv != null
        ? formatMoneyByCurrency(summaryKpi.gmvCurrency || 'USD', summaryKpi.gmv)
        : '—'
  const statAovValue = useMemo(() => {
    if (summaryLoading && summaryKpi.gmv == null && summaryKpi.orders == null) return '…'
    const orders = summaryKpi.orders
    const gmv = summaryKpi.gmv
    if (orders == null || gmv == null || orders <= 0) return '—'
    return formatMoneyByCurrency(summaryKpi.gmvCurrency || 'USD', gmv / orders)
  }, [summaryLoading, summaryKpi.gmv, summaryKpi.orders, summaryKpi.gmvCurrency])
  const statShopsValue =
    summaryLoading && summaryKpi.shops == null ? '…' : summaryKpi.shops != null ? String(summaryKpi.shops) : '—'

  const metaSlot = summaryErr ? (
    <p className="warn-text">{t('analytics.dataApiError', { detail: summaryErr })}</p>
  ) : null

  const saasOverviewContent = (
    <div className="analytics-overview-page">
      {metaSlot ? <div className="analytics-overview-meta">{metaSlot}</div> : null}

      <AdminSection variant="filter" bare>
        <AdminToolbar
          filters={
            <>
              <AdminToolbarField label={t('analytics.filterMarket')}>
                <select value={market} onChange={(e) => setDashboardQueryState({ market: e.target.value })} className="locale-select">
                  {MARKETS.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              </AdminToolbarField>
              <AdminToolbarField label={t('analytics.filterShop')}>
                <select value={shopId} onChange={(e) => setDashboardQueryState({ shopId: e.target.value })} className="locale-select">
                  <option value="all">{t('analytics.all')}</option>
                  {shops.map((s) => (
                    <option key={String(s.id ?? s.platform_shop_id)} value={String(s.id ?? s.platform_shop_id ?? '')}>
                      {s.shop_name || s.platform_shop_id || s.id}
                    </option>
                  ))}
                </select>
              </AdminToolbarField>
              <AdminToolbarField label={t('analytics.filterTimeRange')}>
                <select
                  value={range}
                  onChange={(e) =>
                    setDashboardQueryState({
                      range: (e.target.value === '7d' || e.target.value === '30d'
                        ? e.target.value
                        : 'today') as DashboardRange,
                    })
                  }
                  className="locale-select"
                >
                  <option value="today">{t('analytics.rangeToday')}</option>
                  <option value="7d">{t('analytics.range7dLabel')}</option>
                  <option value="30d">{t('analytics.range30dLabel')}</option>
                </select>
              </AdminToolbarField>
              <AdminToolbarField label={t('analytics.filterOrderStatus')}>
                <select
                  value={status}
                  onChange={(e) =>
                    setDashboardQueryState({
                      orderFilter: e.target.value as 'all' | 'valid' | 'unpaid' | 'sample' | 'cancelled',
                    })
                  }
                  className="locale-select"
                >
                  <option value="all">{t('filter.order.all')}</option>
                  <option value="valid">{t('filter.order.validShort')}</option>
                  <option value="unpaid">{t('filter.order.unpaid')}</option>
                  <option value="sample">{t('filter.order.sample')}</option>
                  <option value="cancelled">{t('filter.order.cancelledShort')}</option>
                </select>
              </AdminToolbarField>
            </>
          }
          actions={
            <AdminButton variant="secondary" disabled={refreshing} onClick={() => void loadAllFromGlobalFilters()}>
              {refreshing ? t('common.refreshing') : t('btn.refresh')}
            </AdminButton>
          }
        />
        <div className="analytics-overview-search-row">
          <AdminToolbarSearch
            value={searchQ}
            onChange={setSearchQ}
            placeholder={t('analytics.searchPlaceholder')}
          />
          <AdminButton variant="secondary" onClick={() => void runSearch()}>
            {t('analytics.searchBtn')}
          </AdminButton>
        </div>
      </AdminSection>

      <p className="analytics-overview-filter-hint">{filterContextHint}</p>

      <AdminSection variant="stats" bare className="analytics-overview-stats">
        <div className="admin-stats-grid analytics-overview-stats-grid">
          <AdminStatCard label={t('analytics.statTodayOrders')} value={statOrdersValue} />
          <AdminStatCard label={t('analytics.statTodayGmv')} value={statGmvValue} />
          <AdminStatCard label={t('analytics.statAvgOrderValue')} value={statAovValue} />
          <AdminStatCard label={t('analytics.statShopCount')} value={statShopsValue} />
        </div>
      </AdminSection>

      {showBlockingLoader ? <div className="analytics-page-loading">{t('common.loading')}</div> : null}

      <div className="analytics-overview-grid analytics-overview-grid--pair" style={{ position: 'relative' }}>
        {showListRefreshOverlay ? (
          <div className="analytics-data-refresh-overlay" aria-busy="true" aria-live="polite">
            <span className="analytics-data-refresh-overlay__text">{t('common.loading')}</span>
          </div>
        ) : null}
        <AnalyticsProductsSection
          embedSaas
          rows={productSlice}
          rankOffset={productRankOffset}
          page={productPage}
          totalItems={topProducts.length}
          onPage={setProductPage}
          sortProducts={sortProducts}
          onSortProductsChange={setSortProducts}
          busy={productsBusy}
          moduleLoading={productsLoading}
          moduleErr={productsErr}
          emptyLabel={analyticsListEmptyLabel}
        />
        <AnalyticsShopsSection
          embedSaas
          rows={shopSlice}
          rankOffset={shopRankOffset}
          page={shopPage}
          totalItems={topShops.length}
          onPage={setShopPage}
          sortShops={sortShops}
          onSortShopsChange={setSortShops}
          busy={shopsBusy}
          moduleLoading={shopsLoading}
          moduleErr={shopsErr}
          emptyLabel={analyticsListEmptyLabel}
        />
      </div>
    </div>
  )

  const legacyPageContent = (
    <AnalyticsLayout>
      <AnalyticsTopFilters className="tech-panel filter-panel">
        <div className="analytics-filter-grid">
          <label className="analytics-filter-item">
            <span className="filter-cluster-title">{t('analytics.filterMarket')}</span>
            <select value={market} onChange={(e) => setDashboardQueryState({ market: e.target.value })} className="locale-select analytics-uni-select">
              {MARKETS.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </label>
          <label className="analytics-filter-item">
            <span className="filter-cluster-title">{t('analytics.filterShop')}</span>
            <select value={shopId} onChange={(e) => setDashboardQueryState({ shopId: e.target.value })} className="locale-select analytics-uni-select">
              <option value="all">{t('analytics.all')}</option>
              {shops.map((s) => (
                <option key={String(s.id ?? s.platform_shop_id)} value={String(s.id ?? s.platform_shop_id ?? '')}>
                  {s.shop_name || s.platform_shop_id || s.id}
                </option>
              ))}
            </select>
          </label>
          <label className="analytics-filter-item">
            <span className="filter-cluster-title">{t('analytics.filterTimeRange')}</span>
            <select
              value={range}
              onChange={(e) =>
                setDashboardQueryState({
                  range: (e.target.value === '7d' || e.target.value === '30d'
                    ? e.target.value
                    : 'today') as DashboardRange,
                })
              }
              className="locale-select analytics-uni-select"
            >
              <option value="today">{t('analytics.rangeToday')}</option>
              <option value="7d">{t('analytics.range7dLabel')}</option>
              <option value="30d">{t('analytics.range30dLabel')}</option>
            </select>
          </label>
          <label className="analytics-filter-item">
            <span className="filter-cluster-title">{t('analytics.filterOrderStatus')}</span>
            <select
              value={status}
              onChange={(e) =>
                setDashboardQueryState({
                  orderFilter: e.target.value as 'all' | 'valid' | 'unpaid' | 'sample' | 'cancelled',
                })
              }
              className="locale-select analytics-uni-select"
            >
              <option value="all">{t('filter.order.all')}</option>
              <option value="valid">{t('filter.order.validShort')}</option>
              <option value="unpaid">{t('filter.order.unpaid')}</option>
              <option value="sample">{t('filter.order.sample')}</option>
              <option value="cancelled">{t('filter.order.cancelledShort')}</option>
            </select>
          </label>
          <div className="analytics-filter-item analytics-filter-item--action">
            <span className="filter-cluster-title analytics-filter-spacer" aria-hidden>
              {'\u00a0'}
            </span>
            <button
              type="button"
              className="refresh-btn analytics-refresh-btn"
              disabled={refreshing}
              onClick={() => void loadAllFromGlobalFilters()}
            >
              {refreshing ? t('common.refreshing') : t('btn.refresh')}
            </button>
          </div>
        </div>
        <div className="analytics-search-row">
          <input
            type="search"
            placeholder={t('analytics.searchPlaceholder')}
            value={searchQ}
            onChange={(e) => setSearchQ(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void runSearch()}
            className="analytics-search-input"
          />
          <button type="button" className="refresh-btn analytics-search-btn" onClick={() => void runSearch()}>
            {t('analytics.searchBtn')}
          </button>
        </div>
      </AnalyticsTopFilters>

      {showBlockingLoader ? <div className="analytics-page-loading">{t('common.loading')}</div> : null}

      <div className="analytics-page-content">
        {showListRefreshOverlay ? (
          <div className="analytics-data-refresh-overlay" aria-busy="true" aria-live="polite">
            <span className="analytics-data-refresh-overlay__text">{t('common.loading')}</span>
          </div>
        ) : null}
        <AnalyticsGrid>
          <AnalyticsColumn className="analytics-main-col--products">
            <AnalyticsProductsSection
              rows={productSlice}
              rankOffset={productRankOffset}
              page={productPage}
              totalItems={topProducts.length}
              onPage={setProductPage}
              sortProducts={sortProducts}
              onSortProductsChange={setSortProducts}
              busy={productsBusy}
              moduleLoading={productsLoading}
              moduleErr={productsErr}
              emptyLabel={analyticsListEmptyLabel}
            />
          </AnalyticsColumn>
          <AnalyticsColumn className="analytics-main-col--shops">
            <AnalyticsShopsSection
              rows={shopSlice}
              rankOffset={shopRankOffset}
              page={shopPage}
              totalItems={topShops.length}
              onPage={setShopPage}
              sortShops={sortShops}
              onSortShopsChange={setSortShops}
              busy={shopsBusy}
              moduleLoading={shopsLoading}
              moduleErr={shopsErr}
              emptyLabel={analyticsListEmptyLabel}
            />
          </AnalyticsColumn>
          <AnalyticsColumn className="analytics-main-col--recent">
            <AnalyticsRecentOrdersSection
              rows={orderSlice}
              page={orderPage}
              totalItems={recentOrders.length}
              onPage={setOrderPage}
              moduleLoading={ordersLoading}
              moduleErr={ordersErr}
              emptyLabel={analyticsListEmptyLabel}
            />
          </AnalyticsColumn>
        </AnalyticsGrid>

        <AnalyticsSearchSection searchRows={searchRows} />

        <section className="tech-panel chart-panel analytics-trend-block analytics-card analytics-card--trend">
          <AnalyticsGmvCompareTrendPanel
            market={market}
            shopId={shopId}
            status={debouncedStatus}
            analyticsHours={hours}
            groupBy={groupBy}
            showGranularityControl
            onGroupByChange={setGroupBy}
            emptyTrendLabel={debouncedStatus === 'sample' ? t('empty.sampleOrders') : undefined}
          />
        </section>
      </div>
    </AnalyticsLayout>
  )

  const pageContent = saasMode ? saasOverviewContent : legacyPageContent

  if (saasMode) {
    return pageContent
  }

  return (
    <DashboardShell
      pageContext="analytics"
      appRole={appRole}
      appUserScope={appUserScope}
      appUsername={appUsername}
      appAccess="full"
      platformScope={platformScope}
      authConnected={authConnected}
      shopSummary={shopSummary}
      activeShopCount={shopSummary.todayOrderShopCount}
      nowText={nowText}
      marketStatsTimezoneHeadline={t('meta.timezoneHint')}
      displayBase="USD"
      displayTarget="CNY"
      displayRate={1}
      rateUpdatedAt="—"
      baseCurrency="USD"
      targetCurrency="CNY"
      onBaseCurrencyChange={() => {}}
      onTargetCurrencyChange={() => {}}
      onRefreshRate={async () => {}}
      onLogout={onLogout}
      onOpenShops={() => nav('/shops')}
      metaSlot={metaSlot}
      mainClassName="dashboard-main app-shell-main analytics-page-main"
      cardClassName="tech-panel analytics-page-card"
    >
      {legacyPageContent}
    </DashboardShell>
  )
}
