import type { GmvCompareSeriesPayload } from '../GmvCompareTrendPanel'

export type GmvChartPoint = { bucket: string; gmv: number; bucket_idx?: number }

/** 实时大屏 gmv-compare 统一结构 */
export type WarRoomGmvCompareNormalized = {
  todaySeries: GmvChartPoint[]
  yesterdaySeries: GmvChartPoint[]
  todayTotal: number | null
  yesterdayTotal: number | null
  gmv_currency: string
  meta?: GmvCompareSeriesPayload['meta']
}

type GmvPoint = { bucket: string; bucket_idx?: number; gmv: number }

function pad2(n: number) {
  return String(Math.max(0, Math.floor(n))).padStart(2, '0')
}

function readFiniteNumber(v: unknown): number | null {
  if (v == null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/** 统一为图表用的小时桶键，如 00:00 */
export function normalizeGmvCompareBucketKey(raw: unknown, bucketIdx?: unknown): string {
  let bucket = String(raw ?? '').trim()
  if (!bucket && bucketIdx != null && Number.isFinite(Number(bucketIdx))) {
    return `${pad2(Number(bucketIdx))}:00`
  }
  if (!bucket) return ''
  const hm = /^(\d{1,2}):(\d{2})$/.exec(bucket)
  if (hm) return `${pad2(Number(hm[1]))}:${hm[2].padStart(2, '0')}`
  if (/^\d{1,2}$/.test(bucket)) return `${pad2(Number(bucket))}:00`
  return bucket
}

/** 小时曲线：从 bucket 或 bucket_idx 得到 0–23 小时索引 */
export function parseGmvCompareHourIndex(bucket: string, bucketIdx?: number): number {
  if (bucketIdx != null && Number.isFinite(bucketIdx)) {
    return Math.min(23, Math.max(0, Math.floor(bucketIdx)))
  }
  const b = normalizeGmvCompareBucketKey(bucket)
  const m = /^(\d{2}):(\d{2})$/.exec(b)
  if (m) return Math.min(23, Math.max(0, Number(m[1])))
  return -1
}

function mergeGmvCompareBody(root: Record<string, unknown>): Record<string, unknown> {
  const nested =
    root.data && typeof root.data === 'object' && !Array.isArray(root.data)
      ? (root.data as Record<string, unknown>)
      : null
  const pointsRoot = (nested?.points ?? root.points) as unknown
  const points =
    pointsRoot && typeof pointsRoot === 'object' && !Array.isArray(pointsRoot)
      ? (pointsRoot as Record<string, unknown>)
      : null

  const summary =
    (nested?.summary ?? root.summary) && typeof (nested?.summary ?? root.summary) === 'object'
      ? ((nested?.summary ?? root.summary) as Record<string, unknown>)
      : null

  return {
    ...root,
    ...(nested ?? {}),
    today: nested?.today ?? root.today ?? points?.today ?? points?.todaySeries,
    yesterday:
      nested?.yesterday ??
      root.yesterday ??
      points?.yesterday ??
      points?.yesterdaySeries ??
      points?.compare,
    summary: summary ?? nested?.summary ?? root.summary,
    todayTotal:
      readFiniteNumber(
        nested?.todayTotal ??
          root.todayTotal ??
          summary?.todayTotal ??
          summary?.today_total,
      ) ?? undefined,
    yesterdayTotal:
      readFiniteNumber(
        nested?.yesterdayTotal ??
          root.yesterdayTotal ??
          summary?.yesterdayTotal ??
          summary?.yesterday_total,
      ) ?? undefined,
    points,
    meta: (nested?.meta ?? root.meta) as GmvCompareSeriesPayload['meta'],
    gmv_currency: String(nested?.gmv_currency ?? root.gmv_currency ?? 'USD'),
  }
}

function coerceSeriesInput(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw
  if (raw && typeof raw === 'object') {
    const entries: unknown[] = []
    for (const [key, val] of Object.entries(raw as Record<string, unknown>)) {
      if (val && typeof val === 'object' && !Array.isArray(val)) {
        entries.push({ bucket: key, ...(val as Record<string, unknown>) })
      } else {
        entries.push({ bucket: key, gmv: val })
      }
    }
    return entries
  }
  return []
}

function extractPointGmv(o: Record<string, unknown>, ctx: string): number | null {
  const gmv = readFiniteNumber(
    o.gmv ?? o.usdGmv ?? o.usd_gmv ?? o.gmv_usd ?? o.value ?? o.total ?? o.amount ?? o.usd,
  )
  if (gmv == null) {
    console.warn('[gmv-compare-normalize] missing gmv on point', {
      ctx,
      keys: Object.keys(o),
      bucket: o.bucket ?? o.hour ?? o.bucket_idx,
    })
  }
  return gmv
}

function normalizePointList(raw: unknown, ctx: string): GmvChartPoint[] {
  const list = coerceSeriesInput(raw)
  const out: GmvChartPoint[] = []
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const o = item as Record<string, unknown>
    const bucketIdx = o.bucket_idx != null ? Number(o.bucket_idx) : undefined
    const bucket = normalizeGmvCompareBucketKey(o.bucket ?? o.hour ?? o.label ?? o.time, bucketIdx)
    if (!bucket) {
      console.warn('[gmv-compare-normalize] missing bucket on point', { ctx, keys: Object.keys(o) })
      continue
    }
    const gmv = extractPointGmv(o, ctx)
    if (gmv == null) continue
    out.push({
      bucket,
      gmv,
      bucket_idx: Number.isFinite(bucketIdx) ? bucketIdx : undefined,
    })
  }
  return out
}

function readCompareTotals(
  body: Record<string, unknown>,
): { todayTotal: number | null; yesterdayTotal: number | null } {
  const summaryRaw =
    body.summary && typeof body.summary === 'object'
      ? (body.summary as Record<string, unknown>)
      : {}

  const todayTotal = readFiniteNumber(
    body.todayTotal ??
      summaryRaw.todayTotal ??
      summaryRaw.today_total ??
      summaryRaw.total,
  )
  const yesterdayTotal = readFiniteNumber(
    body.yesterdayTotal ??
      summaryRaw.yesterdayTotal ??
      summaryRaw.yesterday_total ??
      summaryRaw.compareTotal ??
      summaryRaw.previous ??
      summaryRaw.yesterdayGmv,
  )

  return { todayTotal, yesterdayTotal }
}

function sumSeriesGmv(points: GmvChartPoint[]): number {
  let s = 0
  for (const p of points) {
    if (Number.isFinite(p.gmv)) s += p.gmv
  }
  return Number(s.toFixed(2))
}

/**
 * 实时大屏：/api/dashboard/gmv-compare → 统一曲线 + 同期总额
 */
export function normalizeWarRoomGmvCompare(
  raw: unknown,
  meta?: { url?: string },
): { normalized: WarRoomGmvCompareNormalized | null; debug: Record<string, unknown> } {
  if (!raw || typeof raw !== 'object') {
    return { normalized: null, debug: { url: meta?.url, reason: 'not_object' } }
  }

  const root = raw as Record<string, unknown>
  const body = mergeGmvCompareBody(root)

  const todaySeries = normalizePointList(body.today ?? body.todaySeries, 'today')
  const yesterdaySeries = normalizePointList(
    body.yesterday ?? body.yesterdaySeries ?? body.compare,
    'yesterday',
  )

  let { todayTotal, yesterdayTotal } = readCompareTotals(body)
  if (todayTotal == null && todaySeries.length > 0) todayTotal = sumSeriesGmv(todaySeries)
  if (yesterdayTotal == null && yesterdaySeries.length > 0) {
    yesterdayTotal = sumSeriesGmv(yesterdaySeries)
  }

  const normalized: WarRoomGmvCompareNormalized = {
    todaySeries,
    yesterdaySeries,
    todayTotal,
    yesterdayTotal,
    gmv_currency: String(body.gmv_currency ?? 'USD'),
    meta:
      body.meta && typeof body.meta === 'object'
        ? (body.meta as GmvCompareSeriesPayload['meta'])
        : undefined,
  }

  return {
    normalized,
    debug: {
      url: meta?.url,
      todayPoints: todaySeries.length,
      yesterdayPoints: yesterdaySeries.length,
      todayTotal,
      yesterdayTotal,
      sampleToday: todaySeries[0] ?? null,
      sampleYesterday: yesterdaySeries[0] ?? null,
      topKeys: Object.keys(root).slice(0, 12),
    },
  }
}

/**
 * @deprecated 请用 normalizeWarRoomGmvCompare
 */
export function normalizeGmvCompareSeriesOnly(
  raw: unknown,
  meta?: { url?: string },
): {
  payload: GmvCompareSeriesPayload | null
  yesterdayTotal: number | null
  debug: Record<string, unknown>
} {
  const { normalized, debug } = normalizeWarRoomGmvCompare(raw, meta)
  if (!normalized) {
    return { payload: null, yesterdayTotal: null, debug }
  }
  const payload: GmvCompareSeriesPayload = {
    today: normalized.todaySeries.map((p) => ({ ...p, bucket_idx: undefined })),
    yesterday: normalized.yesterdaySeries.map((p) => ({ ...p, bucket_idx: undefined })),
    gmv_currency: normalized.gmv_currency,
    meta: normalized.meta,
  }
  return {
    payload,
    yesterdayTotal: normalized.yesterdayTotal,
    debug: { ...debug, seriesOnly: true },
  }
}

/** @deprecated 仅数据总览 analytics 使用 */
export type AnalyticsGmvComparePayload = {
  today: GmvPoint[]
  yesterday: GmvPoint[]
  summary: { todayTotal: number; yesterdayTotal: number; changePercent: number | null }
  gmv_currency?: string
  meta?: Record<string, unknown>
}

/**
 * 数据总览 analytics gmv-compare（含 summary totals；禁止实时大屏引用）
 */
export function normalizeGmvCompareResponse(
  raw: unknown,
  meta?: { url?: string },
): { payload: AnalyticsGmvComparePayload | null; debug: Record<string, unknown> } {
  const { normalized, debug } = normalizeWarRoomGmvCompare(raw, meta)
  if (!normalized) {
    return { payload: null, debug: { url: meta?.url, reason: 'not_object' } }
  }

  const changePercent = (() => {
    const body = mergeGmvCompareBody(raw as Record<string, unknown>)
    const summaryRaw =
      body.summary && typeof body.summary === 'object'
        ? (body.summary as Record<string, unknown>)
        : {}
    return readFiniteNumber(summaryRaw.changePercent ?? summaryRaw.change_percent ?? body.changePercent)
  })()

  const payload: AnalyticsGmvComparePayload = {
    today: normalized.todaySeries.map((p) => ({ ...p })),
    yesterday: normalized.yesterdaySeries.map((p) => ({ ...p })),
    summary: {
      todayTotal: normalized.todayTotal != null ? normalized.todayTotal : 0,
      yesterdayTotal: normalized.yesterdayTotal != null ? normalized.yesterdayTotal : 0,
      changePercent,
    },
    gmv_currency: normalized.gmv_currency,
    meta: normalized.meta as Record<string, unknown> | undefined,
  }

  return {
    payload,
    debug: { ...debug, mappedSummary: payload.summary, analyticsOnly: true },
  }
}
