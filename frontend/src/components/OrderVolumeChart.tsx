import { memo, useCallback, useMemo, useRef } from 'react'
import ReactECharts from 'echarts-for-react'
import type { EChartsOption } from 'echarts'
import { useChartResize } from '../hooks/useChartResize'
import { useDashboardTrend } from '../hooks/useDashboardTrend'
import { fetchDashboardOrderVolumePayload, type DashboardTrendPoint } from '../services/api/dashboard'
import type { DashboardDataSourceDebug } from '../lib/dashboardSummaryKpi'
import {
  isTrendChartConfirmedEmpty,
  readTrendCacheHints,
} from '../lib/dashboardTrendCache'
import type { DashboardFilterState, ShopCatalogRow } from '../lib/dashboardFilters'
import {
  buildDashboardFilterContract,
  buildModuleDashboardQuery,
} from '../lib/dashboardFilterContract'
import { buildOrderVolumeQueryKey } from '../lib/dashboardQueries'
import { useI18n, type TimeRangePreset } from '../i18n'

export type OrderVolumeChartProps = {
  filters: DashboardFilterState
  resolvedShopId: string
  seriesName: string
  loadingLabel: string
  emptyLabel: string
  errorLabel: string
  onVolumeDebug?: (debug: DashboardDataSourceDebug | null) => void
  /** 首屏错峰；筛选切换后应恒为 true */
  fetchEnabled?: boolean
  liveRefreshNonce?: number
}

type VolumePoint = { label: string; orders: number }

function volumeGroupBy(timeRange: TimeRangePreset): 'hour' | 'day' {
  if (timeRange === 'last7' || timeRange === 'last30' || timeRange === 'custom') return 'day'
  return 'hour'
}

function formatTrendLabel(p: DashboardTrendPoint): string {
  const h = String(p.hour || '').trim()
  if (h) return h
  const t = String(p.time || '').trim()
  if (!t) return '—'
  const m = /\s(\d{2}):(\d{2}):00$/.exec(t)
  if (m) return `${m[1]}:${m[2]}`
  if (t.length >= 16) return t.slice(11, 16)
  if (t.length >= 10) return t.slice(0, 10)
  return t
}

function mapTrendRows(rows: DashboardTrendPoint[]): VolumePoint[] {
  const byLabel = new Map<string, number>()
  for (const p of rows) {
    const label = formatTrendLabel(p)
    const n = Number(p.order_count ?? p.orders ?? 0) || 0
    byLabel.set(label, (byLabel.get(label) ?? 0) + n)
  }
  return [...byLabel.entries()].map(([label, orders]) => ({ label, orders }))
}

function parseVolumeTrendDebug(body: unknown): DashboardDataSourceDebug | null {
  if (!body || typeof body !== 'object') return null
  const dbg = (body as Record<string, unknown>).debug
  if (!dbg || typeof dbg !== 'object') return null
  return dbg as DashboardDataSourceDebug
}

async function fetchVolumeTrendApi(
  query: Record<string, string>,
  _signal?: AbortSignal,
): Promise<{ rows: DashboardTrendPoint[]; debug: DashboardDataSourceDebug | null }> {
  const body = await fetchDashboardOrderVolumePayload(query)
  const debug = parseVolumeTrendDebug(body)
  if (!body || typeof body !== 'object') return { rows: [], debug }
  const o = body as Record<string, unknown>
  if (Array.isArray(o.list)) return { rows: o.list as DashboardTrendPoint[], debug }
  if (Array.isArray(o.data)) return { rows: o.data as DashboardTrendPoint[], debug }
  if (Array.isArray(o.series)) return { rows: o.series as DashboardTrendPoint[], debug }
  return { rows: [], debug }
}

function buildVolumeQuery(
  filters: DashboardFilterState,
  catalog: ShopCatalogRow[],
  resolvedShopId: string,
  opts?: { force?: boolean },
): Record<string, string> {
  return buildModuleDashboardQuery('order-volume', filters, catalog, {
    resolvedShopId,
    extra: { groupBy: volumeGroupBy(filters.timeRange) },
    loadOpts: opts,
  })
}

export const OrderVolumeChart = memo(function OrderVolumeChart({
  filters,
  resolvedShopId,
  seriesName,
  loadingLabel,
  emptyLabel,
  errorLabel,
  onVolumeDebug,
  fetchEnabled = true,
  liveRefreshNonce = 0,
}: OrderVolumeChartProps) {
  const { t } = useI18n()
  const chartWrapRef = useRef<HTMLDivElement>(null)
  const chartMountedRef = useRef(false)
  const stablePointsRef = useRef<VolumePoint[]>([])

  const volumeContract = useMemo(() => {
    const c = buildDashboardFilterContract(filters)
    c.shopId = String(resolvedShopId || 'all').trim() || 'all'
    return c
  }, [
    filters.marketRegion,
    filters.orderFilter,
    filters.timeRange,
    filters.customStart,
    filters.customEnd,
    resolvedShopId,
  ])

  const volumeQueryKey = useMemo(
    () => buildOrderVolumeQueryKey(volumeContract),
    [volumeContract],
  )

  const fetchVolume = useCallback(
    async (signal: AbortSignal) => {
      const query = buildVolumeQuery(filters, [], resolvedShopId)
      const { rows, debug } = await fetchVolumeTrendApi(query, signal)
      onVolumeDebug?.(debug)
      if (import.meta.env.DEV && debug) {
        console.log('[order-volume-debug]', {
          orderFilter: debug.orderFilter,
          cacheSource: (debug as Record<string, unknown>).cacheSource,
          refreshPending: (debug as Record<string, unknown>).refreshPending,
        })
      }
      return { mapped: mapTrendRows(rows), debug }
    },
    [filters, resolvedShopId, onVolumeDebug],
  )

  const {
    displayData: volumePayload,
    isInitialLoading,
    trendUpdating,
    error,
    hints: volumeCacheHints,
  } = useDashboardTrend({
    endpoint: 'order-volume',
    queryKey: volumeQueryKey,
    timeRange: volumeContract.timeRange,
    enabled: fetchEnabled,
    liveRefreshNonce,
    fetcher: fetchVolume,
    pointCount: (p) => p.mapped.length,
    readHints: (p) => readTrendCacheHints(null, p.debug as Record<string, unknown> | null),
  })

  const displayData = volumePayload?.mapped ?? stablePointsRef.current
  if (displayData.length > 0) {
    stablePointsRef.current = displayData
    chartMountedRef.current = true
  }

  const option = useMemo<EChartsOption>(
    () => ({
      backgroundColor: 'transparent',
      tooltip: { trigger: 'axis' as const },
      grid: { left: 52, right: 24, top: 32, bottom: 40 },
      xAxis: {
        type: 'category' as const,
        data: displayData.map((d) => d.label),
        boundaryGap: false,
        axisLabel: { color: '#8FA3B8' },
        axisLine: { lineStyle: { color: '#29415D' } },
      },
      yAxis: {
        type: 'value' as const,
        axisLabel: { color: '#8FA3B8' },
        splitLine: { lineStyle: { color: '#1A2A41' } },
      },
      series: [
        {
          name: seriesName,
          type: 'line' as const,
          smooth: true,
          showSymbol: false,
          lineStyle: { color: '#20D6B5', width: 3 },
          areaStyle: { color: 'rgba(32, 214, 181, 0.15)' },
          data: displayData.map((d) => d.orders),
        },
      ],
    }),
    [displayData, seriesName],
  )

  useChartResize(chartWrapRef, [displayData.length])

  const showBlockingLoading =
    isInitialLoading && !chartMountedRef.current && displayData.length === 0 && !trendUpdating
  const showEmpty =
    !isInitialLoading &&
    !trendUpdating &&
    !error &&
    displayData.length === 0 &&
    isTrendChartConfirmedEmpty(volumeCacheHints, displayData.length)

  return (
    <div ref={chartWrapRef} className="chart-canvas-wrap chart-canvas-wrap--responsive order-volume-chart-wrap">
      {showBlockingLoading ? <div className="loading order-volume-chart-state">{loadingLabel}</div> : null}
      {!showBlockingLoading && error && displayData.length === 0 ? (
        <div className="warn-text order-volume-chart-state">
          {errorLabel}: {error}
        </div>
      ) : null}
      {showEmpty ? <div className="gmv-compare-empty order-volume-chart-state">{emptyLabel}</div> : null}
      {trendUpdating && displayData.length > 0 ? (
        <div
          className="gmv-compare-chart-refresh-shade gmv-compare-chart-refresh-shade--hint order-volume-chart-state"
          role="status"
          aria-live="polite"
        >
          {t('chart.trendUpdating')}
        </div>
      ) : null}
      {chartMountedRef.current || displayData.length > 0 ? (
        <ReactECharts
          option={option}
          notMerge={false}
          lazyUpdate
          style={{ height: '100%', width: '100%', minHeight: 260 }}
          opts={{ renderer: 'canvas' }}
        />
      ) : null}
    </div>
  )
})
