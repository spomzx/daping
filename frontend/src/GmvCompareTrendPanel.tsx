/**
 * 实时大屏 GMV 趋势（War-Room）
 * - KPI 仅来自 props.summaryKpi（/api/dashboard/summary）
 * - 曲线仅来自 /api/dashboard/gmv-compare points
 * - 禁止 analytics compare KPI / 趋势 KPI 回退 / 静默 0
 *
 * 数据总览页请使用 analytics/AnalyticsGmvCompareTrendPanel.tsx
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import type { DashboardFilterState } from './lib/dashboardFilters'
import {
  buildDashboardFilterContract,
  buildGmvCompareContractFromProps,
  buildModuleDashboardQuery,
  type DashboardFilterContract,
  logDashboardContract,
} from './lib/dashboardFilterContract'
import { buildGmvCompareQueryKey } from './lib/dashboardQueries'
import {
  isTrendChartConfirmedEmpty,
  readTrendCacheHints,
} from './lib/dashboardTrendCache'
import { useDashboardTrend } from './hooks/useDashboardTrend'
import type { TimeRangePreset } from './i18n'
import { formatMoneyByCurrency } from './currencyDisplay'
import { useI18n } from './i18n'
import { useChartResize } from './hooks/useChartResize'
import {
  normalizeGmvCompareBucketKey,
  normalizeWarRoomGmvCompare,
  parseGmvCompareHourIndex,
  type WarRoomGmvCompareNormalized,
} from './lib/normalizeGmvCompareResponse'
import { fetchDashboardGmvCompare } from './services/api/dashboard'
import type { DashboardSummaryKpi } from './lib/dashboardSummaryKpi'
import {
  formatKpiMoney,
  warnDashboardUiConsistency,
  yoyPercentFromKpi,
} from './lib/dashboardSummaryKpi'

export type GmvCompareStatusFilter = 'all' | 'valid' | 'unpaid' | 'sample' | 'cancelled' | 'paid'

type GmvComparePoint = { bucket: string; bucket_idx?: number; gmv: number }

export type GmvCompareSeriesPayload = {
  today: GmvComparePoint[]
  yesterday: GmvComparePoint[]
  gmv_currency?: string
  meta?: {
    groupBy?: string
    todayWindowStart?: string
    seriesSource?: string
    seriesEmpty?: boolean
    compareMode?: string
    maxHourIdx?: number | null
  }
}

function pad2(n: number) {
  return String(Math.floor(Math.max(0, n))).padStart(2, '0')
}

function formatCompareTooltipTitle(isoStart: string | undefined, index: number, groupBy: 'hour' | 'day'): string {
  const t0 = isoStart ? Date.parse(isoStart) : NaN
  if (!Number.isFinite(t0)) return '—'
  if (groupBy === 'hour') {
    const d = new Date(t0 + index * 3600000)
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:00`
  }
  const d = new Date(t0 + index * 86400000)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

export const GMV_COMPARE_TODAY_STROKE = '#00f5e0'
export const GMV_COMPARE_YESTERDAY_STROKE = '#ffc857'

function yoyPercent(todayVal: number, yVal: number): number | null {
  const t = Number.isFinite(todayVal) ? todayVal : 0
  const y = Number.isFinite(yVal) ? yVal : 0
  if (y <= 0) return null
  return ((t - y) / y) * 100
}

const GMV_TOOLTIP_PAD = 12
const GMV_TOOLTIP_EST_W = 236
const GMV_TOOLTIP_EST_H = 132
const GMV_TOOLTIP_EDGE = 6

type TooltipLayoutProps = {
  active?: boolean
  payload?: ReadonlyArray<{ payload?: unknown }>
  coordinate?: { x?: number; y?: number }
  viewBox?: { x?: number; y?: number; width?: number; height?: number }
  t: (key: string, vars?: Record<string, string | number>) => string
}

function GmvCompareTooltipContent(props: TooltipLayoutProps) {
  const { active, payload, coordinate, viewBox, t } = props
  if (!active || !payload?.length) return null
  const row = payload[0].payload as {
    tooltipTitle: string
    todayGmv: number
    yesterdayGmv: number
  }
  const todayVal = Number(row?.todayGmv ?? 0)
  const yesterdayVal = Number(row?.yesterdayGmv ?? 0)
  const p = yoyPercent(todayVal, yesterdayVal)

  const cx = Number(coordinate?.x ?? 0)
  const cy = Number(coordinate?.y ?? 0)
  const plotW = Math.max(80, Number(viewBox?.width ?? 0))
  const plotH = Math.max(60, Number(viewBox?.height ?? 0))
  const tipW = GMV_TOOLTIP_EST_W
  const tipH = GMV_TOOLTIP_EST_H

  let tx = GMV_TOOLTIP_PAD
  if (cx + GMV_TOOLTIP_PAD + tipW > plotW - GMV_TOOLTIP_EDGE) {
    tx = -(tipW + GMV_TOOLTIP_PAD)
  }
  let ty = GMV_TOOLTIP_PAD
  if (cy + GMV_TOOLTIP_PAD + tipH > plotH - GMV_TOOLTIP_EDGE) {
    ty = -(tipH + GMV_TOOLTIP_PAD)
  }

  let left = cx + tx
  if (left < GMV_TOOLTIP_EDGE) left = GMV_TOOLTIP_EDGE
  if (left + tipW > plotW - GMV_TOOLTIP_EDGE) left = plotW - GMV_TOOLTIP_EDGE - tipW
  let top = cy + ty
  if (top < GMV_TOOLTIP_EDGE) top = GMV_TOOLTIP_EDGE
  if (top + tipH > plotH - GMV_TOOLTIP_EDGE) top = plotH - GMV_TOOLTIP_EDGE - tipH

  const dx = left - cx
  const dy = top - cy

  const yoyText =
    p == null
      ? t('common.dash')
      : `${p >= 0 ? '+' : ''}${p.toFixed(1)}%`

  return (
    <div
      className="gmv-compare-tooltip-anchor"
      style={{
        transform: `translate(${dx}px, ${dy}px)`,
        pointerEvents: 'none',
      }}
    >
      <div
        className="gmv-compare-tooltip-card"
        style={{
          padding: 10,
          fontSize: 12,
          background: '#0E1B2C',
          border: '1px solid #1A2A41',
          borderRadius: 6,
          minWidth: 200,
          boxShadow: '0 4px 20px rgba(0,0,0,0.45)',
        }}
      >
        <div style={{ marginBottom: 6, fontWeight: 600, color: '#e8f0ff' }}>{row.tooltipTitle}</div>
        <div style={{ color: GMV_COMPARE_TODAY_STROKE }}>
          {t('chart.tooltip.todayGmv', { amount: todayVal.toFixed(2) })}
        </div>
        <div style={{ color: GMV_COMPARE_YESTERDAY_STROKE }}>
          {t('chart.tooltip.yesterdayGmv', { amount: yesterdayVal.toFixed(2) })}
        </div>
        <div style={{ marginTop: 6, color: '#D8B45A' }}>{t('chart.tooltip.yoy', { value: yoyText })}</div>
      </div>
    </div>
  )
}

async function fetchDashboardCompareSeries(
  contract: DashboardFilterContract,
  filters: DashboardFilterState,
  resolvedShopId: string,
  groupBy: 'hour' | 'day',
  _signal?: AbortSignal,
  loadOpts?: { force?: boolean },
): Promise<WarRoomGmvCompareNormalized | null> {
  const query = buildModuleDashboardQuery('gmv-compare', filters, [], {
    resolvedShopId,
    extra: { groupBy },
    loadOpts,
  })
  const qs = new URLSearchParams(query).toString()
  const url = `/api/dashboard/gmv-compare?${qs}`
  const raw = await fetchDashboardGmvCompare(query)
  const { normalized, debug } = normalizeWarRoomGmvCompare(raw, { url })
  if (import.meta.env.DEV) {
    console.log('[dashboard-gmv-compare-series]', {
      url,
      debug,
      yesterdayTotal: normalized?.yesterdayTotal,
      todayPoints: normalized?.todaySeries?.length,
      yesterdayPoints: normalized?.yesterdaySeries?.length,
    })
  }
  const points = (normalized?.todaySeries?.length ?? 0) + (normalized?.yesterdaySeries?.length ?? 0)
  logDashboardContract('gmv-compare', contract, { points, extra: 'series-only' })
  return normalized
}

function buildZeroHourCompareRows(maxHourIdx: number, isoStart?: string, gb: 'hour' | 'day' = 'hour') {
  const n = Math.max(0, Math.min(23, Number(maxHourIdx) || 23))
  const rows: {
    bucket: string
    todayGmv: number
    yesterdayGmv: number
    tooltipTitle: string
  }[] = []
  for (let i = 0; i <= n; i++) {
    rows.push({
      bucket: `${pad2(i)}:00`,
      todayGmv: 0,
      yesterdayGmv: 0,
      tooltipTitle: formatCompareTooltipTitle(isoStart, i, gb),
    })
  }
  return rows
}

export function GmvCompareTrendPanel({
  filters,
  resolvedShopId = 'all',
  market,
  shopId,
  status,
  groupBy = 'hour',
  title,
  shopScopeLabel,
  showGranularityControl = false,
  onGroupByChange,
  emptyTrendLabel,
  range,
  startDate,
  endDate,
  summaryKpi,
  summaryKpiLoading = false,
  fetchEnabled = true,
  liveRefreshNonce = 0,
}: {
  /** War-Room：与 summary/orders 同一 dashboardFilters */
  filters?: DashboardFilterState
  resolvedShopId?: string
  /** 无 filters 时回退（兼容旧调用） */
  market?: string
  shopId?: string
  status: GmvCompareStatusFilter
  groupBy?: 'hour' | 'day'
  title?: string
  shopScopeLabel?: string
  showGranularityControl?: boolean
  onGroupByChange?: (next: 'hour' | 'day') => void
  emptyTrendLabel?: string
  range?: string
  startDate?: string
  endDate?: string
  /** 唯一 KPI 来源：/api/dashboard/summary */
  summaryKpi: DashboardSummaryKpi | null
  summaryKpiLoading?: boolean
  /** false 时延迟挂载请求（首屏不抢库） */
  fetchEnabled?: boolean
  liveRefreshNonce?: number
}) {
  const { t } = useI18n()
  const baseTitle = title ?? t('chart.gmvTrendTitle')
  const effectiveShopId = filters ? resolvedShopId : shopId || 'all'
  const panelTitle =
    shopScopeLabel && effectiveShopId !== 'all'
      ? `${baseTitle}｜${shopScopeLabel}`
      : baseTitle
  const rootRef = useRef<HTMLDivElement>(null)
  const chartAreaRef = useRef<HTMLDivElement>(null)
  const [inDashboardRightCol, setInDashboardRightCol] = useState(false)
  const [inAnalyticsPage, setInAnalyticsPage] = useState(false)
  const stableCompareRowsRef = useRef<
    {
      bucket: string
      todayGmv: number
      yesterdayGmv: number
      tooltipTitle: string
    }[]
  >([])
  const chartMountedRef = useRef(false)

  const seriesTodayName = t('chart.todayGmvSeries')
  const seriesYesterdayName = t('chart.yesterdayGmvSeries')

  useLayoutEffect(() => {
    const el = rootRef.current
    if (!el) return
    setInDashboardRightCol(Boolean(el.closest('.right-col')))
    setInAnalyticsPage(Boolean(el.closest('.analytics-page')))
  }, [])

  const displayChartRef = useRef<WarRoomGmvCompareNormalized | null>(null)

  const compareContract = useMemo(() => {
    if (filters) {
      const c = buildDashboardFilterContract(filters)
      const sid = String(resolvedShopId || 'all').trim() || 'all'
      c.shopId = sid.toLowerCase() === 'all' ? 'all' : sid
      return c
    }
    return buildGmvCompareContractFromProps({
      shopId: shopId || 'all',
      market: market || 'all',
      orderFilter: status,
      timeRange: (range || 'today') as TimeRangePreset,
      startDate: startDate || '',
      endDate: endDate || '',
    })
  }, [filters, resolvedShopId, shopId, market, status, range, startDate, endDate])

  const chartFilters: DashboardFilterState = useMemo(() => {
    if (filters) return filters
    return {
      shopId: shopId || 'all',
      marketRegion: market || 'all',
      orderFilter: status,
      timeRange: (range || 'today') as TimeRangePreset,
      customStart: startDate || '',
      customEnd: endDate || '',
      baseCurrency: 'USD',
      targetCurrency: 'USD',
    }
  }, [filters, shopId, market, status, range, startDate, endDate])

  const trendQueryKey = useMemo(
    () => buildGmvCompareQueryKey(compareContract, groupBy, compareContract.tenantId ?? undefined),
    [compareContract, groupBy],
  )

  const fetchCompare = useCallback(
    async (signal: AbortSignal) =>
      fetchDashboardCompareSeries(
        compareContract,
        chartFilters,
        effectiveShopId || 'all',
        groupBy,
        signal,
      ),
    [compareContract, chartFilters, effectiveShopId, groupBy],
  )

  const {
    displayData: displayChart,
    isInitialLoading: trendCompareLoading,
    trendUpdating,
    error: loadErr,
    loaded,
  } = useDashboardTrend({
    endpoint: 'gmv-compare',
    queryKey: trendQueryKey,
    timeRange: compareContract.timeRange,
    enabled: fetchEnabled,
    liveRefreshNonce,
    fetcher: fetchCompare,
    pointCount: (n) =>
      n != null
        ? (n.todaySeries?.length ?? 0) + (n.yesterdaySeries?.length ?? 0)
        : 0,
    readHints: (n) =>
      readTrendCacheHints(n?.meta as Record<string, unknown> | undefined),
  })

  displayChartRef.current = displayChart

  const compareRows = useMemo(() => {
    const gb = (displayChart?.meta?.groupBy === 'day' ? 'day' : 'hour') as 'hour' | 'day'
    const isoStart = displayChart?.meta?.todayWindowStart
    const todaySeries = displayChart?.todaySeries ?? []
    const yesterdaySeries = displayChart?.yesterdaySeries ?? []

    if (!displayChart) {
      return stableCompareRowsRef.current
    }

    type ChartRow = {
      bucket: string
      todayGmv: number
      yesterdayGmv: number
      tooltipTitle: string
    }

    if (gb === 'day') {
      const todayMap = new Map<string, number>()
      const yesterdayMap = new Map<string, number>()
      for (const p of todaySeries) {
        const b = normalizeGmvCompareBucketKey(p.bucket, p.bucket_idx)
        if (!b || !Number.isFinite(p.gmv)) continue
        todayMap.set(b, (todayMap.get(b) ?? 0) + p.gmv)
      }
      for (const p of yesterdaySeries) {
        const b = normalizeGmvCompareBucketKey(p.bucket, p.bucket_idx)
        if (!b || !Number.isFinite(p.gmv)) continue
        yesterdayMap.set(b, (yesterdayMap.get(b) ?? 0) + p.gmv)
      }
      return [...new Set([...todayMap.keys(), ...yesterdayMap.keys()])].sort().map((bucket) => ({
        bucket,
        todayGmv: todayMap.get(bucket) ?? 0,
        yesterdayGmv: yesterdayMap.get(bucket) ?? 0,
        tooltipTitle: bucket,
      }))
    }

    const metaMax = displayChart.meta?.maxHourIdx
    let maxHourIdx =
      metaMax != null && Number.isFinite(Number(metaMax))
        ? Math.min(23, Math.max(0, Number(metaMax)))
        : 23

    const todayByHour = new Map<number, number>()
    const yesterdayByHour = new Map<number, number>()
    for (const p of todaySeries) {
      const idx = parseGmvCompareHourIndex(p.bucket, p.bucket_idx)
      if (idx < 0 || !Number.isFinite(p.gmv)) continue
      maxHourIdx = Math.max(maxHourIdx, idx)
      todayByHour.set(idx, (todayByHour.get(idx) ?? 0) + p.gmv)
    }
    for (const p of yesterdaySeries) {
      const idx = parseGmvCompareHourIndex(p.bucket, p.bucket_idx)
      if (idx < 0 || !Number.isFinite(p.gmv)) continue
      maxHourIdx = Math.max(maxHourIdx, idx)
      yesterdayByHour.set(idx, (yesterdayByHour.get(idx) ?? 0) + p.gmv)
    }

    const rows: ChartRow[] = []
    for (let i = 0; i <= maxHourIdx; i++) {
      const bucket = `${pad2(i)}:00`
      rows.push({
        bucket,
        todayGmv: todayByHour.get(i) ?? 0,
        yesterdayGmv: yesterdayByHour.get(i) ?? 0,
        tooltipTitle: formatCompareTooltipTitle(isoStart, i, gb),
      })
    }

    const hasGmv = rows.some((r) => r.todayGmv > 0 || r.yesterdayGmv > 0)
    if (!hasGmv && todaySeries.length + yesterdaySeries.length > 0) {
      const bucketSet = new Set<string>()
      for (const p of todaySeries) {
        const b = normalizeGmvCompareBucketKey(p.bucket, p.bucket_idx)
        if (b) bucketSet.add(b)
      }
      for (const p of yesterdaySeries) {
        const b = normalizeGmvCompareBucketKey(p.bucket, p.bucket_idx)
        if (b) bucketSet.add(b)
      }
      const todayMap = new Map<string, number>()
      const yesterdayMap = new Map<string, number>()
      for (const p of todaySeries) {
        const b = normalizeGmvCompareBucketKey(p.bucket, p.bucket_idx)
        if (!b || !Number.isFinite(p.gmv)) continue
        todayMap.set(b, (todayMap.get(b) ?? 0) + p.gmv)
      }
      for (const p of yesterdaySeries) {
        const b = normalizeGmvCompareBucketKey(p.bucket, p.bucket_idx)
        if (!b || !Number.isFinite(p.gmv)) continue
        yesterdayMap.set(b, (yesterdayMap.get(b) ?? 0) + p.gmv)
      }
      return [...bucketSet].sort().map((bucket) => ({
        bucket,
        todayGmv: todayMap.get(bucket) ?? 0,
        yesterdayGmv: yesterdayMap.get(bucket) ?? 0,
        tooltipTitle: bucket,
      }))
    }

    if (!hasGmv && todaySeries.length === 0 && yesterdaySeries.length === 0) {
      if (trendUpdating) return stableCompareRowsRef.current
      const rowHints = readTrendCacheHints(displayChart.meta as Record<string, unknown> | undefined)
      if (isTrendChartConfirmedEmpty(rowHints, 0) && gb === 'hour') {
        return buildZeroHourCompareRows(maxHourIdx, isoStart, gb)
      }
      return stableCompareRowsRef.current
    }
    if (rows.length > 0) {
      stableCompareRowsRef.current = rows
      chartMountedRef.current = true
    }
    return rows.length > 0 ? rows : stableCompareRowsRef.current
  }, [displayChart, trendUpdating])

  const hasSeries = compareRows.some((r) => r.todayGmv > 0 || r.yesterdayGmv > 0)
  const chartSize = useChartResize(chartAreaRef, [loaded, inDashboardRightCol, inAnalyticsPage, hasSeries])

  const kpiCurrency = summaryKpi?.gmvCurrency ?? displayChart?.gmv_currency ?? 'USD'
  const displayCurrentGmv = summaryKpi?.currentGmvUsd ?? null
  const displayPreviousGmv = displayChart?.yesterdayTotal ?? null
  const displayYoy = yoyPercentFromKpi(displayCurrentGmv, displayPreviousGmv)

  useEffect(() => {
    if (!import.meta.env.DEV) return
    console.log('[gmv-chart-data]', {
      todaySeries: displayChart?.todaySeries ?? [],
      yesterdaySeries: displayChart?.yesterdaySeries ?? [],
      chartData: compareRows,
    })
  }, [displayChart, compareRows])

  useEffect(() => {
    if (!import.meta.env.DEV || summaryKpiLoading) return
    warnDashboardUiConsistency(
      summaryKpi?.currentGmvUsd ?? null,
      displayCurrentGmv,
      `war-room-${compareContract.timeRange}-${compareContract.orderFilter}`,
    )
  }, [summaryKpi, summaryKpiLoading, displayCurrentGmv, compareContract])

  const showGmvZeroWithOrdersHint = useMemo(() => {
    if (!loaded || summaryKpiLoading) return false
    if (status !== 'unpaid' && status !== 'sample' && status !== 'cancelled') return false
    if (displayCurrentGmv != null && displayCurrentGmv > 0) return false
    return (summaryKpi?.orders ?? 0) > 0
  }, [loaded, summaryKpiLoading, status, displayCurrentGmv, summaryKpi?.orders])

  const yoyColor =
    displayYoy == null ? '#8FA3B8' : displayYoy >= 0 ? '#2ecc71' : '#e74c3c'

  const lineChartMargin = inDashboardRightCol
    ? { top: 10, right: 14, left: 4, bottom: 36 }
    : inAnalyticsPage
      ? { top: 12, right: 28, left: 12, bottom: 40 }
      : { top: 8, right: 16, left: 8, bottom: 28 }

  const showGranularity = Boolean(showGranularityControl && onGroupByChange)

  const chartEmptyMessage = useMemo(() => {
    if (emptyTrendLabel) return emptyTrendLabel
    return t('empty.trend')
  }, [emptyTrendLabel, t])

  const trendCacheHints = readTrendCacheHints(
    displayChart?.meta as Record<string, unknown> | undefined,
  )
  const trendPointCount =
    (displayChart?.todaySeries?.length ?? 0) + (displayChart?.yesterdaySeries?.length ?? 0)
  const showInitialSkeleton = trendCompareLoading && !chartMountedRef.current && !loadErr
  const showChart =
    chartMountedRef.current && !loadErr && (compareRows.length > 0 || trendUpdating || Boolean(displayChart))
  const showEmptyPlaceholder =
    loaded &&
    !loadErr &&
    !hasSeries &&
    !trendUpdating &&
    !chartMountedRef.current &&
    isTrendChartConfirmedEmpty(trendCacheHints, trendPointCount) &&
    !inDashboardRightCol
  const showTrendSkeleton = showInitialSkeleton
  const showTrendError = Boolean(loadErr) && loaded

  const yoyDisplay =
    displayYoy == null
      ? t('common.dash')
      : `${displayYoy >= 0 ? '+' : ''}${displayYoy.toFixed(2)}%`

  const plotHeight = Math.max(chartSize.h, 260)

  const chartAreaStyle: CSSProperties = inDashboardRightCol
    ? { width: '100%', minHeight: 260, flex: '1 1 auto', height: '100%', position: 'relative' }
    : { width: '100%', minHeight: 320, height: plotHeight > 0 ? plotHeight : 320, position: 'relative' }

  return (
    <div
      ref={rootRef}
      className={`gmv-compare-trend-inner${inDashboardRightCol ? ' gmv-compare-trend-inner--dashboard-right' : ''}${inAnalyticsPage ? ' gmv-compare-trend-inner--analytics' : ''}`}
    >
      {showGranularity ? (
        <div className="analytics-trend-title-row">
          <h3 className="analytics-trend-title-row__h">{panelTitle}</h3>
          <div className="analytics-inline-seg" role="group" aria-label={t('chart.granularityAria')}>
            <span className="analytics-inline-seg__label">{t('chart.granularityLabel')}</span>
            <button
              type="button"
              className={`analytics-inline-seg__btn${groupBy === 'hour' ? ' analytics-inline-seg__btn--active' : ''}`}
              onClick={() => onGroupByChange!('hour')}
            >
              {t('chart.byHour')}
            </button>
            <button
              type="button"
              className={`analytics-inline-seg__btn${groupBy === 'day' ? ' analytics-inline-seg__btn--active' : ''}`}
              onClick={() => onGroupByChange!('day')}
            >
              {t('chart.byDay')}
            </button>
          </div>
        </div>
      ) : (
        <h3>{panelTitle}</h3>
      )}
      <div className="gmv-compare-summary-strip" style={{ display: 'flex', flexWrap: 'wrap', gap: 20, marginBottom: 12, fontSize: 14, alignItems: 'baseline' }}>
        <span>
          {t('chart.todayGmv')}：
          <strong>
            {summaryKpiLoading && summaryKpi == null
              ? t('common.loading')
              : formatKpiMoney(kpiCurrency, displayCurrentGmv, formatMoneyByCurrency)}
          </strong>
        </span>
        <span>
          {t('chart.yesterdaySamePeriod')}：
          <strong>
            {trendCompareLoading && displayPreviousGmv == null
              ? t('common.loading')
              : formatKpiMoney(kpiCurrency, displayPreviousGmv, formatMoneyByCurrency)}
          </strong>
        </span>
        <span style={{ color: yoyColor, fontWeight: 600 }}>
          {t('chart.yoy')}：
          {trendCompareLoading && displayPreviousGmv == null ? t('common.loading') : yoyDisplay}
        </span>
      </div>
      {showGmvZeroWithOrdersHint ? (
        <div className="warn-text gmv-compare-filter-hint" style={{ marginBottom: 10 }}>
          当前筛选有订单，GMV 为 0
        </div>
      ) : null}
      <div
        ref={chartAreaRef}
        className={`gmv-compare-chart-area${inDashboardRightCol ? ' gmv-compare-chart-area--dashboard-right' : ''}${inAnalyticsPage ? ' gmv-compare-chart-area--analytics' : ''}`}
        style={chartAreaStyle}
      >
        {trendUpdating && showChart ? (
          <div
            className="gmv-compare-chart-refresh-shade gmv-compare-chart-refresh-shade--hint"
            role="status"
            aria-live="polite"
          >
            {t('chart.trendUpdating')}
          </div>
        ) : null}
        {showTrendSkeleton ? <div className="gmv-compare-empty">{t('common.loading')}</div> : null}
        {showTrendError ? (
          <div className="warn-text gmv-compare-empty">{t('chart.volumeError')}: {loadErr}</div>
        ) : null}
        {showEmptyPlaceholder ? <div className="gmv-compare-empty">{chartEmptyMessage}</div> : null}
        {showChart ? (
          <ResponsiveContainer width="100%" height={plotHeight}>
            <LineChart data={compareRows} margin={lineChartMargin}>
              <CartesianGrid stroke="#1A2A41" strokeDasharray="3 3" />
              <XAxis dataKey="bucket" tick={{ fill: '#8FA3B8', fontSize: 10 }} interval="preserveStartEnd" />
              <YAxis
                tick={{ fill: '#8FA3B8', fontSize: 11 }}
                domain={[(dataMin: number) => Math.max(0, dataMin * 0.95), 'auto']}
              />
              <Tooltip
                allowEscapeViewBox={{ x: true, y: true }}
                isAnimationActive={false}
                wrapperStyle={{
                  outline: 'none',
                  zIndex: 50,
                  pointerEvents: 'none',
                  overflow: 'visible',
                }}
                content={({ active, payload, coordinate, viewBox }) => (
                  <GmvCompareTooltipContent
                    active={active}
                    payload={payload}
                    coordinate={coordinate}
                    viewBox={viewBox}
                    t={t}
                  />
                )}
              />
              <Legend wrapperStyle={{ paddingTop: 6 }} />
              <Line
                type="monotone"
                dataKey="todayGmv"
                name={seriesTodayName}
                stroke={GMV_COMPARE_TODAY_STROKE}
                strokeWidth={2.8}
                dot={false}
                activeDot={{ r: 5, fill: GMV_COMPARE_TODAY_STROKE }}
              />
              <Line
                type="monotone"
                dataKey="yesterdayGmv"
                name={seriesYesterdayName}
                stroke={GMV_COMPARE_YESTERDAY_STROKE}
                strokeWidth={2.4}
                strokeDasharray="10 6"
                dot={false}
                activeDot={{ r: 4, fill: GMV_COMPARE_YESTERDAY_STROKE }}
              />
            </LineChart>
          </ResponsiveContainer>
        ) : null}
      </div>
    </div>
  )
}
