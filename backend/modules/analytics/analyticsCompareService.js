'use strict';

/**
 * GMV 对比趋势：SaaS 主路径仅 MySQL + exchange_rates（不读 orders-cache / gmv-cache）。
 * `hours=24` 按小时时今日/昨日均来自 orders 表；legacy cache 见 server.js `/api/dashboard`。
 */

const { getMysqlPool } = require('../../db/mysqlPool');
const {
  normalizeCurrency,
  getCurrencyByMarket,
  convertToUSDSync,
  preloadUsdRates,
} = require('../../lib/currency');
const { normalizeOrderFilter } = require('../../lib/orderFilter');
const {
  buildAnalyticsFilter,
  orderAnalyticsEventTimeExpr,
  resolveShopClause,
} = require('../../lib/analyticsFilter');
const {
  getTodayYesterdayIntradayCompareEpochBounds,
  normalizeRange,
} = require('../../lib/dashboardTimeRange');
const { logAnalyticsQuerySlow } = require('../../lib/analyticsQueryLog');
const { normalizeBaseCurrency, normalizeTargetCurrency } = require('../../lib/rates');

const CACHE_TTL_MS = Math.min(
  120000,
  Math.max(15000, Number(process.env.ANALYTICS_GMV_COMPARE_TTL_MS || process.env.ANALYTICS_CACHE_TTL_MS || 60000)),
);

function requireMysqlPool() {
  const pool = getMysqlPool();
  if (!pool) {
    const err = new Error('mysql_unavailable');
    err.code = 'mysql_unavailable';
    throw err;
  }
  return pool;
}
/** @type {Map<string, { exp: number, val: unknown }>} */
const memCache = new Map();

function cacheGet(key) {
  const e = memCache.get(key);
  if (!e) return undefined;
  if (Date.now() > e.exp) {
    memCache.delete(key);
    return undefined;
  }
  return e.val;
}

function cacheSet(key, val) {
  memCache.set(key, { val, exp: Date.now() + CACHE_TTL_MS });
}

function cacheKey(tenantId, parts) {
  return `gmv-compare:${tenantId}:${JSON.stringify(parts)}`;
}

/** 合并 query：shopId / selectedShopId、group_by、与看板一致的 range 等 */
function normalizeGmvCompareQuery(q) {
  const src = q && typeof q === 'object' ? q : {};
  const shopMerged = src.shop_id ?? src.shopId ?? src.selectedShopId;
  const groupMerged = src.groupBy ?? src.group_by;
  return {
    ...src,
    shop_id: shopMerged,
    groupBy: groupMerged,
  };
}

function safeNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** mysql2 行上可能的金额列（避免取错字段导致 Number(undefined)=0） */
function pickMysqlOrderAmount(r) {
  if (!r || typeof r !== 'object') return 0;
  const v =
    r.total_amount ??
    r.TOTAL_AMOUNT ??
    r.amount ??
    r.order_amount ??
    r.payment_amount ??
    r.gmv ??
    r.original_amount ??
    r.amount_base ??
    r.amount_target;
  return safeNum(v);
}

function gmvCompareDebugEnabled() {
  return String(process.env.GMV_COMPARE_DEBUG || '').trim() === '1';
}

/**
 * @param {unknown[]} rows
 * @param {string} label
 */
function logGmvCompareRowDebug(rows, label) {
  if (!gmvCompareDebugEnabled()) return;
  const first = Array.isArray(rows) && rows.length > 0 && rows[0] && typeof rows[0] === 'object' ? rows[0] : null;
  const keys = first ? Object.keys(first) : [];
  const firstAmt = first ? pickMysqlOrderAmount(first) : 0;
  let sumAmt = 0;
  if (Array.isArray(rows)) {
    for (const row of rows) sumAmt += pickMysqlOrderAmount(row);
  }
  console.log('[gmv-compare-debug]', label, {
    rowCount: Array.isArray(rows) ? rows.length : 0,
    firstRowKeys: keys,
    firstRowPickedAmount: firstAmt,
    sumPickedAmount: Number(sumAmt.toFixed(4)),
  });
}

/**
 * MySQL 行按「锚定日 0 点」的小时桶聚合并折 USD（与主循环 rollup 一致）。
 * @param {unknown[]} rows
 * @param {number} anchorStartMs
 * @param {number} rangeEndMs inclusive
 * @param {number} maxHourIdx
 * @param {Record<string, number>} rates
 */
/**
 * 自然日分时：按本地时钟小时分桶（与 X 轴 00:00… 对齐）
 * @param {number} tsMs
 * @param {number} anchorStartMs
 * @param {number} maxHourIdx
 */
function calendarHourBucketIdx(tsMs, anchorStartMs, maxHourIdx) {
  const anchor = new Date(anchorStartMs);
  const d = new Date(tsMs);
  if (
    d.getFullYear() !== anchor.getFullYear() ||
    d.getMonth() !== anchor.getMonth() ||
    d.getDate() !== anchor.getDate()
  ) {
    return -1;
  }
  const h = d.getHours();
  if (h < 0) return -1;
  return h > maxHourIdx ? maxHourIdx : h;
}

function aggregateMysqlHourWindowToUsdSeries(rows, anchorStartMs, rangeEndMs, maxHourIdx, rates, bucketMode = 'calendar') {
  /** @type {Map<string, number>} */
  const nativeMap = new Map();
  for (const r of rows) {
    if (!r || typeof r !== 'object') continue;
    const ts = r.ts instanceof Date ? r.ts.getTime() : new Date(r.ts).getTime();
    if (!Number.isFinite(ts)) continue;
    if (ts < anchorStartMs || ts > rangeEndMs) continue;
    const idx =
      bucketMode === 'calendar'
        ? calendarHourBucketIdx(ts, anchorStartMs, maxHourIdx)
        : Math.floor((ts - anchorStartMs) / 3600000);
    if (idx < 0 || idx > maxHourIdx) continue;
    const cur =
      normalizeCurrency(String(r.currency_key || '').trim()) ||
      getCurrencyByMarket(String(r.market || '')) ||
      'USD';
    const amt = pickMysqlOrderAmount(r);
    const b = pad2(idx);
    const k = `${b}\x1f${cur}`;
    nativeMap.set(k, (nativeMap.get(k) || 0) + amt);
  }

  /** @type {Map<string, number>} */
  const usd = new Map();
  for (const [k, nativeSum] of nativeMap.entries()) {
    const [bucket, cur] = k.split('\x1f');
    const rate = rates[cur] || 0;
    const u = convertToUSDSync(nativeSum, cur, rate);
    usd.set(bucket, (usd.get(bucket) || 0) + u);
  }

  const todayArr = [];
  let total = 0;
  for (let i = 0; i <= maxHourIdx; i++) {
    const b = pad2(i);
    const gmv = Number((usd.get(b) || 0).toFixed(2));
    todayArr.push({ bucket: `${b}:00`, bucket_idx: i, gmv });
    total += gmv;
  }
  const nonzeroBuckets = todayArr.filter((p) => safeNum(p.gmv) > 0).length;
  return { todayArr, todayTotal: Number(total.toFixed(2)), nonzeroBuckets };
}

function pad2(n) {
  return String(Math.max(0, Math.floor(n))).padStart(2, '0');
}

/**
 * 按小时对比的时间窗（与分桶对齐）。
 * - hours===24：与 {@link getTimeRangeBounds}('today') 同一套服务器本地自然日 00:00～当前秒，
 *   昨日段为昨日 00:00～与「今日已过时长」同一时刻（见 {@link getTodayYesterdayIntradayCompareEpochBounds}）。
 * - hours>24：滑动「最近 hours 小时」vs 上一段同期，昨日段裁剪到与今日段等长且已过去的时间。
 * @param {number} hours
 * @param {number} nowMs 仅 hours≠24 时使用；24 小时对比以 dashboard 今日上界为准
 */
function computeHourCompareWindows(hours, nowMs) {
  const h = Math.min(720, Math.max(1, hours));
  if (h === 24) {
    const w = getTodayYesterdayIntradayCompareEpochBounds();
    return {
      compareMode: w.compareMode,
      todayStartMs: w.todayStartMs,
      yesterdayStartMs: w.yesterdayStartMs,
      yesterdayTsEnd: w.yesterdayTsEnd,
      maxHourIdx: w.maxHourIdx,
      sqlFromMs: w.sqlFromMs,
      sqlFromEpochSec: w.sqlFromEpochSec,
      sqlUntilEpochSec: w.sqlUntilEpochSec,
      nowBoundMs: w.nowBoundMs,
    };
  }
  const todayStartMs = nowMs - h * 3600000;
  const yesterdayStartMs = nowMs - 2 * h * 3600000;
  const elapsedInTodayWindow = Math.max(0, nowMs - todayStartMs);
  const maxHourIdx = Math.min(h - 1, Math.floor(elapsedInTodayWindow / 3600000));
  const yesterdayTsEnd = yesterdayStartMs + elapsedInTodayWindow;
  return {
    compareMode: 'rolling_hours',
    todayStartMs,
    yesterdayStartMs,
    yesterdayTsEnd,
    maxHourIdx: Math.max(0, maxHourIdx),
    sqlFromMs: yesterdayStartMs,
    sqlFromEpochSec: Math.floor(yesterdayStartMs / 1000),
    sqlUntilEpochSec: Math.floor(nowMs / 1000),
    nowBoundMs: nowMs,
  };
}

/**
 * @param {number} tenantId
 * @param {{ market?: string, shop_id?: string, hours?: number, groupBy?: string, status?: string }} q
 * @param {{ skipShopGate?: boolean, skipTenant?: boolean }} [opts]
 */
async function getGmvCompare(tenantId, q, opts = {}) {
  const pool = requireMysqlPool();
  q = normalizeGmvCompareQuery(q);

  try {
    return await getGmvCompareInner(tenantId, q, opts, pool);
  } catch (e) {
    console.error('[gmv-compare] failed', e?.message || e);
    const hours = Math.min(720, Math.max(1, Number(q.hours) || 24));
    const groupBy = String(q.groupBy || 'hour').toLowerCase() === 'day' ? 'day' : 'hour';
    const orderFilter = normalizeOrderFilter(q.status ?? q.orderFilter);
    const empty = buildEmptyPayload(hours, groupBy, orderFilter);
    empty.meta.emptyReason = 'query_failed';
    empty.meta.errorMessage = String(e?.message || e).slice(0, 200);
    return empty;
  }
}

async function getGmvCompareInner(tenantId, q, opts = {}, poolIn) {
  const pool = poolIn || requireMysqlPool();

  const { strictAnalyticsFilterOpts } = require('../../lib/resolveTenantShop');
  const analyticsScope = strictAnalyticsFilterOpts();

  const hours = Math.min(720, Math.max(1, Number(q.hours) || 24));
  const groupBy = String(q.groupBy || 'hour').toLowerCase() === 'day' ? 'day' : 'hour';
  const orderFilter = normalizeOrderFilter(q.status ?? q.orderFilter);
  const baseQ = normalizeBaseCurrency(q.baseCurrency);
  const targetQ = normalizeTargetCurrency(q.targetCurrency);
  const rangeNorm = normalizeRange(q.range ?? 'today');
  const startDateQ = q.startDate != null ? String(q.startDate).trim() : '';
  const endDateQ = q.endDate != null ? String(q.endDate).trim() : '';
  const ck = cacheKey(tenantId, {
    market: String(q.market ?? '').trim() || 'ALL',
    shop_id: String(q.shop_id ?? '').trim() || 'all',
    hours,
    groupBy,
    status: orderFilter,
    granularity: groupBy,
    boundsVer: 'dash-cache-today-v4',
    base: baseQ,
    target: targetQ,
    range: rangeNorm,
    startDate: startDateQ,
    endDate: endDateQ,
  });
  const hit = cacheGet(ck);
  if (hit !== undefined) return hit;

  const shopRaw = q.shop_id;
  let mysqlShopResolved = true;
  if (shopRaw != null && String(shopRaw).trim() !== '' && String(shopRaw).trim().toLowerCase() !== 'all') {
    const sp = await resolveShopClause(pool, tenantId, shopRaw, 'o');
    if (sp == null) mysqlShopResolved = false;
  }

  const nowMs = Date.now();
  let todayStartMs;
  let yesterdayStartMs;
  /** 昨日段上界：按小时为 inclusive 时间戳；按天为今日窗起点（exclusive 与旧逻辑一致） */
  let yesterdaySegmentEndMs;
  /** @type {null | { compareMode: string; todayStartMs: number; yesterdayStartMs: number; yesterdayTsEnd: number; maxHourIdx: number; sqlFromMs: number; sqlFromEpochSec?: number; sqlUntilEpochSec?: number; nowBoundMs?: number }} */
  let hourWin = null;

  if (groupBy === 'hour') {
    hourWin = computeHourCompareWindows(hours, nowMs);
    todayStartMs = hourWin.todayStartMs;
    yesterdayStartMs = hourWin.yesterdayStartMs;
    yesterdaySegmentEndMs = hourWin.yesterdayTsEnd;
  } else {
    todayStartMs = nowMs - hours * 3600000;
    yesterdayStartMs = nowMs - hours * 2 * 3600000;
    yesterdaySegmentEndMs = todayStartMs;
  }

  const sqlFromMs = groupBy === 'hour' && hourWin ? hourWin.sqlFromMs : yesterdayStartMs;
  const nowBoundMs =
    groupBy === 'hour' && hourWin && hourWin.nowBoundMs != null ? hourWin.nowBoundMs : nowMs;
  const fromEp =
    groupBy === 'hour' && hourWin && hourWin.sqlFromEpochSec != null
      ? hourWin.sqlFromEpochSec
      : Math.floor(sqlFromMs / 1000);
  const untilEp =
    groupBy === 'hour' && hourWin && hourWin.sqlUntilEpochSec != null
      ? hourWin.sqlUntilEpochSec
      : Math.floor(nowBoundMs / 1000);

  const useDashToday = groupBy === 'hour' && hours === 24 && rangeNorm === 'today';

  /** @type {{ todayArr: Array<{ bucket: string, bucket_idx: number, gmv: number }>, todayTotal: number } | null} */
  let dashTodayUsd = null;
  /** @type {unknown[]} */
  let filtered = [];
  /** 与昨日 SQL 并行查询的「今日」窗口行（仅 useDashToday） */
  let todayMysqlRows = [];

  if (useDashToday) {
    const yStart = Math.floor(yesterdayStartMs / 1000);
    const yEnd = Math.floor(yesterdaySegmentEndMs / 1000);
    const tStart = Math.floor(todayStartMs / 1000);
    const tEnd = Math.floor(nowBoundMs / 1000);

    if (mysqlShopResolved) {
      const afY = await buildAnalyticsFilter(
        pool,
        tenantId,
        {
          market: q.market,
          shop_id: q.shop_id,
          status: q.status ?? q.orderFilter,
          analytics_time_from_epoch_sec: yStart,
          analytics_time_until_epoch_sec: yEnd,
        },
        analyticsScope,
      );
      const afT = await buildAnalyticsFilter(
        pool,
        tenantId,
        {
          market: q.market,
          shop_id: q.shop_id,
          status: q.status ?? q.orderFilter,
          analytics_time_from_epoch_sec: tStart,
          analytics_time_until_epoch_sec: tEnd,
        },
        analyticsScope,
      );
      if (afY.invalidShop || afT.invalidShop) {
        const empty = buildEmptyPayload(hours, groupBy, orderFilter);
        cacheSet(ck, empty);
        return empty;
      }

      const tsExpr = orderAnalyticsEventTimeExpr('o');
      const sqlY = `
    SELECT
      ${tsExpr} AS ts,
      o.total_amount AS total_amount,
      UPPER(COALESCE(NULLIF(TRIM(o.currency), ''), '')) AS currency_key,
      UPPER(COALESCE(NULLIF(TRIM(o.market), ''), '')) AS market
    FROM orders o
    WHERE 1=1
      ${afY.sql}
  `;
      const sqlT = `
    SELECT
      ${tsExpr} AS ts,
      o.total_amount AS total_amount,
      UPPER(COALESCE(NULLIF(TRIM(o.currency), ''), '')) AS currency_key,
      UPPER(COALESCE(NULLIF(TRIM(o.market), ''), '')) AS market
    FROM orders o
    WHERE 1=1
      ${afT.sql}
  `;

      const tqY = Date.now();
      const [[yRows], [tRows]] = await Promise.all([
        pool.query(sqlY, afY.params),
        pool.query(sqlT, afT.params),
      ]);
      filtered = Array.isArray(yRows) ? yRows : [];
      todayMysqlRows = Array.isArray(tRows) ? tRows : [];
      logAnalyticsQuerySlow(
        'gmv-compare-yesterday+today',
        orderFilter,
        Date.now() - tqY,
        filtered.length + todayMysqlRows.length,
      );
      logGmvCompareRowDebug(filtered, 'yesterday-window');
      logGmvCompareRowDebug(todayMysqlRows, 'today-window');
    } else {
      filtered = [];
      todayMysqlRows = [];
    }

    const curSetAll = [...filtered, ...todayMysqlRows].map((r) => {
      const ck0 = String(r.currency_key || '').trim();
      return normalizeCurrency(ck0) || getCurrencyByMarket(String(r.market || '')) || 'USD';
    });
    const ratesAll = await preloadUsdRates(curSetAll.length ? curSetAll : ['USD']);
    const mysqlTodayAgg = aggregateMysqlHourWindowToUsdSeries(
      todayMysqlRows,
      todayStartMs,
      nowBoundMs,
      hourWin.maxHourIdx,
      ratesAll,
      hourWin.compareMode === 'calendar_intraday' ? 'calendar' : 'elapsed',
    );
    dashTodayUsd = {
      todayArr: mysqlTodayAgg.todayArr,
      todayTotal: mysqlTodayAgg.todayTotal,
    };

    if (gmvCompareDebugEnabled()) {
      const nz = dashTodayUsd.todayArr.filter((p) => safeNum(p.gmv) > 0).length;
      console.log('[gmv-compare-debug]', 'today-final-mysql', {
        mysqlTodayTotal: mysqlTodayAgg.todayTotal,
        mysqlTodayNonzeroBuckets: mysqlTodayAgg.nonzeroBuckets,
        finalTodayNonzeroBuckets: nz,
      });
    }
  } else {
    if (
      shopRaw != null &&
      String(shopRaw).trim() !== '' &&
      String(shopRaw).trim().toLowerCase() !== 'all' &&
      !mysqlShopResolved
    ) {
      const empty = buildEmptyPayload(hours, groupBy, orderFilter);
      cacheSet(ck, empty);
      return empty;
    }
    const af = await buildAnalyticsFilter(
      pool,
      tenantId,
      {
        market: q.market,
        shop_id: q.shop_id,
        status: q.status ?? q.orderFilter,
        analytics_time_from_epoch_sec: fromEp,
        analytics_time_until_epoch_sec: untilEp,
      },
      analyticsScope,
    );
    if (af.invalidShop) {
      const empty = buildEmptyPayload(hours, groupBy, orderFilter);
      cacheSet(ck, empty);
      return empty;
    }

    const tsExpr = orderAnalyticsEventTimeExpr('o');
    const sql = `
    SELECT
      ${tsExpr} AS ts,
      o.total_amount AS total_amount,
      UPPER(COALESCE(NULLIF(TRIM(o.currency), ''), '')) AS currency_key,
      UPPER(COALESCE(NULLIF(TRIM(o.market), ''), '')) AS market
    FROM orders o
    WHERE 1=1
      ${af.sql}
  `;

    const tq0 = Date.now();
    const [rows] = await pool.query(sql, af.params);
    filtered = Array.isArray(rows) ? rows : [];
    logAnalyticsQuerySlow('gmv-compare', orderFilter, Date.now() - tq0, filtered.length);
  }

  if (!useDashToday && filtered.length === 0) {
    const emptyOut = {
      today: [],
      yesterday: [],
      summary: { todayTotal: 0, yesterdayTotal: 0, changePercent: null },
      gmv_currency: 'USD',
      meta: {
        hours,
        groupBy,
        orderFilter,
        cacheTtlMs: CACHE_TTL_MS,
        seriesSource: 'mysql_aggregate',
        seriesEmpty: true,
        compareMode: hourWin ? hourWin.compareMode : 'rolling_day_bins',
        maxHourIdx: hourWin ? hourWin.maxHourIdx : null,
        todayWindowStart: new Date(todayStartMs).toISOString(),
        yesterdayWindowStart: new Date(yesterdayStartMs).toISOString(),
        yesterdaySegmentEnd: new Date(yesterdaySegmentEndMs).toISOString(),
      },
    };
    cacheSet(ck, emptyOut);
    return emptyOut;
  }

  const curSet = (useDashToday ? [...filtered, ...todayMysqlRows] : filtered).map((r) => {
    const ck0 = String(r.currency_key || '').trim();
    return normalizeCurrency(ck0) || getCurrencyByMarket(String(r.market || '')) || 'USD';
  });
  const rates = await preloadUsdRates(curSet.length ? curSet : ['USD']);

  /** @type {Map<string, number>} */
  const todayNativeByBucketCur = new Map();
  /** @type {Map<string, number>} */
  const ydayNativeByBucketCur = new Map();

  for (const r of filtered) {
    const ts = r.ts instanceof Date ? r.ts.getTime() : new Date(r.ts).getTime();
    if (!Number.isFinite(ts)) continue;
    const isToday = !useDashToday && ts >= todayStartMs && ts <= nowBoundMs;
    const isYday =
      groupBy === 'hour'
        ? ts >= yesterdayStartMs && ts <= yesterdaySegmentEndMs
        : ts >= yesterdayStartMs && ts < yesterdaySegmentEndMs;
    if (!isToday && !isYday) continue;

    const cur =
      normalizeCurrency(String(r.currency_key || '').trim()) ||
      getCurrencyByMarket(String(r.market || '')) ||
      'USD';
    const amt = pickMysqlOrderAmount(r);

    let bucketKey;
    if (groupBy === 'hour') {
      const baseMs = isToday ? todayStartMs : yesterdayStartMs;
      let idx = Math.floor((ts - baseMs) / (3600 * 1000));
      if (idx < 0) continue;
      if (hourWin && idx > hourWin.maxHourIdx) continue;
      bucketKey = pad2(idx);
    } else {
      const dayMs = 24 * 3600 * 1000;
      const daySlots = Math.max(1, Math.ceil(hours / 24));
      const baseMs = isToday ? todayStartMs : yesterdayStartMs;
      let idx = Math.floor((ts - baseMs) / dayMs);
      if (idx < 0) idx = 0;
      if (idx > daySlots - 1) idx = daySlots - 1;
      bucketKey = String(idx);
    }

    const map = isToday ? todayNativeByBucketCur : ydayNativeByBucketCur;
    const k = `${bucketKey}\x1f${cur}`;
    map.set(k, (map.get(k) || 0) + amt);
  }

  function rollupToUsd(nativeMap) {
    /** @type {Map<string, number>} */
    const usd = new Map();
    for (const [k, nativeSum] of nativeMap.entries()) {
      const [bucket, cur] = k.split('\x1f');
      const rate = rates[cur] || 0;
      const u = convertToUSDSync(nativeSum, cur, rate);
      usd.set(bucket, (usd.get(bucket) || 0) + u);
    }
    return usd;
  }

  const todayUsd = rollupToUsd(todayNativeByBucketCur);
  const ydayUsd = rollupToUsd(ydayNativeByBucketCur);

  let todayArr;
  let ydayArr;
  if (groupBy === 'hour' && hourWin) {
    todayArr = [];
    ydayArr = [];
    if (dashTodayUsd) {
      todayArr = dashTodayUsd.todayArr;
    } else {
      for (let i = 0; i <= hourWin.maxHourIdx; i++) {
        const b = pad2(i);
        todayArr.push({
          bucket: `${b}:00`,
          bucket_idx: i,
          gmv: Number((todayUsd.get(b) || 0).toFixed(2)),
        });
      }
    }
    for (let i = 0; i <= hourWin.maxHourIdx; i++) {
      const b = pad2(i);
      ydayArr.push({
        bucket: `${b}:00`,
        bucket_idx: i,
        gmv: Number((ydayUsd.get(b) || 0).toFixed(2)),
      });
    }
  } else {
    const daySlots = Math.max(1, Math.ceil(hours / 24));
    todayArr = [];
    ydayArr = [];
    for (let i = 0; i < daySlots; i++) {
      const dayMs = 24 * 3600 * 1000;
      const tLabel = new Date(todayStartMs + i * dayMs);
      const yLabel = new Date(yesterdayStartMs + i * dayMs);
      const tb = `${tLabel.getUTCFullYear()}-${pad2(tLabel.getUTCMonth() + 1)}-${pad2(tLabel.getUTCDate())}`;
      const yb = `${yLabel.getUTCFullYear()}-${pad2(yLabel.getUTCMonth() + 1)}-${pad2(yLabel.getUTCDate())}`;
      todayArr.push({
        bucket: tb,
        bucket_idx: i,
        gmv: Number((todayUsd.get(String(i)) || 0).toFixed(2)),
      });
      ydayArr.push({
        bucket: yb,
        bucket_idx: i,
        gmv: Number((ydayUsd.get(String(i)) || 0).toFixed(2)),
      });
    }
  }

  let todayTotal = 0;
  let yesterdayTotal = 0;
  if (dashTodayUsd) {
    todayTotal = dashTodayUsd.todayTotal;
  } else {
    for (const p of todayArr) todayTotal += safeNum(p.gmv);
  }
  for (const p of ydayArr) yesterdayTotal += safeNum(p.gmv);

  if (todayTotal <= 0 && Array.isArray(todayMysqlRows) && todayMysqlRows.length > 0) {
    let sumToday = 0;
    for (const r of todayMysqlRows) {
      const ts = r.ts instanceof Date ? r.ts.getTime() : new Date(r.ts).getTime();
      if (!Number.isFinite(ts) || ts < todayStartMs || ts > nowBoundMs) continue;
      const cur =
        normalizeCurrency(String(r.currency_key || '').trim()) ||
        getCurrencyByMarket(String(r.market || '')) ||
        'USD';
      const rate = rates[cur] || 0;
      sumToday += convertToUSDSync(pickMysqlOrderAmount(r), cur, rate);
    }
    todayTotal = sumToday;
  }

  todayTotal = Number(todayTotal.toFixed(2));
  yesterdayTotal = Number(yesterdayTotal.toFixed(2));

  if (
    todayTotal > 0 &&
    groupBy === 'hour' &&
    hourWin &&
    Array.isArray(todayArr) &&
    todayArr.every((p) => safeNum(p.gmv) <= 0) &&
    Array.isArray(todayMysqlRows) &&
    todayMysqlRows.length > 0
  ) {
    const rebuilt = aggregateMysqlHourWindowToUsdSeries(
      todayMysqlRows,
      todayStartMs,
      nowBoundMs,
      hourWin.maxHourIdx,
      rates,
      'calendar',
    );
    todayArr = rebuilt.todayArr;
    if (todayTotal <= 0 && rebuilt.todayTotal > 0) {
      todayTotal = rebuilt.todayTotal;
    }
  }

  let changePercent = null;
  if (yesterdayTotal > 0) {
    changePercent = Number((((todayTotal - yesterdayTotal) / yesterdayTotal) * 100).toFixed(2));
  }

  const out = {
    today: todayArr,
    yesterday: ydayArr,
    summary: {
      todayTotal,
      yesterdayTotal,
      changePercent,
    },
    gmv_currency: 'USD',
    meta: {
      hours,
      groupBy,
      orderFilter,
      cacheTtlMs: CACHE_TTL_MS,
      seriesSource: useDashToday ? 'mysql_intraday_compare' : 'mysql_aggregate',
      dataSource: 'mysql',
      seriesEmpty: false,
      compareMode: hourWin ? hourWin.compareMode : 'rolling_day_bins',
      maxHourIdx: hourWin ? hourWin.maxHourIdx : null,
      todayWindowStart: new Date(todayStartMs).toISOString(),
      yesterdayWindowStart: new Date(yesterdayStartMs).toISOString(),
      yesterdaySegmentEnd: new Date(yesterdaySegmentEndMs).toISOString(),
    },
  };

  if (gmvCompareDebugEnabled()) {
    const firstY = filtered[0] && typeof filtered[0] === 'object' ? filtered[0] : null;
    const firstT = todayMysqlRows[0] && typeof todayMysqlRows[0] === 'object' ? todayMysqlRows[0] : null;
    out.meta.gmvCompareDebug = {
      useDashToday,
      yesterdayRowCount: filtered.length,
      todayMysqlRowCount: todayMysqlRows.length,
      firstYesterdayRowKeys: firstY ? Object.keys(firstY) : [],
      firstTodayMysqlRowKeys: firstT ? Object.keys(firstT) : [],
      firstYesterdayPickedAmount: firstY ? pickMysqlOrderAmount(firstY) : null,
      firstTodayMysqlPickedAmount: firstT ? pickMysqlOrderAmount(firstT) : null,
      summaryTodayTotal: todayTotal,
      todayNonzeroBucketCount: Array.isArray(todayArr) ? todayArr.filter((p) => safeNum(p.gmv) > 0).length : 0,
    };
    console.log('[gmv-compare-debug]', 'response-summary', out.meta.gmvCompareDebug);
  }

  cacheSet(ck, out);
  return out;
}

/**
 * @param {number} hours
 * @param {'hour'|'day'} groupBy
 * @param {string} [orderFilter]
 */
function buildEmptyPayload(hours, groupBy, orderFilter = 'all') {
  const gb = String(groupBy || 'hour').toLowerCase() === 'day' ? 'day' : 'hour';
  const nowMs = Date.now();
  let todayStartMs;
  let yesterdayStartMs;
  let yesterdaySegmentEndMs;
  let compareMode;
  let maxHourIdx = null;
  if (gb === 'hour' && hours === 24) {
    const w = computeHourCompareWindows(24, nowMs);
    todayStartMs = w.todayStartMs;
    yesterdayStartMs = w.yesterdayStartMs;
    yesterdaySegmentEndMs = w.yesterdayTsEnd;
    compareMode = w.compareMode;
    maxHourIdx = w.maxHourIdx;
  } else if (gb === 'hour') {
    const w = computeHourCompareWindows(hours, nowMs);
    todayStartMs = w.todayStartMs;
    yesterdayStartMs = w.yesterdayStartMs;
    yesterdaySegmentEndMs = w.yesterdayTsEnd;
    compareMode = w.compareMode;
    maxHourIdx = w.maxHourIdx;
  } else {
    todayStartMs = nowMs - hours * 3600 * 1000;
    yesterdayStartMs = nowMs - hours * 2 * 3600 * 1000;
    yesterdaySegmentEndMs = todayStartMs;
    compareMode = 'rolling_day_bins';
  }
  return {
    today: [],
    yesterday: [],
    summary: { todayTotal: 0, yesterdayTotal: 0, changePercent: null },
    gmv_currency: 'USD',
    meta: {
      hours,
      groupBy: gb,
      orderFilter,
      cacheTtlMs: CACHE_TTL_MS,
      seriesSource: 'mysql_aggregate',
      seriesEmpty: true,
      emptyReason: 'invalid_shop',
      compareMode,
      maxHourIdx,
      todayWindowStart: new Date(todayStartMs).toISOString(),
      yesterdayWindowStart: new Date(yesterdayStartMs).toISOString(),
      yesterdaySegmentEnd: new Date(yesterdaySegmentEndMs).toISOString(),
    },
  };
}

module.exports = {
  getGmvCompare,
};
