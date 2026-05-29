'use strict';

/**
 * 大屏 GMV 今日 vs 昨日同期（MySQL-only，filterContract）
 * 金额：按币种聚合后换算 USD（与 trendQuery / orderRowMoney 一致），禁止原币直接当 USD。
 */

const { getMysqlPool } = require('../../db/mysqlPool');
const { strictAnalyticsFilterOpts } = require('../../lib/resolveTenantShop');
const { pickOrderAmount } = require('../../lib/orderRowMoney');
const {
  resolveDashboardCurrency,
  preloadRatesForCurrencyRows,
  nativeAmountToUsd,
  queryDashboardGmvUsd,
} = require('./usdGmv');
const {
  getTodayYesterdayIntradayCompareEpochBounds,
} = require('../../lib/dashboardTimeRange');
const {
  parseDashboardFilterQuery,
  buildDashboardWhere,
  dashboardWhereParams,
  logDashboardContract,
  orderAnalyticsEventTimeExpr,
  contractForDashboardApi,
} = require('./filterContract');
const { logDashboardSlow, slowMetaFromContract } = require('../../lib/dashboardSlowLog');
const { withDashboardCache } = require('../../lib/dashboardCache');

function afOpts() {
  return strictAnalyticsFilterOpts();
}

function pad2(n) {
  return String(Math.max(0, Math.floor(n))).padStart(2, '0');
}

function compareHourBucketIdx(tsMs, anchorStartMs, rangeEndMs, maxHourIdx) {
  if (!Number.isFinite(tsMs) || tsMs < anchorStartMs || tsMs > rangeEndMs) return -1;
  const idx = Math.floor((tsMs - anchorStartMs) / 3600000);
  if (idx < 0 || idx > maxHourIdx) return -1;
  return idx;
}

/**
 * @param {{ fromSec: number, untilSec: number }} a
 * @param {{ fromSec: number, untilSec: number }} b
 */
function sameEpochWindow(a, b) {
  return Number(a.fromSec) === Number(b.fromSec) && Number(a.untilSec) === Number(b.untilSec);
}

/**
 * 与 queryDashboardGmvUsd 同口径：行级金额按币种 rollup 为 USD + DISTINCT 订单数
 * @param {Record<string, unknown>[]} rows
 * @param {Record<string, number>} rates
 */
function aggregateGmvUsdFromOrderRows(rows, rates) {
  /** @type {Map<string, number>} */
  const nativeByCur = new Map();
  /** @type {Set<number>} */
  const orderIds = new Set();
  for (const r of rows) {
    if (!r || typeof r !== 'object') continue;
    const oid = r.order_id != null ? Number(r.order_id) : NaN;
    if (Number.isFinite(oid)) orderIds.add(oid);
    const cur = resolveDashboardCurrency(r.currency_key, r.market);
    nativeByCur.set(cur, (nativeByCur.get(cur) || 0) + pickOrderAmount(r));
  }
  let gmv = 0;
  for (const [cur, native] of nativeByCur.entries()) {
    gmv += nativeAmountToUsd(native, cur, rates);
  }
  return {
    gmv: Number(gmv.toFixed(2)),
    orders: orderIds.size,
  };
}

async function fetchOrderRows(pool, tenantId, contract, fromSec, untilSec, fo, sqlTag) {
  const slice = contractForDashboardApi({ ...contract, startSec: fromSec, endSec: untilSec });
  const where = await buildDashboardWhere(pool, tenantId, slice, {
    skipTenant: fo.skipTenant,
    allTenantShops: fo.allTenantShops,
  });
  if (where.invalidShop) return { invalidShop: true, rows: [] };

  const tsExpr = orderAnalyticsEventTimeExpr('o');
  const sql = `
    SELECT
      ${tsExpr} AS ts,
      o.id AS order_id,
      o.total_amount AS total_amount,
      UPPER(COALESCE(NULLIF(TRIM(o.currency), ''), '')) AS currency_key,
      UPPER(COALESCE(NULLIF(TRIM(o.market), ''), '')) AS market
    FROM orders o
    WHERE 1=1
      ${where.sql}
  `;
  const params = dashboardWhereParams(where);
  const t0 = Date.now();
  const [r] = await pool.query(sql, params);
  const rows = Array.isArray(r) ? r : [];
  logDashboardSlow({
    ...slowMetaFromContract(slice),
    endpoint: 'gmv-compare',
    durationMs: Date.now() - t0,
    sqlTag: sqlTag || 'gmv_compare_fetch_rows',
    rows: rows.length,
    cacheHit: false,
  });
  return { invalidShop: false, rows };
}

/** 分时曲线：按小时桶 + 币种累加原币，再 rollup 为 USD */
function aggregateMysqlHourWindowUsdSeries(rows, anchorStartMs, rangeEndMs, maxHourIdx, rates) {
  /** @type {Map<string, number>} */
  const nativeMap = new Map();
  for (const r of rows) {
    if (!r || typeof r !== 'object') continue;
    const ts = r.ts instanceof Date ? r.ts.getTime() : new Date(r.ts).getTime();
    if (!Number.isFinite(ts) || ts < anchorStartMs || ts > rangeEndMs) continue;
    const idx = compareHourBucketIdx(ts, anchorStartMs, rangeEndMs, maxHourIdx);
    if (idx < 0) continue;
    const cur = resolveDashboardCurrency(r.currency_key, r.market);
    const b = pad2(idx);
    const k = `${b}\x1f${cur}`;
    nativeMap.set(k, (nativeMap.get(k) || 0) + pickOrderAmount(r));
  }

  /** @type {Map<string, number>} */
  const usdByBucket = new Map();
  for (const [k, nativeSum] of nativeMap.entries()) {
    const [bucket, cur] = k.split('\x1f');
    const u = nativeAmountToUsd(nativeSum, cur, rates);
    usdByBucket.set(bucket, (usdByBucket.get(bucket) || 0) + u);
  }

  const todayArr = [];
  let seriesSum = 0;
  for (let i = 0; i <= maxHourIdx; i++) {
    const b = pad2(i);
    const gmv = Number((usdByBucket.get(b) || 0).toFixed(2));
    todayArr.push({ bucket: `${b}:00`, bucket_idx: i, gmv });
    seriesSum += gmv;
  }
  return { todayArr, seriesSum: Number(seriesSum.toFixed(2)) };
}

function computeCompareWindows(contract, groupBy) {
  if (groupBy === 'hour' && contract.timeRange === 'today') {
    const w = getTodayYesterdayIntradayCompareEpochBounds();
    const yEndSec = Math.floor(w.yesterdayTsEnd / 1000);
    return {
      ...w,
      parallelFetch: true,
      todayFromSec: Math.floor(w.todayStartMs / 1000),
      todayUntilSec: Math.floor((w.nowBoundMs ?? w.todayStartMs) / 1000),
      yesterdayFromSec: Math.floor(w.yesterdayStartMs / 1000),
      yesterdayUntilSec: yEndSec,
      compareEndMs: w.yesterdayTsEnd,
    };
  }

  const elapsed = Math.max(1, contract.endSec - contract.startSec);
  const todayStartMs = contract.startSec * 1000;
  const nowBoundMs = contract.endSec * 1000;
  const compareStartSec = contract.startSec - elapsed;
  const compareEndSec = contract.startSec - 1;

  if (groupBy === 'hour') {
    const maxHourIdx = Math.min(23, Math.max(0, Math.floor(elapsed / 3600)));
    return {
      compareMode: contract.timeRange === 'yesterday' ? 'yesterday_vs_prevday' : 'contract_intraday',
      parallelFetch: true,
      todayStartMs,
      nowBoundMs,
      yesterdayStartMs: compareStartSec * 1000,
      yesterdayTsEnd: compareEndSec * 1000,
      compareEndMs: compareEndSec * 1000,
      maxHourIdx,
      todayFromSec: contract.startSec,
      todayUntilSec: contract.endSec,
      yesterdayFromSec: compareStartSec,
      yesterdayUntilSec: compareEndSec,
    };
  }

  return {
    compareMode: 'contract_day',
    parallelFetch: true,
    todayStartMs,
    nowBoundMs,
    yesterdayStartMs: compareStartSec * 1000,
    yesterdayTsEnd: compareEndSec * 1000,
    compareEndMs: compareEndSec * 1000,
    todayFromSec: contract.startSec,
    todayUntilSec: contract.endSec,
    yesterdayFromSec: compareStartSec,
    yesterdayUntilSec: compareEndSec,
  };
}

function buildZeroHourBuckets(maxHourIdx) {
  const n = Math.max(0, Math.min(23, Number(maxHourIdx) || 23));
  const today = [];
  const yesterday = [];
  for (let i = 0; i <= n; i++) {
    const bucket = `${pad2(i)}:00`;
    today.push({ bucket, bucket_idx: i, gmv: 0 });
    yesterday.push({ bucket, bucket_idx: i, gmv: 0 });
  }
  return { today, yesterday };
}

function buildEmptyPayload(contract, groupBy) {
  const win = computeCompareWindows(contract, groupBy);
  const zero =
    groupBy === 'hour'
      ? buildZeroHourBuckets(win.maxHourIdx ?? 23)
      : { today: [], yesterday: [] };
  return {
    today: zero.today,
    yesterday: zero.yesterday,
    summary: { todayTotal: 0, yesterdayTotal: 0, changePercent: null },
    gmv_currency: 'USD',
    meta: {
      groupBy,
      orderFilter: contract.orderFilter,
      timeRange: contract.timeRange,
      seriesSource: 'mysql',
      seriesEmpty: true,
      emptyReason: 'invalid_shop',
      compareMode: win.compareMode,
    },
  };
}

/**
 * @param {number} tenantId
 * @param {Record<string, unknown>} q
 */
async function queryDashboardGmvCompare(tenantId, q) {
  const contract = contractForDashboardApi(parseDashboardFilterQuery(q, tenantId));
  const groupBy = String(q.groupBy || q.group_by || 'hour').toLowerCase() === 'day' ? 'day' : 'hour';

  return withDashboardCache({
    endpoint: 'gmv-compare',
    tenantId,
    contract,
    q,
    extra: { groupBy },
    sqlTag: 'gmv_compare_total_pipeline',
    rowsPick: (val) => (val?.today?.length || 0) + (val?.yesterday?.length || 0),
    loader: () => computeDashboardGmvCompareUncached(tenantId, q, contract, groupBy),
  });
}

/**
 * @param {number} tenantId
 * @param {Record<string, unknown>} q
 * @param {import('./filterContract').DashboardFilterContract} contract
 * @param {'hour'|'day'} groupBy
 */
async function computeDashboardGmvCompareUncached(tenantId, q, contract, groupBy) {
  const pool = getMysqlPool();
  if (!pool) {
    const err = new Error('mysql_unavailable');
    err.code = 'mysql_unavailable';
    throw err;
  }

  const fo = afOpts();
  const win = computeCompareWindows(contract, groupBy);
  const t0 = Date.now();

  const tFrom = win.todayFromSec ?? Math.floor(win.todayStartMs / 1000);
  const tUntil = win.todayUntilSec ?? Math.floor(win.nowBoundMs / 1000);
  const yFrom = win.yesterdayFromSec ?? Math.floor(win.yesterdayStartMs / 1000);
  const yUntil = win.yesterdayUntilSec ?? Math.floor((win.compareEndMs ?? win.yesterdayTsEnd) / 1000);

  const contractTodayWin = { fromSec: contract.startSec, untilSec: contract.endSec };
  const fetchTodayWin = { fromSec: tFrom, untilSec: tUntil };
  const fetchYesterdayWin = { fromSec: yFrom, untilSec: yUntil };

  let todayMysqlRows = [];
  let ydayRows = [];
  let todaySnap = { invalidShop: false, gmv: 0, orders: 0 };
  let yesterdaySnap = { invalidShop: false, gmv: 0, orders: 0 };
  let totalsFromRows = false;

  if (groupBy === 'hour') {
    const [tPack, yPack] = await Promise.all([
      fetchOrderRows(pool, tenantId, contract, tFrom, tUntil, fo, 'gmv_compare_fetch_today'),
      fetchOrderRows(pool, tenantId, contract, yFrom, yUntil, fo, 'gmv_compare_fetch_yesterday'),
    ]);

    if (tPack.invalidShop || yPack.invalidShop) {
      const empty = buildEmptyPayload(contract, groupBy);
      logDashboardContract('gmv-compare', contract, { todayTotal: 0, yesterdayTotal: 0, points: 0 });
      return empty;
    }

    todayMysqlRows = tPack.rows;
    ydayRows = yPack.rows;

    const curRows = [...todayMysqlRows, ...ydayRows];
    const rates = await preloadRatesForCurrencyRows(curRows, (r) =>
      resolveDashboardCurrency(r.currency_key, r.market),
    );

    const canDeriveToday = sameEpochWindow(contractTodayWin, fetchTodayWin);
    const canDeriveYesterday = sameEpochWindow(fetchYesterdayWin, fetchYesterdayWin);

    if (canDeriveToday) {
      const t = aggregateGmvUsdFromOrderRows(todayMysqlRows, rates);
      todaySnap = { invalidShop: false, gmv: t.gmv, orders: t.orders };
    } else {
      todaySnap = await queryDashboardGmvUsd(pool, tenantId, contract, fo, null, {
        endpoint: 'gmv-compare',
        sqlTag: 'gmv_compare_snap_today',
      });
    }

    if (canDeriveYesterday) {
      const y = aggregateGmvUsdFromOrderRows(ydayRows, rates);
      yesterdaySnap = { invalidShop: false, gmv: y.gmv, orders: y.orders };
    } else {
      yesterdaySnap = await queryDashboardGmvUsd(pool, tenantId, contract, fo, fetchYesterdayWin, {
        endpoint: 'gmv-compare',
        sqlTag: 'gmv_compare_snap_yesterday',
      });
    }

    totalsFromRows = canDeriveToday && canDeriveYesterday;

    if (todaySnap.invalidShop || yesterdaySnap.invalidShop) {
      const empty = buildEmptyPayload(contract, groupBy);
      logDashboardContract('gmv-compare', contract, { todayTotal: 0, yesterdayTotal: 0, points: 0 });
      return empty;
    }

    let todayTotal = todaySnap.gmv;
    let yesterdayTotal = yesterdaySnap.gmv;

    let todayArr = [];
    let ydayArr = [];

    if (win.maxHourIdx != null) {
      const todayAgg = aggregateMysqlHourWindowUsdSeries(
        todayMysqlRows,
        win.todayStartMs,
        win.nowBoundMs,
        win.maxHourIdx,
        rates,
      );
      todayArr = todayAgg.todayArr;

      const yEndMs = win.compareEndMs ?? win.yesterdayTsEnd ?? win.nowBoundMs;
      const yAgg = aggregateMysqlHourWindowUsdSeries(
        ydayRows,
        win.yesterdayStartMs,
        yEndMs,
        win.maxHourIdx,
        rates,
      );
      ydayArr = yAgg.todayArr;
    }

    const ms = Date.now() - t0;
    logDashboardSlow({
      ...slowMetaFromContract(contract),
      endpoint: 'gmv-compare',
      durationMs: ms,
      sqlTag: 'gmv_compare_total_pipeline',
      rows: todayMysqlRows.length + ydayRows.length,
      points: (todayArr?.length || 0) + (ydayArr?.length || 0),
      cacheHit: false,
    });

    let changePercent = null;
    if (yesterdayTotal > 0) {
      changePercent = Number((((todayTotal - yesterdayTotal) / yesterdayTotal) * 100).toFixed(2));
    }

    const out = {
      today: todayArr,
      yesterday: ydayArr,
      summary: { todayTotal, yesterdayTotal, changePercent },
      gmv_currency: 'USD',
      meta: {
        groupBy,
        orderFilter: contract.orderFilter,
        kpiContractLocked: true,
        timeRange: contract.timeRange,
        seriesSource: 'mysql',
        dataSource: 'mysql',
        compareMode: win.compareMode,
        maxHourIdx: win.maxHourIdx ?? null,
        compareStartSec: yFrom,
        compareEndSec: yUntil,
        todayStartSec: tFrom,
        todayEndSec: tUntil,
        todayOrders: todaySnap.orders,
        yesterdayOrders: yesterdaySnap.orders,
        totalsFromRows,
      },
    };

    const points = (out.today?.length || 0) + (out.yesterday?.length || 0);
    logDashboardContract('gmv-compare', contract, {
      todayTotal,
      yesterdayTotal,
      points,
      orders: todaySnap.orders,
    });
    return out;
  }

  const [todaySnapRes, yesterdaySnapRes] = await Promise.all([
    queryDashboardGmvUsd(pool, tenantId, contract, fo, null, {
      endpoint: 'gmv-compare',
      sqlTag: 'gmv_compare_snap_today',
    }),
    queryDashboardGmvUsd(pool, tenantId, contract, fo, fetchYesterdayWin, {
      endpoint: 'gmv-compare',
      sqlTag: 'gmv_compare_snap_yesterday',
    }),
  ]);
  todaySnap = todaySnapRes;
  yesterdaySnap = yesterdaySnapRes;

  if (todaySnap.invalidShop || yesterdaySnap.invalidShop) {
    const empty = buildEmptyPayload(contract, groupBy);
    logDashboardContract('gmv-compare', contract, { todayTotal: 0, yesterdayTotal: 0, points: 0 });
    return empty;
  }

  const todayTotal = todaySnap.gmv;
  const yesterdayTotal = yesterdaySnap.gmv;

  const ms = Date.now() - t0;
  logDashboardSlow({
    ...slowMetaFromContract(contract),
    endpoint: 'gmv-compare',
    durationMs: ms,
    sqlTag: 'gmv_compare_total_pipeline',
    rows: 0,
    points: 0,
    cacheHit: false,
  });

  let changePercent = null;
  if (yesterdayTotal > 0) {
    changePercent = Number((((todayTotal - yesterdayTotal) / yesterdayTotal) * 100).toFixed(2));
  }

  const out = {
    today: [],
    yesterday: [],
    summary: { todayTotal, yesterdayTotal, changePercent },
    gmv_currency: 'USD',
    meta: {
      groupBy,
      orderFilter: contract.orderFilter,
      timeRange: contract.timeRange,
      seriesSource: 'mysql',
      dataSource: 'mysql',
      compareMode: win.compareMode,
      compareStartSec: yFrom,
      compareEndSec: yUntil,
      todayStartSec: tFrom,
      todayEndSec: tUntil,
      todayOrders: todaySnap.orders,
      yesterdayOrders: yesterdaySnap.orders,
      totalsFromRows: false,
      dayModeSkipRowFetch: true,
    },
  };

  logDashboardContract('gmv-compare', contract, {
    todayTotal,
    yesterdayTotal,
    points: 0,
    orders: todaySnap.orders,
  });
  return out;
}

module.exports = { queryDashboardGmvCompare };
