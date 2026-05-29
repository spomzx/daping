'use strict';

/**
 * 实时大屏唯一筛选契约（解析、WHERE 构建、调试日志）。
 * 所有 dashboard / analytics 订单查询须经此模块，禁止各接口自建时间窗或 status 别名。
 */

const crypto = require('crypto');
const { marketClauseOrdersOnly } = require('../../lib/analyticsMysqlScope');
const { normalizeRange, getTimeRangeBounds, parseYmd } = require('../../lib/dashboardTimeRange');

function orderAnalyticsEventTimeExpr(alias = 'o') {
  return `COALESCE(${alias}.paid_at, ${alias}.created_at_platform, ${alias}.created_at)`;
}

/**
 * 索引友好时间窗：不对列套 DATE()/COALESCE()，按 paid_at → created_at_platform → created_at 分支 BETWEEN。
 * @param {string} alias
 * @param {number} startSec
 * @param {number} endSec
 */
function buildIndexFriendlyEventTimeWhere(alias, startSec, endSec) {
  const a = String(alias || 'o').trim() || 'o';
  const fs = Math.floor(Number(startSec));
  const us = Math.floor(Number(endSec));
  if (!Number.isFinite(fs) || !Number.isFinite(us)) {
    return { sql: '', params: [] };
  }
  return {
    sql: ` AND (
      (${a}.paid_at IS NOT NULL AND ${a}.paid_at >= FROM_UNIXTIME(?) AND ${a}.paid_at <= FROM_UNIXTIME(?))
      OR (${a}.paid_at IS NULL AND ${a}.created_at_platform IS NOT NULL AND ${a}.created_at_platform >= FROM_UNIXTIME(?) AND ${a}.created_at_platform <= FROM_UNIXTIME(?))
      OR (${a}.paid_at IS NULL AND ${a}.created_at_platform IS NULL AND ${a}.created_at >= FROM_UNIXTIME(?) AND ${a}.created_at <= FROM_UNIXTIME(?))
    ) `,
    params: [fs, us, fs, us, fs, us],
  };
}

/**
 * 大屏订单数唯一口径：orders 表主键去重（summary / ranking / 诊断 COUNT 必须一致）。
 * @param {string} [alias='o']
 */
function dashboardOrderCountExpr(alias = 'o') {
  const a = String(alias || 'o').trim() || 'o';
  return `COUNT(DISTINCT ${a}.id)`;
}
const { resolveDashboardDateRange } = require('./dateRange');
const {
  buildOrderFilterWhere,
  normalizeOrderFilter,
  dashboardGmvNativeSumExpr,
} = require('./filterBuilder');
const { LOCKED_KPI_ORDER_FILTER } = require('../../lib/orderFilter');

/**
 * @typedef {Object} DashboardFilterContract
 * @property {number|null} tenantId
 * @property {string} shopId - 'all' 或 MySQL shops.id / platform_shop_id 字符串
 * @property {string} market - 'ALL' | 'TH' | 'MY' | …
 * @property {string} orderFilter - all | valid | unpaid | sample | cancelled | paid
 * @property {string} timeRange - today | yesterday | last7 | last30 | custom
 * @property {string} startDate
 * @property {string} endDate
 * @property {number} startSec
 * @property {number} endSec
 * @property {boolean} [customInvalid]
 */

/**
 * 归一化 HTTP query → 契约（兼容旧字段仅在此一处）
 * @param {Record<string, unknown>} [raw]
 * @param {number|null} [tenantId]
 * @returns {DashboardFilterContract}
 */
function parseDashboardFilterQuery(raw = {}, tenantId = null) {
  const q = raw && typeof raw === 'object' ? raw : {};

  const shopRaw =
    q.shopId != null && String(q.shopId).trim() !== ''
      ? q.shopId
      : q.shop_id != null
        ? q.shop_id
        : 'all';
  let shopId = String(shopRaw || 'all').trim();
  if (!shopId || shopId.toLowerCase() === 'all') shopId = 'all';

  let market = 'ALL';
  if (q.market != null && String(q.market).trim() !== '') {
    market = String(q.market).trim().toUpperCase();
  } else if (q.region != null && String(q.region).trim() !== '' && String(q.region).toLowerCase() !== 'all') {
    market = String(q.region).trim().toUpperCase();
  }

  const orderFilter = normalizeOrderFilter(q.orderFilter ?? q.status ?? q.orderStatus);

  let timeRangeRaw =
    q.timeRange != null && String(q.timeRange).trim() !== ''
      ? String(q.timeRange)
      : q.range != null && String(q.range).trim() !== ''
        ? String(q.range)
        : '';
  if (!timeRangeRaw && q.hours != null && String(q.hours).trim() !== '') {
    const h = Number(q.hours);
    if (h === 24) timeRangeRaw = 'today';
    else if (h === 168) timeRangeRaw = '7d';
    else if (h === 720) timeRangeRaw = '30d';
  }
  if (!timeRangeRaw) timeRangeRaw = 'today';

  const dr = resolveDashboardDateRange({
    range: normalizeRange(timeRangeRaw),
    startDate: q.startDate,
    endDate: q.endDate,
    analytics_time_from_epoch_sec: q.analytics_time_from_epoch_sec,
    analytics_time_until_epoch_sec: q.analytics_time_until_epoch_sec,
  });

  const tid =
    tenantId != null && Number.isFinite(Number(tenantId))
      ? Number(tenantId)
      : q.tenantId != null && Number.isFinite(Number(q.tenantId))
        ? Number(q.tenantId)
        : null;

  return {
    tenantId: tid,
    shopId,
    market,
    orderFilter,
    timeRange: dr.range,
    startDate: dr.startDate,
    endDate: dr.endDate,
    startSec: dr.startSec,
    endSec: dr.endSec,
    customInvalid: dr.customInvalid === true,
  };
}

/**
 * @param {DashboardFilterContract} contract
 * @returns {Record<string, string|number>}
 */
function contractToAnalyticsQuery(contract) {
  return {
    shop_id: contract.shopId,
    shopId: contract.shopId,
    market: contract.market,
    orderFilter: contract.orderFilter,
    range: contract.timeRange,
    timeRange: contract.timeRange,
    startDate: contract.startDate,
    endDate: contract.endDate,
    analytics_time_from_epoch_sec: contract.startSec,
    analytics_time_until_epoch_sec: contract.endSec,
  };
}

/**
 * @param {import('mysql2/promise').Pool} pool
 * @param {number} tenantId
 * @param {string} shopRaw
 * @param {string} [alias]
 * @param {{ allTenants?: boolean }} [opts]
 */
/**
 * @param {import('mysql2/promise').Pool} pool
 * @param {number} tenantId
 * @param {string} [shopRaw]
 * @param {string} [alias]
 * @param {{ allTenants?: boolean }} [opts]
 * @returns {Promise<{ sql: string, params: unknown[] } | null>}
 */
async function lookupShopIdByName(pool, tenantId, nameKey, allTenants) {
  const key = String(nameKey || '').trim().toLowerCase();
  if (!key) return null;
  const sql = allTenants
    ? `SELECT id FROM shops WHERE status <> 'deleted'
       AND (
         LOWER(TRIM(COALESCE(NULLIF(TRIM(display_name), ''), shop_name, ''))) = ?
         OR LOWER(TRIM(COALESCE(shop_name, ''))) = ?
       ) LIMIT 1`
    : `SELECT id FROM shops WHERE tenant_id = ? AND status <> 'deleted'
       AND (
         LOWER(TRIM(COALESCE(NULLIF(TRIM(display_name), ''), shop_name, ''))) = ?
         OR LOWER(TRIM(COALESCE(shop_name, ''))) = ?
       ) LIMIT 1`;
  const params = allTenants ? [key, key] : [tenantId, key, key];
  const [rows] = await pool.query(sql, params);
  if (!Array.isArray(rows) || rows.length === 0) return null;
  return rows[0].id;
}

async function resolveShopClause(pool, tenantId, shopRaw, alias = 'o', opts = {}) {
  const allTenants = opts.allTenants === true;
  const raw = String(shopRaw || '').trim();
  if (!raw || raw.toLowerCase() === 'all') {
    return { sql: '', params: [] };
  }

  const sid = raw.toLowerCase();

  if (/^\d+$/.test(raw)) {
    const id = Number(raw);
    const byMysqlId = allTenants
      ? await pool.query('SELECT id FROM shops WHERE id = ? AND status <> ? LIMIT 1', [id, 'deleted'])
      : await pool.query(
          'SELECT id FROM shops WHERE tenant_id = ? AND id = ? AND status <> ? LIMIT 1',
          [tenantId, id, 'deleted'],
        );
    if (Array.isArray(byMysqlId[0]) && byMysqlId[0].length > 0) {
      return { sql: ` AND ${alias}.shop_id = ? `, params: [id] };
    }
    const byPlatform = allTenants
      ? await pool.query(
          "SELECT id FROM shops WHERE LOWER(TRIM(platform_shop_id)) = ? AND status <> 'deleted' LIMIT 1",
          [sid],
        )
      : await pool.query(
          "SELECT id FROM shops WHERE tenant_id = ? AND LOWER(platform_shop_id) = ? AND status <> 'deleted' LIMIT 1",
          [tenantId, sid],
        );
    if (Array.isArray(byPlatform[0]) && byPlatform[0].length > 0) {
      return { sql: ` AND ${alias}.shop_id = ? `, params: [byPlatform[0][0].id] };
    }
    const byName = await lookupShopIdByName(pool, tenantId, sid, allTenants);
    if (byName != null) {
      return { sql: ` AND ${alias}.shop_id = ? `, params: [byName] };
    }
    return null;
  }

  const byPlatform = allTenants
    ? await pool.query(
        "SELECT id FROM shops WHERE LOWER(TRIM(platform_shop_id)) = ? AND status <> 'deleted' LIMIT 1",
        [sid],
      )
    : await pool.query(
        "SELECT id FROM shops WHERE tenant_id = ? AND LOWER(platform_shop_id) = ? AND status <> 'deleted' LIMIT 1",
        [tenantId, sid],
      );
  if (Array.isArray(byPlatform[0]) && byPlatform[0].length > 0) {
    return { sql: ` AND ${alias}.shop_id = ? `, params: [byPlatform[0][0].id] };
  }

  const byName = await lookupShopIdByName(pool, tenantId, sid, allTenants);
  if (byName != null) {
    return { sql: ` AND ${alias}.shop_id = ? `, params: [byName] };
  }

  return null;
}

async function buildShopWhere(pool, tenantId, shopRaw, alias = 'o', opts = {}) {
  const raw = String(shopRaw || '').trim();
  if (!raw || raw.toLowerCase() === 'all') {
    return { sql: '', params: [], invalidShop: false };
  }
  const shopPart = await resolveShopClause(pool, tenantId, raw, alias, {
    allTenants: opts.allTenants === true,
  });
  if (!shopPart) {
    return { sql: '', params: [], invalidShop: true };
  }
  return {
    sql: shopPart.sql && String(shopPart.sql).trim() ? String(shopPart.sql) : '',
    params: Array.isArray(shopPart.params) ? shopPart.params : [],
    invalidShop: false,
  };
}

/**
 * @param {DashboardFilterContract|string} marketOrContract
 * @param {string} [alias]
 */
function buildMarketWhere(marketOrContract, alias = 'o') {
  const market =
    typeof marketOrContract === 'object' && marketOrContract != null
      ? marketOrContract.market
      : marketOrContract;
  const mkt = marketClauseOrdersOnly(alias, market);
  return {
    sql: mkt.sql && String(mkt.sql).trim() ? String(mkt.sql) : '',
    params: Array.isArray(mkt.params) ? mkt.params : [],
  };
}

/**
 * 日历日 WHERE：索引友好 BETWEEN（paid_at / created_at_platform / created_at 分支，禁止 DATE(COALESCE(...))）。
 *
 * @param {DashboardFilterContract} contract
 * @param {string} [alias]
 * @returns {{
 *   sql: string,
 *   params: unknown[],
 *   startSec: number,
 *   endSec: number,
 *   timeRange: string,
 *   dateWindow: string,
 *   timeField: string,
 * }}
 */
function buildDateRangeWhere(contract, alias = 'o') {
  const te = orderAnalyticsEventTimeExpr(alias);
  const timeField = `${alias}.paid_at|${alias}.created_at_platform|${alias}.created_at`;
  const tr = normalizeRange(contract.timeRange || 'today');
  const tbToday = getTimeRangeBounds('today', contract.startDate, contract.endDate);
  const fs = Math.floor(Number(contract.startSec));
  const us = Math.floor(Number(contract.endSec));

  /** gmv-compare 昨日同期拉数：epoch 窗落在今日 00:00 之前 */
  const isYesterdayCompareSlice =
    tr === 'today' && Number.isFinite(us) && Number.isFinite(tbToday.startSec) && us < tbToday.startSec;

  if (tr === 'today' && !isYesterdayCompareSlice) {
    const tw = buildIndexFriendlyEventTimeWhere(alias, tbToday.startSec, tbToday.endSec);
    return {
      ...tw,
      startSec: tbToday.startSec,
      endSec: tbToday.endSec,
      timeRange: 'today',
      dateWindow: 'CURDATE',
      timeField,
    };
  }

  if (tr === 'today' && isYesterdayCompareSlice) {
    const tw = buildIndexFriendlyEventTimeWhere(alias, fs, us);
    return {
      ...tw,
      startSec: fs,
      endSec: us,
      timeRange: 'today',
      dateWindow: 'YESTERDAY',
      timeField,
    };
  }

  if (tr === 'yesterday') {
    const yb = getTimeRangeBounds('yesterday', contract.startDate, contract.endDate);
    const tw = buildIndexFriendlyEventTimeWhere(alias, yb.startSec, yb.endSec);
    return {
      ...tw,
      startSec: yb.startSec,
      endSec: yb.endSec,
      timeRange: 'yesterday',
      dateWindow: 'YESTERDAY',
      timeField,
    };
  }

  if (tr === 'last7') {
    const b7 = getTimeRangeBounds('last7', contract.startDate, contract.endDate);
    const tw = buildIndexFriendlyEventTimeWhere(alias, b7.startSec, b7.endSec);
    return {
      ...tw,
      startSec: b7.startSec,
      endSec: b7.endSec,
      timeRange: 'last7',
      dateWindow: 'LAST7_TO_CURDATE',
      timeField,
    };
  }

  if (tr === 'last30') {
    const b30 = getTimeRangeBounds('last30', contract.startDate, contract.endDate);
    const tw = buildIndexFriendlyEventTimeWhere(alias, b30.startSec, b30.endSec);
    return {
      ...tw,
      startSec: b30.startSec,
      endSec: b30.endSec,
      timeRange: 'last30',
      dateWindow: 'LAST30_TO_CURDATE',
      timeField,
    };
  }

  const sd = parseYmd(contract.startDate);
  const ed = parseYmd(contract.endDate);
  if (sd && ed) {
    const startYmd = `${sd.y}-${String(sd.mo).padStart(2, '0')}-${String(sd.d).padStart(2, '0')}`;
    const endYmd = `${ed.y}-${String(ed.mo).padStart(2, '0')}-${String(ed.d).padStart(2, '0')}`;
    const bCustom = getTimeRangeBounds('custom', startYmd, endYmd);
    const tw = buildIndexFriendlyEventTimeWhere(alias, bCustom.startSec, bCustom.endSec);
    return {
      ...tw,
      startSec: bCustom.startSec,
      endSec: bCustom.endSec,
      timeRange: 'custom',
      dateWindow: startYmd === endYmd ? 'CALENDAR_DAY' : 'CUSTOM_RANGE',
      timeField,
    };
  }

  const tw = buildIndexFriendlyEventTimeWhere(alias, tbToday.startSec, tbToday.endSec);
  return {
    ...tw,
    startSec: tbToday.startSec,
    endSec: tbToday.endSec,
    timeRange: 'today',
    dateWindow: 'CURDATE',
    timeField,
  };
}

/**
 * 组合 tenant + 时间 + 市场 + 店铺 + 订单状态（禁止滑动 hours 窗）
 * @param {import('mysql2/promise').Pool} pool
 * @param {number} tenantId
 * @param {DashboardFilterContract} contract
 * @param {{ alias?: string, includeStatus?: boolean, skipTenant?: boolean, allTenantShops?: boolean, dataScope?: import('../../lib/dataScope').UserDataScope }} [options]
 */
async function buildDashboardWhere(pool, tenantId, contract, options = {}) {
  const alias = options.alias || 'o';
  const includeStatus = options.includeStatus !== false;
  const skipTenant = options.skipTenant === true;
  const parts = [];
  const params = [];

  if (!skipTenant && tenantId != null && Number.isFinite(Number(tenantId))) {
    parts.push(`${alias}.tenant_id = ?`);
    params.push(Number(tenantId));
  }

  if (options.dataScope) {
    const { buildOrderScopeWhere } = require('../../lib/dataScope');
    const ow = buildOrderScopeWhere(alias, options.dataScope);
    if (ow.empty) {
      return { sql: '', params: [], invalidShop: true, emptyScope: true };
    }
    if (ow.sql) {
      parts.push(String(ow.sql).replace(/^\s*AND\s+/i, '').trim());
      params.push(...ow.params);
    }
  }

  const dr = buildDateRangeWhere(contract, alias);
  parts.push(String(dr.sql).replace(/^\s*AND\s+/i, '').trim());
  params.push(...dr.params);
  /** @type {string} */
  const dateWindow = dr.dateWindow || 'CURDATE';

  const mkt = buildMarketWhere(contract, alias);
  if (mkt.sql) {
    parts.push(String(mkt.sql).replace(/^\s*AND\s+/i, '').trim());
    params.push(...mkt.params);
  }

  if (contract.shopId && contract.shopId !== 'all') {
    const shop = await buildShopWhere(pool, tenantId, contract.shopId, alias, {
      allTenants: options.allTenantShops === true,
    });
    if (shop.invalidShop) {
      return { sql: '', params: [], invalidShop: true };
    }
    if (shop.sql) {
      parts.push(String(shop.sql).replace(/^\s*AND\s+/i, '').trim());
      params.push(...shop.params);
    }
  }

  let orderFilterApplied = false;
  let orderFilterWhereSql = '';
  let orderFilterStatusField = 'none';
  const orderFilterNorm = normalizeOrderFilter(contract.orderFilter);
  if (includeStatus) {
    const st = buildOrderFilterWhere(contract.orderFilter, alias);
    orderFilterWhereSql = st.sql ? String(st.sql).trim() : '';
    orderFilterStatusField = st.statusField || 'none';
    orderFilterApplied =
      orderFilterNorm !== 'all' && Boolean(orderFilterWhereSql);
    if (st.sql) {
      parts.push(String(st.sql).replace(/^\s*AND\s+/i, '').trim());
      params.push(...st.params);
    }
  }

  const sql = parts.filter(Boolean).map((p) => `(${p})`).join(' AND ');
  const usedMarketField =
    contract.market && String(contract.market).toUpperCase() !== 'ALL'
      ? `${alias}.market`
      : 'none';
  const usedStatusField =
    includeStatus && orderFilterNorm !== 'all'
      ? orderFilterStatusField
      : includeStatus
        ? `${alias}.analytics_status`
        : 'none';
  const usedDateField = dr.timeField || orderAnalyticsEventTimeExpr(alias);
  const filterHash = buildFilterHash(contract, sql, params);

  return {
    sql: sql ? ` AND (${sql})` : '',
    params,
    invalidShop: false,
    dateWindow,
    timeField: usedDateField,
    timeWhereSql: dr.sql ? String(dr.sql).trim() : '',
    orderFilter: orderFilterNorm,
    orderFilterApplied,
    orderFilterWhereSql,
    /** dashboard 契约 API：analytics_status 主筛（order_status 仅 NULL 兜底） */
    orderFilterStatusSupported: includeStatus,
    usedMarketField,
    usedStatusField,
    usedDateField,
    filterHash,
  };
}

/**
 * buildDashboardWhere 已含 tenant_id（skipTenant=false）；禁止再 prepend tenantId。
 * @param {{ params?: unknown[] }} where
 */
function dashboardWhereParams(where) {
  return Array.isArray(where?.params) ? [...where.params] : [];
}

/**
 * order_items JOIN：WHERE 首段为 oi.tenant_id = ?，其后接 orders alias 的 where.sql。
 * @param {number} tenantId
 * @param {{ params?: unknown[] }} where
 * @param {{ skipTenant?: boolean }} [opts]
 */
function dashboardOrderItemsJoinParams(tenantId, where, opts = {}) {
  if (opts.skipTenant) return dashboardWhereParams(where);
  const tid = Number(tenantId);
  if (!Number.isFinite(tid)) return dashboardWhereParams(where);
  return [tid, ...dashboardWhereParams(where)];
}

/**
 * @param {DashboardFilterContract} contract
 * @param {string} sql
 * @param {unknown[]} params
 */
function buildFilterHash(contract, sql, params) {
  const payload = JSON.stringify({
    tenantId: contract.tenantId,
    shopId: contract.shopId,
    market: contract.market,
    orderFilter: contract.orderFilter,
    timeRange: contract.timeRange,
    startDate: contract.startDate,
    endDate: contract.endDate,
    sql: String(sql || '').replace(/\s+/g, ' ').trim(),
    params,
  });
  return crypto.createHash('sha256').update(payload).digest('hex').slice(0, 12);
}

/**
 * 诊断：与 summary/ranking 同 WHERE 的订单数（用于 sql_contract_mismatch_suspected）。
 * @param {import('mysql2/promise').Pool} pool
 * @param {{ sql?: string, params?: unknown[], invalidShop?: boolean }} where
 */
async function countDashboardOrdersMatchingWhere(pool, where) {
  if (!pool || where?.invalidShop) return 0;
  const [rows] = await pool.query(
    `SELECT ${dashboardOrderCountExpr('o')} AS c FROM orders o WHERE 1=1 ${where.sql || ''}`,
    dashboardWhereParams(where),
  );
  const row = Array.isArray(rows) && rows[0] ? rows[0] : null;
  return Number(row?.c) || 0;
}

/**
 * rows=0 时若同 WHERE 仍有订单 → sql_contract_mismatch_suspected
 * @param {import('mysql2/promise').Pool} pool
 * @param {{ sql?: string, params?: unknown[], invalidShop?: boolean, filterHash?: string }} where
 * @param {number} resultRows
 */
async function resolveDashboardStatsReason(pool, where, resultRows) {
  if (Number(resultRows) > 0 || where?.invalidShop) return '';
  const matched = await countDashboardOrdersMatchingWhere(pool, where);
  if (matched > 0) return 'sql_contract_mismatch_suspected';
  return 'no_orders_matched_filter';
}

/**
 * @param {string} endpoint
 * @param {DashboardFilterContract} contract
 * @param {Record<string, string|number>} [meta]
 */
function logDashboardContract(endpoint, contract, meta = {}) {
  const parts = [
    '[dashboard-contract]',
    `endpoint=${endpoint}`,
    `source=${meta.source || 'mysql'}`,
    `tenantId=${contract?.tenantId != null ? contract.tenantId : ''}`,
    `shopId=${contract.shopId ?? 'all'}`,
    `market=${contract.market ?? 'ALL'}`,
    `orderStatus=${contract.orderFilter ?? 'all'}`,
    `timeRange=${contract.timeRange ?? ''}`,
    `startDate=${contract.startDate ?? ''}`,
    `endDate=${contract.endDate ?? ''}`,
  ];
  if (meta.filterHash) parts.push(`filterHash=${meta.filterHash}`);
  if (meta.usedMarketField) parts.push(`usedMarketField=${meta.usedMarketField}`);
  if (meta.usedStatusField) parts.push(`usedStatusField=${meta.usedStatusField}`);
  if (meta.usedDateField) parts.push(`usedDateField=${meta.usedDateField}`);
  for (const [k, v] of Object.entries(meta)) {
    if (
      v != null &&
      String(v) !== '' &&
      !['source', 'filterHash', 'usedMarketField', 'usedStatusField', 'usedDateField'].includes(k)
    ) {
      parts.push(`${k}=${v}`);
    }
  }
  console.log(parts.join(' '));
}

/**
 * 大屏 HTTP 契约：归一化 orderFilter 别名；paid 与 valid 分离（禁止将 paid 映射为 valid）。
 * @param {DashboardFilterContract} contract
 */
function contractForDashboardApi(contract) {
  const { normalizeOrderFilter } = require('./filterBuilder');
  return { ...contract, orderFilter: normalizeOrderFilter(contract.orderFilter) };
}

/** cache / snapshot 键与 SQL 使用同一归一化 orderFilter */
function contractForDashboardCache(contract) {
  return contractForDashboardApi(contract);
}

/**
 * @deprecated 诊断脚本专用；大屏 API 请用 contractForDashboardApi
 * KPI 锁定契约：强制 analytics_status=valid
 * @param {DashboardFilterContract} contract
 */
function contractForLockedKpi(contract) {
  return { ...contract, orderFilter: LOCKED_KPI_ORDER_FILTER };
}

/** @deprecated 使用 contractForLockedKpi */
function contractForLockedTodayKpi(contract) {
  return contractForLockedKpi(contract);
}

/**
 * KPI 模块统一 WHERE（analytics_status=valid + 原契约时间/店铺/市场）
 * @param {import('mysql2/promise').Pool} pool
 * @param {number} tenantId
 * @param {DashboardFilterContract} contract
 * @param {Parameters<typeof buildDashboardWhere>[3]} [options]
 */
async function buildLockedKpiDashboardWhere(pool, tenantId, contract, options = {}) {
  return buildDashboardWhere(pool, tenantId, contractForLockedKpi(contract), options);
}

module.exports = {
  LOCKED_KPI_ORDER_FILTER,
  contractForDashboardApi,
  contractForDashboardCache,
  contractForLockedKpi,
  contractForLockedTodayKpi,
  buildLockedKpiDashboardWhere,
  dashboardGmvNativeSumExpr,
  parseDashboardFilterQuery,
  contractToAnalyticsQuery,
  resolveShopClause,
  orderAnalyticsEventTimeExpr,
  buildIndexFriendlyEventTimeWhere,
  dashboardOrderCountExpr,
  buildShopWhere,
  buildMarketWhere,
  buildOrderFilterWhere,
  buildDateRangeWhere,
  buildDashboardWhere,
  buildFilterHash,
  dashboardWhereParams,
  dashboardOrderItemsJoinParams,
  countDashboardOrdersMatchingWhere,
  resolveDashboardStatsReason,
  logDashboardContract,
  normalizeOrderFilter,
};
