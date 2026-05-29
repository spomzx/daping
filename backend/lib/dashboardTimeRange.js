'use strict';

/**
 * 大屏订单时间范围（按服务器本地时区的自然日）
 */

function normalizeRange(range) {
  const r = String(range == null ? 'today' : range)
    .trim()
    .toLowerCase();
  if (r === 'today' || r === 'yesterday' || r === 'last7' || r === 'last30' || r === 'custom') return r;
  return 'today';
}

function parseYmd(s) {
  if (s == null || typeof s !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (!Number.isFinite(y) || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const dt = new Date(y, mo - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null;
  return { y, mo, d };
}

function localDayStartSec(y, mo, d) {
  return Math.floor(new Date(y, mo - 1, d, 0, 0, 0, 0).getTime() / 1000);
}

function localDayEndSec(y, mo, d) {
  return Math.floor(new Date(y, mo - 1, d, 23, 59, 59, 999).getTime() / 1000);
}

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

function formatYmd(y, mo, d) {
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/**
 * @param {string} range
 * @param {string} [startDate]
 * @param {string} [endDate]
 * @returns {{ range: string, startSec: number, endSec: number, startDate?: string, endDate?: string, customInvalid?: boolean }}
 */
function getTimeRangeBounds(range, startDate, endDate) {
  const r = normalizeRange(range);
  const n = nowSec();
  const d = new Date();
  const y = d.getFullYear();
  const m = d.getMonth() + 1;
  const day = d.getDate();

  if (r === 'today') {
    return {
      range: 'today',
      startSec: localDayStartSec(y, m, day),
      endSec: n,
      startDate: formatYmd(y, m, day),
      endDate: formatYmd(y, m, day),
    };
  }
  if (r === 'yesterday') {
    const yd = new Date(y, m - 1, day - 1);
    const yy = yd.getFullYear();
    const mm = yd.getMonth() + 1;
    const dd = yd.getDate();
    return {
      range: 'yesterday',
      startSec: localDayStartSec(yy, mm, dd),
      endSec: localDayEndSec(yy, mm, dd),
      startDate: formatYmd(yy, mm, dd),
      endDate: formatYmd(yy, mm, dd),
    };
  }
  if (r === 'last7') {
    const startD = new Date(y, m - 1, day - 6);
    const sy = startD.getFullYear();
    const sm = startD.getMonth() + 1;
    const sd = startD.getDate();
    return {
      range: 'last7',
      startSec: localDayStartSec(sy, sm, sd),
      endSec: n,
      startDate: formatYmd(sy, sm, sd),
      endDate: formatYmd(y, m, day),
    };
  }
  /** 含今日在内共 30 个自然日（与 last7 一致：起日 00:00 至当前时刻） */
  if (r === 'last30') {
    const startD = new Date(y, m - 1, day - 29);
    const sy = startD.getFullYear();
    const sm = startD.getMonth() + 1;
    const sd = startD.getDate();
    return {
      range: 'last30',
      startSec: localDayStartSec(sy, sm, sd),
      endSec: n,
      startDate: formatYmd(sy, sm, sd),
      endDate: formatYmd(y, m, day),
    };
  }
  const s = parseYmd(startDate);
  const e = parseYmd(endDate);
  if (!s || !e) {
    return {
      range: 'today',
      startSec: localDayStartSec(y, m, day),
      endSec: n,
      startDate: formatYmd(y, m, day),
      endDate: formatYmd(y, m, day),
      customInvalid: true,
    };
  }
  let startSec = localDayStartSec(s.y, s.mo, s.d);
  let endSec = localDayEndSec(e.y, e.mo, e.d);
  if (startSec > endSec) {
    const t = startSec;
    startSec = endSec;
    endSec = t;
  }
  endSec = Math.min(endSec, n);
  if (startSec > endSec) {
    return {
      range: 'today',
      startSec: localDayStartSec(y, m, day),
      endSec: n,
      startDate: formatYmd(y, m, day),
      endDate: formatYmd(y, m, day),
      customInvalid: true,
    };
  }
  return {
    range: 'custom',
    startSec,
    endSec,
    startDate: formatYmd(s.y, s.mo, s.d),
    endDate: formatYmd(e.y, e.mo, e.d),
  };
}

/**
 * 与 `/api/dashboard` summary「今日」同一套服务器本地自然日边界（见 {@link getTimeRangeBounds}），
 * 用于 gmv-compare 24h 小时对比，避免与 `Date.now()` 分桶和 MySQL FROM_UNIXTIME 混用产生「今日全 0」。
 * @returns {{
 *   compareMode: 'calendar_intraday',
 *   todayStartMs: number,
 *   yesterdayStartMs: number,
 *   yesterdayTsEnd: number,
 *   maxHourIdx: number,
 *   sqlFromMs: number,
 *   sqlFromEpochSec: number,
 *   sqlUntilEpochSec: number,
 *   nowBoundMs: number,
 * }}
 */
function getTodayYesterdayIntradayCompareEpochBounds() {
  const tb = getTimeRangeBounds('today', '', '');
  const todayStartSec = tb.startSec;
  const todayEndSec = tb.endSec;
  const d = new Date(todayStartSec * 1000);
  const yd = new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1);
  const yesterdayStartSec = localDayStartSec(yd.getFullYear(), yd.getMonth() + 1, yd.getDate());
  const elapsed = Math.max(0, todayEndSec - todayStartSec);
  const yesterdayEndSec = yesterdayStartSec + elapsed;
  const todayStartMs = todayStartSec * 1000;
  const nowBoundMs = todayEndSec * 1000;
  const yesterdayStartMs = yesterdayStartSec * 1000;
  const yesterdayTsEnd = yesterdayEndSec * 1000;
  const maxHourIdx = Math.min(23, Math.max(0, Math.floor(elapsed / 3600)));
  return {
    compareMode: 'calendar_intraday',
    todayStartMs,
    yesterdayStartMs,
    yesterdayTsEnd,
    maxHourIdx,
    sqlFromMs: yesterdayStartMs,
    sqlFromEpochSec: yesterdayStartSec,
    sqlUntilEpochSec: todayEndSec,
    nowBoundMs,
  };
}

module.exports = {
  normalizeRange,
  getTimeRangeBounds,
  parseYmd,
  getTodayYesterdayIntradayCompareEpochBounds,
};
