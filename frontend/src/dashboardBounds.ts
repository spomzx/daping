/**
 * 与 backend/lib/dashboardTimeRange.js 一致：用于在请求中附带 startDate/endDate（服务器本地日历）
 */
import type { TimeRangePreset } from './i18n'

function parseYmd(s: string | undefined): { y: number; mo: number; d: number } | null {
  if (s == null || typeof s !== 'string') return null
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.trim())
  if (!m) return null
  const y = Number(m[1])
  const mo = Number(m[2])
  const d = Number(m[3])
  if (!Number.isFinite(y) || mo < 1 || mo > 12 || d < 1 || d > 31) return null
  const dt = new Date(y, mo - 1, d)
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null
  return { y, mo, d }
}

function formatYmd(y: number, mo: number, d: number) {
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

function nowSec() {
  return Math.floor(Date.now() / 1000)
}

function normalizeRange(range: string | undefined): TimeRangePreset {
  const r = String(range == null ? 'today' : range)
    .trim()
    .toLowerCase()
  if (r === 'today' || r === 'yesterday' || r === 'last7' || r === 'last30' || r === 'custom') return r as TimeRangePreset
  return 'today'
}

/** 与后端 getTimeRangeBounds 对齐，用于 query 上的 startDate/endDate */
export function getDashboardBoundsForQuery(
  range: string | undefined,
  startDate: string | undefined,
  endDate: string | undefined,
): { range: TimeRangePreset; startDate: string; endDate: string } {
  const r = normalizeRange(range)
  const n = nowSec()
  const d = new Date()
  const y = d.getFullYear()
  const m = d.getMonth() + 1
  const day = d.getDate()

  if (r === 'today') {
    const sd = formatYmd(y, m, day)
    return { range: 'today', startDate: sd, endDate: sd }
  }
  if (r === 'yesterday') {
    const yd = new Date(y, m - 1, day - 1)
    const sd = formatYmd(yd.getFullYear(), yd.getMonth() + 1, yd.getDate())
    return { range: 'yesterday', startDate: sd, endDate: sd }
  }
  if (r === 'last7') {
    const startD = new Date(y, m - 1, day - 6)
    return {
      range: 'last7',
      startDate: formatYmd(startD.getFullYear(), startD.getMonth() + 1, startD.getDate()),
      endDate: formatYmd(y, m, day),
    }
  }
  if (r === 'last30') {
    const startD = new Date(y, m - 1, day - 29)
    return {
      range: 'last30',
      startDate: formatYmd(startD.getFullYear(), startD.getMonth() + 1, startD.getDate()),
      endDate: formatYmd(y, m, day),
    }
  }
  const s = parseYmd(startDate)
  const e = parseYmd(endDate)
  if (!s || !e) {
    const sd = formatYmd(y, m, day)
    return { range: 'today', startDate: sd, endDate: sd }
  }
  let sd = formatYmd(s.y, s.mo, s.d)
  let ed = formatYmd(e.y, e.mo, e.d)
  if (sd > ed) {
    const t = sd
    sd = ed
    ed = t
  }
  const endSec = Math.min(
    Math.floor(new Date(e.y, e.mo - 1, e.d, 23, 59, 59, 999).getTime() / 1000),
    n,
  )
  const startSec = Math.floor(new Date(s.y, s.mo - 1, s.d, 0, 0, 0, 0).getTime() / 1000)
  if (startSec > endSec) {
    const fallback = formatYmd(y, m, day)
    return { range: 'today', startDate: fallback, endDate: fallback }
  }
  return { range: 'custom', startDate: sd, endDate: ed }
}

export function appendDashboardTimeQuery(
  params: URLSearchParams,
  timeRange: TimeRangePreset,
  customStart: string,
  customEnd: string,
) {
  const b = getDashboardBoundsForQuery(timeRange, customStart, customEnd)
  params.set('range', b.range)
  params.set('startDate', b.startDate)
  params.set('endDate', b.endDate)
}
