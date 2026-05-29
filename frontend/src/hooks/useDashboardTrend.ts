import { useEffect, useRef, useState } from 'react'
import {
  applyStableTrendPayload,
  isSnapshotCacheSource,
  shouldRetainTrendDisplay,
  trendRefreshRetryDelayMs,
  type DashboardTrendCacheHints,
} from '../lib/dashboardTrendCache'
import {
  dashboardQueryKeyString,
  dashboardQueryKeepPreviousOptions,
  getDashboardQueryCache,
  setDashboardQueryCache,
  type DashboardTrendEndpoint,
} from '../lib/dashboardQueries'
import { logDashboardUi } from '../lib/dashboardUiDebug'
import {
  beginDashboardQuery,
  isAbortedFetchError,
  shouldApplyDashboardQuery,
} from '../lib/dashboardQueryGuard'

export type UseDashboardTrendOptions<T> = {
  endpoint: DashboardTrendEndpoint
  /** 稳定 tuple（useMemo） */
  queryKey: readonly (string | number)[]
  timeRange: string
  enabled?: boolean
  liveRefreshNonce?: number
  fetcher: (signal: AbortSignal) => Promise<T>
  pointCount: (data: T) => number
  readHints?: (data: T) => DashboardTrendCacheHints
}

export type UseDashboardTrendResult<T> = {
  displayData: T | null
  /** 仅首屏无缓存时为 true */
  isInitialLoading: boolean
  isFetching: boolean
  trendUpdating: boolean
  error: string | null
  loaded: boolean
  hints: DashboardTrendCacheHints
  keepPreviousData: true
}

export function useDashboardTrend<T>(opts: UseDashboardTrendOptions<T>): UseDashboardTrendResult<T> {
  const {
    endpoint,
    queryKey,
    timeRange,
    enabled = true,
    liveRefreshNonce = 0,
    fetcher,
    pointCount,
    readHints,
  } = opts

  const queryKeyStr = dashboardQueryKeyString(queryKey)
  const cacheOpts = dashboardQueryKeepPreviousOptions(timeRange)

  const previousStableRef = useRef<T | null>(null)
  const hasEverDisplayedRef = useRef(false)
  const latestKeyRef = useRef('')
  const abortRef = useRef<AbortController | null>(null)

  const [displayData, setDisplayData] = useState<T | null>(() =>
    getDashboardQueryCache<T>(queryKeyStr) ?? null,
  )
  const [isFetching, setIsFetching] = useState(false)
  const [trendUpdating, setTrendUpdating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(() => getDashboardQueryCache<T>(queryKeyStr) != null)
  const [hints, setHints] = useState<DashboardTrendCacheHints>({})

  const displayDataRef = useRef(displayData)
  displayDataRef.current = displayData

  useEffect(() => {
    if (!enabled) return

    const cached = getDashboardQueryCache<T>(queryKeyStr)
    const reusedPrevious = cached != null
    if (reusedPrevious) {
      previousStableRef.current = cached
      hasEverDisplayedRef.current = true
      setDisplayData(cached)
      setLoaded(true)
      setIsFetching(true)
      setTrendUpdating(false)
    } else if (previousStableRef.current != null) {
      setDisplayData(previousStableRef.current)
      setIsFetching(true)
    }

    logDashboardUi(endpoint, {
      reusedPrevious,
      keepPreviousData: true,
      chartRemounted: false,
      fetching: true,
      cacheHit: reusedPrevious,
      queryKey: queryKeyStr,
    })

    let retryTimer: ReturnType<typeof setTimeout> | null = null

    const runFetch = async (isRetry: boolean) => {
      const hadDisplay =
        hasEverDisplayedRef.current ||
        (displayDataRef.current != null && pointCount(displayDataRef.current) > 0)

      const { key: requestKey, signal } = beginDashboardQuery(latestKeyRef, abortRef, queryKeyStr)
      if (!isRetry) {
        setIsFetching(true)
        setError(null)
        if (!hadDisplay) setTrendUpdating(false)
      }

      try {
        const raw = await fetcher(signal)
        if (!shouldApplyDashboardQuery(latestKeyRef, requestKey, endpoint)) return

        const pts = raw != null ? pointCount(raw) : 0
        const nextHints = raw != null && readHints ? readHints(raw) : {}
        setHints(nextHints)

        const { display, retainedPrevious } = applyStableTrendPayload(
          previousStableRef,
          raw,
          pts,
          nextHints,
        )

        if (display != null && (pts > 0 || !shouldRetainTrendDisplay(nextHints, pts))) {
          setDisplayData(display)
          if (pts > 0) {
            setDashboardQueryCache(queryKeyStr, display)
            hasEverDisplayedRef.current = true
          }
        }

        const pending = shouldRetainTrendDisplay(nextHints, pts)
        setTrendUpdating(
          pending || Boolean(nextHints.refreshPending) || Boolean(nextHints.cacheMiss),
        )

        if (pending && !isRetry) {
          retryTimer = setTimeout(() => {
            if (latestKeyRef.current !== queryKeyStr) return
            void runFetch(true)
          }, trendRefreshRetryDelayMs())
        } else if (nextHints.refreshPending && !isRetry && pts > 0) {
          retryTimer = setTimeout(() => {
            if (latestKeyRef.current !== queryKeyStr) return
            void runFetch(true)
          }, trendRefreshRetryDelayMs())
        }

        logDashboardUi(endpoint, {
          reusedPrevious: retainedPrevious,
          keepPreviousData: true,
          chartRemounted: false,
          fetching: false,
          cacheHit: isSnapshotCacheSource(nextHints) || reusedPrevious,
          queryKey: queryKeyStr,
        })

        setError(null)
        setLoaded(true)
      } catch (e) {
        if (isAbortedFetchError(e)) return
        if (!shouldApplyDashboardQuery(latestKeyRef, requestKey, endpoint)) return
        if (!hasEverDisplayedRef.current) {
          setDisplayData(null)
          setTrendUpdating(false)
        }
        setError(String((e as Error)?.message || e))
        setLoaded(true)
      } finally {
        if (!shouldApplyDashboardQuery(latestKeyRef, requestKey, endpoint)) return
        const pts =
          displayDataRef.current != null ? pointCount(displayDataRef.current) : 0
        if (pts > 0 || !retryTimer) setIsFetching(false)
      }
    }

    void runFetch(false)

    return () => {
      if (retryTimer) clearTimeout(retryTimer)
      abortRef.current?.abort()
      abortRef.current = null
    }
  // fetcher/readHints 由调用方 useCallback 固定
  // eslint-disable-next-line react-hooks/exhaustive-deps -- queryKeyStr 已覆盖筛选维度
  }, [queryKeyStr, enabled, liveRefreshNonce, endpoint, timeRange])

  const isInitialLoading =
    !hasEverDisplayedRef.current &&
    !previousStableRef.current &&
    (isFetching || !loaded) &&
    (displayData == null || pointCount(displayData) === 0)

  return {
    displayData,
    isInitialLoading,
    isFetching,
    trendUpdating,
    error,
    loaded,
    hints,
    keepPreviousData: cacheOpts.keepPreviousData,
  }
}
