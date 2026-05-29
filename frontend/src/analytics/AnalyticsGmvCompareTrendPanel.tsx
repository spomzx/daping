/**
 * Deprecated for War-Room — 仅数据总览 / Analytics 使用。
 * 允许 /api/analytics/gmv-compare 与 compare.summary KPI。
 * 实时大屏禁止引用本组件。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  XAxis,
  YAxis,
} from 'recharts'
import {
  buildGmvCompareContractFromProps,
  contractStableQueryKey,
} from '../lib/dashboardFilterContract'
import {
  beginDashboardQuery,
  isAbortedFetchError,
  shouldApplyDashboardQuery,
} from '../lib/dashboardQueryGuard'
import type { TimeRangePreset } from '../i18n'
import { formatMoneyByCurrency } from '../currencyDisplay'
import { useI18n } from '../i18n'
import { useChartResize } from '../hooks/useChartResize'
import { normalizeGmvCompareResponse } from '../lib/normalizeGmvCompareResponse'
import type { GmvCompareStatusFilter } from '../GmvCompareTrendPanel'
import {
  GMV_COMPARE_TODAY_STROKE,
  GMV_COMPARE_YESTERDAY_STROKE,
} from '../GmvCompareTrendPanel'
import { fetchAnalyticsJson } from '../services/api/analytics'

export function AnalyticsGmvCompareTrendPanel({
  market,
  shopId,
  status,
  groupBy = 'hour',
  analyticsHours = 24,
  title,
  shopScopeLabel,
  showGranularityControl = false,
  onGroupByChange,
  emptyTrendLabel,
  range,
  startDate,
  endDate,
}: {
  market: string
  shopId: string
  status: GmvCompareStatusFilter
  groupBy?: 'hour' | 'day'
  analyticsHours?: number
  title?: string
  shopScopeLabel?: string
  showGranularityControl?: boolean
  onGroupByChange?: (next: 'hour' | 'day') => void
  emptyTrendLabel?: string
  range?: string
  startDate?: string
  endDate?: string
}) {
  const { t } = useI18n()
  const [payload, setPayload] = useState<ReturnType<typeof normalizeGmvCompareResponse>['payload']>(null)
  const [loaded, setLoaded] = useState(false)
  const [loadErr, setLoadErr] = useState<string | null>(null)
  const latestKeyRef = useRef('')
  const abortRef = useRef<AbortController | null>(null)
  const chartAreaRef = useRef<HTMLDivElement>(null)

  const contract = useMemo(
    () =>
      buildGmvCompareContractFromProps({
        shopId,
        market,
        orderFilter: status,
        timeRange: (range || 'today') as TimeRangePreset,
        startDate: startDate || '',
        endDate: endDate || '',
      }),
    [shopId, market, status, range, startDate, endDate],
  )

  const queryKey = useMemo(
    () => `${contractStableQueryKey(contract)}|analytics|groupBy=${groupBy}|hours=${analyticsHours}`,
    [contract, groupBy, analyticsHours],
  )

  useEffect(() => {
    const { key: requestKey } = beginDashboardQuery(latestKeyRef, abortRef, queryKey)
    void (async () => {
      try {
        const query: Record<string, string> = {
          orderFilter: contract.orderFilter,
          hours: String(analyticsHours),
          group_by: groupBy,
          range: contract.timeRange,
          startDate: contract.startDate,
          endDate: contract.endDate,
        }
        if (contract.market !== 'ALL') query.market = contract.market
        if (contract.shopId !== 'all') query.shopId = contract.shopId
        const url = `/api/analytics/gmv-compare?${new URLSearchParams(query)}`
        const raw = await fetchAnalyticsJson<Record<string, unknown>>('/api/analytics/gmv-compare', query)
        if (!shouldApplyDashboardQuery(latestKeyRef, requestKey)) return
        setPayload(normalizeGmvCompareResponse(raw, { url }).payload)
        setLoadErr(null)
        setLoaded(true)
      } catch (e) {
        if (isAbortedFetchError(e)) return
        if (!shouldApplyDashboardQuery(latestKeyRef, requestKey)) return
        setPayload(null)
        setLoadErr(String((e as Error)?.message || e))
        setLoaded(true)
      }
    })()
    return () => {
      abortRef.current?.abort()
      abortRef.current = null
    }
  }, [queryKey, contract, groupBy, analyticsHours])

  const rows = useMemo(() => {
    if (!payload) return []
    const todayMap = new Map<string, number>()
    const yMap = new Map<string, number>()
    for (const p of payload.today) todayMap.set(p.bucket, Number(p.gmv) || 0)
    for (const p of payload.yesterday) yMap.set(p.bucket, Number(p.gmv) || 0)
    const keys = new Set([...todayMap.keys(), ...yMap.keys()])
    return [...keys].sort().map((bucket) => ({
      bucket,
      todayGmv: todayMap.get(bucket) ?? 0,
      yesterdayGmv: yMap.get(bucket) ?? 0,
      tooltipTitle: bucket,
    }))
  }, [payload])

  const summary = payload?.summary ?? { todayTotal: 0, yesterdayTotal: 0, changePercent: null }
  const chartSize = useChartResize(chartAreaRef, [loaded, rows.length])
  const yoy =
    summary.changePercent == null
      ? t('common.dash')
      : `${summary.changePercent >= 0 ? '+' : ''}${summary.changePercent.toFixed(2)}%`

  const panelTitle =
    shopScopeLabel && shopId !== 'all' ? `${title ?? t('chart.gmvTrendTitle')}｜${shopScopeLabel}` : (title ?? t('chart.gmvTrendTitle'))

  return (
    <div className="gmv-compare-trend-inner gmv-compare-trend-inner--analytics">
      {showGranularityControl && onGroupByChange ? (
        <div className="analytics-trend-title-row">
          <h3 className="analytics-trend-title-row__h">{panelTitle}</h3>
        </div>
      ) : (
        <h3>{panelTitle}</h3>
      )}
      <div className="gmv-compare-summary-strip" style={{ display: 'flex', flexWrap: 'wrap', gap: 20, marginBottom: 12, fontSize: 14 }}>
        <span>
          {t('chart.todayGmv')}：<strong>{formatMoneyByCurrency('USD', summary.todayTotal)}</strong>
        </span>
        <span>
          {t('chart.yesterdaySamePeriod')}：<strong>{formatMoneyByCurrency('USD', summary.yesterdayTotal)}</strong>
        </span>
        <span>{t('chart.yoy')}：{yoy}</span>
      </div>
      <div ref={chartAreaRef} className="gmv-compare-chart-area gmv-compare-chart-area--analytics" style={{ width: '100%', minHeight: 320, height: chartSize.h || 320 }}>
        {!loaded && !loadErr ? <div className="gmv-compare-empty">{t('common.loading')}</div> : null}
        {loaded && !loadErr && rows.length === 0 ? (
          <div className="gmv-compare-empty">{emptyTrendLabel ?? t('empty.trend')}</div>
        ) : null}
        {rows.length > 0 ? (
          <ResponsiveContainer width="100%" height={chartSize.h || 320}>
            <LineChart data={rows}>
              <CartesianGrid stroke="#1A2A41" strokeDasharray="3 3" />
              <XAxis dataKey="bucket" tick={{ fill: '#8FA3B8', fontSize: 10 }} />
              <YAxis tick={{ fill: '#8FA3B8', fontSize: 11 }} />
              <Legend />
              <Line type="monotone" dataKey="todayGmv" name={t('chart.todayGmvSeries')} stroke={GMV_COMPARE_TODAY_STROKE} dot={false} />
              <Line type="monotone" dataKey="yesterdayGmv" name={t('chart.yesterdayGmvSeries')} stroke={GMV_COMPARE_YESTERDAY_STROKE} strokeDasharray="10 6" dot={false} />
            </LineChart>
          </ResponsiveContainer>
        ) : null}
      </div>
    </div>
  )
}
