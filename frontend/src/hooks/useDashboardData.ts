import { useEffect, useRef, useState } from 'react'
import {
  dashboardQueryKeyString,
  dashboardQueryKeepPreviousOptions,
  getDashboardQueryCache,
  setDashboardQueryCache,
} from '../lib/dashboardQueries'
import { logDashboardUi } from '../lib/dashboardUiDebug'
import type { DashboardUiEndpoint } from '../lib/dashboardQueries'

export type UseDashboardDataOptions<T> = {
  endpoint: DashboardUiEndpoint
  queryKey: readonly (string | number)[]
  timeRange: string
  enabled?: boolean
  fetcher: () => Promise<T>
  /** 有有效数据才写入 cache / 替换 UI */
  isValid?: (data: T) => boolean
}

export type UseDashboardDataResult<T> = {
  data: T | null
  isInitialLoading: boolean
  isFetching: boolean
  keepPreviousData: true
}

/**
 * 非趋势模块：keepPreviousData + 全局 query 缓存（ranking / summary 等）
 */
export function useDashboardData<T>(opts: UseDashboardDataOptions<T>): UseDashboardDataResult<T> {
  const { endpoint, queryKey, timeRange, enabled = true, fetcher, isValid } = opts
  const queryKeyStr = dashboardQueryKeyString(queryKey)
  const cacheOpts = dashboardQueryKeepPreviousOptions(timeRange)
  const previousStableRef = useRef<T | null>(getDashboardQueryCache<T>(queryKeyStr) ?? null)
  const hasEverRef = useRef(previousStableRef.current != null)

  const [data, setData] = useState<T | null>(previousStableRef.current)
  const [isFetching, setIsFetching] = useState(false)
  const [loaded, setLoaded] = useState(hasEverRef.current)

  useEffect(() => {
    if (!enabled) return
    const cached = getDashboardQueryCache<T>(queryKeyStr)
    const reusedPrevious = cached != null
    if (reusedPrevious) {
      previousStableRef.current = cached
      hasEverRef.current = true
      setData(cached)
      setLoaded(true)
    }
    logDashboardUi(endpoint, {
      reusedPrevious,
      keepPreviousData: true,
      chartRemounted: false,
      fetching: true,
      cacheHit: reusedPrevious,
      queryKey: queryKeyStr,
    })

    let cancelled = false
    setIsFetching(true)
    void fetcher()
      .then((next) => {
        if (cancelled) return
        const ok = isValid ? isValid(next) : next != null
        if (ok) {
          previousStableRef.current = next
          hasEverRef.current = true
          setDashboardQueryCache(queryKeyStr, next)
          setData(next)
        } else if (previousStableRef.current != null) {
          setData(previousStableRef.current)
        }
        setLoaded(true)
        logDashboardUi(endpoint, {
          reusedPrevious: !ok && previousStableRef.current != null,
          keepPreviousData: true,
          chartRemounted: false,
          fetching: false,
          cacheHit: reusedPrevious,
          queryKey: queryKeyStr,
        })
      })
      .catch(() => {
        if (!cancelled && previousStableRef.current != null) setData(previousStableRef.current)
        setLoaded(true)
      })
      .finally(() => {
        if (!cancelled) setIsFetching(false)
      })

    return () => {
      cancelled = true
    }
  }, [queryKeyStr, enabled, endpoint, fetcher, isValid, timeRange])

  const isInitialLoading = !hasEverRef.current && (isFetching || !loaded)

  return {
    data,
    isInitialLoading,
    isFetching,
    keepPreviousData: cacheOpts.keepPreviousData,
  }
}
