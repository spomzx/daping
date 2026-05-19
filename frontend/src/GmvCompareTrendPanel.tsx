import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
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
import { fetchWithAuth } from './apiClient'
import { formatMoneyByCurrency } from './currencyDisplay'
import { useI18n } from './i18n'
import { useChartResize } from './hooks/useChartResize'
import { fetchDashboardSummary, fetchDashboardTrend } from './services/api/dashboard'

export type GmvCompareStatusFilter = 'all' | 'valid' | 'unpaid' | 'sample' | 'cancelled'

type GmvComparePoint = { bucket: string; bucket_idx?: number; gmv: number }

export type GmvComparePayload = {
  today: GmvComparePoint[]
  yesterday: GmvComparePoint[]
  summary: { todayTotal: number; yesterdayTotal: number; changePercent: number | null }
  gmv_currency?: string
  meta?: {
    hours: number
    groupBy: string
    todayWindowStart?: string
    yesterdayWindowStart?: string
    seriesSource?: string
    seriesEmpty?: boolean
    emptyReason?: string
    compareMode?: string
    maxHourIdx?: number | null
    yesterdaySegmentEnd?: string
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

/** 今日：高亮青实线；昨日：橙黄虚线（与图例、Tooltip 一致） */
export const GMV_COMPARE_TODAY_STROKE = '#00f5e0'
/** 昨日：橙黄虚线（Analytics / 大屏图例统一） */
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

async function fetchCompareJson(
  query: Record<string, string | undefined>,
  signal?: AbortSignal,
): Promise<GmvComparePayload | null> {
  const qs = new URLSearchParams()
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== '') qs.set(k, v)
  }
  const res = await fetchWithAuth(`/api/analytics/gmv-compare?${qs}`, {
    cache: 'no-store',
    signal,
  })
  if (!res.ok) return null as unknown as GmvComparePayload
  return res.json() as Promise<GmvComparePayload>
}

export function GmvCompareTrendPanel({
  market,
  shopId,
  status,
  hours = 24,
  groupBy = 'hour',
  title,
  showGranularityControl = false,
  onGroupByChange,
  emptyTrendLabel,
  baseCurrency,
  targetCurrency,
  range,
  startDate,
  endDate,
}: {
  market: string
  shopId: string
  status: GmvCompareStatusFilter
  hours?: number
  groupBy?: 'hour' | 'day'
  title?: string
  showGranularityControl?: boolean
  onGroupByChange?: (next: 'hour' | 'day') => void
  emptyTrendLabel?: string
  /** 与看板一致时传入，便于汇率与缓存口径对齐 */
  baseCurrency?: string
  targetCurrency?: string
  /** 与 /api/dashboard 的 range 一致（today / last7 / …） */
  range?: string
  startDate?: string
  endDate?: string
}) {
  const { locale, t } = useI18n()
  const panelTitle = title ?? t('chart.gmvTrendTitle')
  const rootRef = useRef<HTMLDivElement>(null)
  const chartAreaRef = useRef<HTMLDivElement>(null)
  const [inDashboardRightCol, setInDashboardRightCol] = useState(false)
  const [inAnalyticsPage, setInAnalyticsPage] = useState(false)
  const [gmvCompare, setGmvCompare] = useState<GmvComparePayload | null>(null)
  const [loadErr, setLoadErr] = useState<string | null>(null)
  const [trendRefetching, setTrendRefetching] = useState(false)
  const [fallbackTodayUsd, setFallbackTodayUsd] = useState<number | null>(null)
  const [trendFallback, setTrendFallback] = useState<GmvComparePayload | null>(null)

  const seriesTodayName = t('chart.todayGmvSeries')
  const seriesYesterdayName = t('chart.yesterdayGmvSeries')

  useLayoutEffect(() => {
    const el = rootRef.current
    if (!el) return
    const inRight = Boolean(el.closest('.right-col'))
    const inAnalytics = Boolean(el.closest('.analytics-page'))
    setInDashboardRightCol(inRight)
    setInAnalyticsPage(inAnalytics)
  }, [])

  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    const ac = new AbortController()
    let cancelled = false
    setTrendRefetching(loaded)
    setLoadErr(null)
    void (async () => {
      try {
        const payload = await fetchCompareJson(
          {
            market: market === 'all' ? undefined : market,
            shop_id: shopId === 'all' ? undefined : shopId,
            status,
            hours: String(hours),
            group_by: groupBy,
            ...(baseCurrency ? { baseCurrency } : {}),
            ...(targetCurrency ? { targetCurrency } : {}),
            ...(range ? { range } : {}),
            ...(startDate ? { startDate } : {}),
            ...(endDate ? { endDate } : {}),
          },
          ac.signal,
        )
        if (cancelled) return
        if (!payload || !Array.isArray(payload.today)) {
          setGmvCompare(null)
        } else {
          setGmvCompare(payload)
        }
        setLoadErr(null)
        setLoaded(true)
      } catch (e) {
        if (cancelled || (e as Error)?.name === 'AbortError') return
        setGmvCompare(null)
        setLoadErr(null)
        setLoaded(true)
      } finally {
        if (!cancelled) setTrendRefetching(false)
      }
    })()
    return () => {
      cancelled = true
      ac.abort()
    }
  }, [market, shopId, status, hours, groupBy, locale, baseCurrency, targetCurrency, range, startDate, endDate])

  useEffect(() => {
    if (!loaded) return
    const cmpToday = gmvCompare?.summary?.todayTotal ?? 0
    if (cmpToday > 0) {
      setFallbackTodayUsd(null)
      return
    }
    let cancelled = false
    void (async () => {
      try {
        const q: Record<string, string> = { range: range || 'today' }
        if (market && market !== 'all') q.market = market
        if (shopId && shopId !== 'all') q.shop_id = shopId
        if (startDate) q.startDate = startDate
        if (endDate) q.endDate = endDate
        const s = await fetchDashboardSummary(q)
        if (cancelled) return
        const v = Number(
          (s as { gmv?: number }).gmv ?? s.summary?.todayGmvTarget ?? s.todayGmvTarget ?? s.today_gmv_usd ?? 0,
        )
        setFallbackTodayUsd(Number.isFinite(v) && v > 0 ? v : null)
      } catch {
        if (!cancelled) setFallbackTodayUsd(null)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [loaded, gmvCompare, market, shopId, range, startDate, endDate])

  useEffect(() => {
    if (!loaded) return
    const cmp = gmvCompare
    const hasCmpSeries = Boolean(
      cmp?.today?.some((p) => Number(p.gmv) > 0) || cmp?.yesterday?.some((p) => Number(p.gmv) > 0),
    )
    if (hasCmpSeries) {
      setTrendFallback(null)
      return
    }
    const total = cmp?.summary?.todayTotal ?? 0
    if (total <= 0 && fallbackTodayUsd == null) {
      setTrendFallback(null)
      return
    }
    let cancelled = false
    void (async () => {
      try {
        const q: Record<string, string> = {
          range: range || 'today',
          hours: String(hours),
          groupBy,
        }
        if (market && market !== 'all') q.market = market
        if (shopId && shopId !== 'all') q.shop_id = shopId
        if (startDate) q.startDate = startDate
        if (endDate) q.endDate = endDate
        const points = await fetchDashboardTrend(q)
        if (cancelled || !points.length) return
        const today = points.map((p) => ({
          bucket: String(p.hour || '00:00'),
          gmv: Number(p.gmv_usd ?? p.gmv ?? 0),
          order_count: Number(p.order_count ?? p.orders ?? 0),
        }))
        if (!today.some((p) => p.gmv > 0)) return
        setTrendFallback({
          today,
          yesterday: cmp?.yesterday || [],
          summary: {
            todayTotal: total > 0 ? total : today.reduce((s, p) => s + p.gmv, 0),
            yesterdayTotal: cmp?.summary?.yesterdayTotal ?? 0,
            changePercent: cmp?.summary?.changePercent ?? null,
          },
          gmv_currency: 'USD',
          meta: { hours, groupBy, seriesSource: 'dashboard_trend_fallback' },
        })
      } catch {
        if (!cancelled) setTrendFallback(null)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [loaded, gmvCompare, fallbackTodayUsd, market, shopId, range, startDate, endDate, hours, groupBy])

  const activeCompare = trendFallback || gmvCompare

  const compareRows = useMemo(() => {
    if (!activeCompare) return []
    const today = activeCompare.today || []
    const yesterday = activeCompare.yesterday || []
    const len = Math.max(today.length, yesterday.length)
    const isoStart = activeCompare.meta?.todayWindowStart
    const gb = (activeCompare.meta?.groupBy === 'day' ? 'day' : 'hour') as 'hour' | 'day'
    const rows: {
      bucket: string
      todayGmv: number
      yesterdayGmv: number
      tooltipTitle: string
    }[] = []
    for (let i = 0; i < len; i++) {
      const tPt = today[i]
      const yPt = yesterday[i]
      const bucket = String(tPt?.bucket ?? yPt?.bucket ?? '')
      rows.push({
        bucket,
        todayGmv: Number(tPt?.gmv ?? 0),
        yesterdayGmv: Number(yPt?.gmv ?? 0),
        tooltipTitle: formatCompareTooltipTitle(isoStart, i, gb),
      })
    }
    return rows
  }, [activeCompare])

  const compareSummary = activeCompare?.summary ?? { todayTotal: 0, yesterdayTotal: 0, changePercent: null }

  const hasSeries = useMemo(() => {
    if (compareRows.some((r) => r.todayGmv > 0 || r.yesterdayGmv > 0)) return true
    if (trendFallback?.today?.some((p) => Number(p.gmv) > 0)) return true
    return false
  }, [compareRows, trendFallback])

  const chartSize = useChartResize(chartAreaRef, [loaded, inDashboardRightCol, inAnalyticsPage, hasSeries])

  const summaryForDisplay = useMemo(() => {
    if (!loaded) return compareSummary
    if (compareSummary.todayTotal > 0 || compareSummary.yesterdayTotal > 0) return compareSummary
    if (fallbackTodayUsd != null && fallbackTodayUsd > 0) {
      return { ...compareSummary, todayTotal: fallbackTodayUsd }
    }
    if (hasSeries || loadErr) return compareSummary
    return { todayTotal: 0, yesterdayTotal: 0, changePercent: null }
  }, [loaded, loadErr, hasSeries, compareSummary, fallbackTodayUsd])

  const yoyColor =
    summaryForDisplay.changePercent == null ? '#8FA3B8' : summaryForDisplay.changePercent >= 0 ? '#2ecc71' : '#e74c3c'

  const lineChartMargin = inDashboardRightCol
    ? { top: 10, right: 14, left: 4, bottom: 36 }
    : inAnalyticsPage
      ? { top: 12, right: 28, left: 12, bottom: 40 }
      : { top: 8, right: 16, left: 8, bottom: 28 }

  const showGranularity = Boolean(showGranularityControl && onGroupByChange)

  const chartEmptyMessage = useMemo(() => {
    if (emptyTrendLabel) return emptyTrendLabel
    if (summaryForDisplay.todayTotal > 0 && !hasSeries) return '暂无分时趋势数据'
    if (status === 'sample' && inAnalyticsPage) return t('empty.sampleOrders')
    return t('empty.trend')
  }, [emptyTrendLabel, summaryForDisplay.todayTotal, hasSeries, status, inAnalyticsPage, t])

  const yoyDisplay =
    summaryForDisplay.changePercent == null
      ? t('common.dash')
      : `${summaryForDisplay.changePercent >= 0 ? '+' : ''}${summaryForDisplay.changePercent.toFixed(2)}%`

  const plotHeight = Math.max(chartSize.h, 260)

  useEffect(() => {
    const el = chartAreaRef.current
    if (!el) return
    const tick = () => {
      void el.getBoundingClientRect()
    }
    const id = requestAnimationFrame(() => requestAnimationFrame(tick))
    return () => cancelAnimationFrame(id)
  }, [loaded, hasSeries, inDashboardRightCol, plotHeight])

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
          {t('chart.todayGmv')}：<strong>{formatMoneyByCurrency('USD', summaryForDisplay.todayTotal)}</strong>
        </span>
        <span>
          {t('chart.yesterdaySamePeriod')}：<strong>{formatMoneyByCurrency('USD', summaryForDisplay.yesterdayTotal)}</strong>
        </span>
        <span style={{ color: yoyColor, fontWeight: 600 }}>
          {t('chart.yoy')}：{yoyDisplay}
        </span>
      </div>
      <div
        ref={chartAreaRef}
        className={`gmv-compare-chart-area${inDashboardRightCol ? ' gmv-compare-chart-area--dashboard-right' : ''}${inAnalyticsPage ? ' gmv-compare-chart-area--analytics' : ''}`}
        style={chartAreaStyle}
      >
        {inAnalyticsPage && trendRefetching && loaded ? (
          <div className="gmv-compare-chart-refresh-shade" aria-hidden>
            {t('common.loading')}
          </div>
        ) : null}
        {!loaded && !loadErr ? <div className="gmv-compare-empty">{t('common.loading')}</div> : null}
        {loaded && !hasSeries && !loadErr ? <div className="gmv-compare-empty">{chartEmptyMessage}</div> : null}
        {hasSeries && !loadErr ? (
          <ResponsiveContainer key={`gmv-chart-${chartSize.w}x${plotHeight}`} width="100%" height={plotHeight}>
            <LineChart data={compareRows} margin={lineChartMargin}>
              <CartesianGrid stroke="#1A2A41" strokeDasharray="3 3" />
              <XAxis dataKey="bucket" tick={{ fill: '#8FA3B8', fontSize: 10 }} interval="preserveStartEnd" />
              <YAxis tick={{ fill: '#8FA3B8', fontSize: 11 }} />
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
