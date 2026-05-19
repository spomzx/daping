'use strict';

/**
 * Analytics 统一 WHERE 条件：tenant、时间窗、market、shop、订单状态（analytics_status 列）。
 * 禁止在 Analytics SQL 中解析 raw_json；状态仅在入库/迁移时写入 `orders.analytics_status` 列。
 */

const { marketClauseOrdersOnly } = require('./analyticsMysqlScope');
const { normalizeOrderFilter } = require('./orderFilter');

/**
 * @param {import('mysql2/promise').Pool} pool
 * @param {number} tenantId
 * @param {string} [shopRaw]
 * @param {string} [alias]
 * @param {{ allTenants?: boolean }} [opts]
 * @returns {Promise<{ sql: string, params: unknown[] } | null>}
 */
async function resolveShopClause(pool, tenantId, shopRaw, alias = 'o', opts = {}) {
  const allTenants = opts.allTenants === true;
  const raw = String(shopRaw || '').trim();
  if (!raw || raw.toLowerCase() === 'all') {
    return { sql: '', params: [] };
  }
  if (/^\d+$/.test(raw)) {
    const id = Number(raw);
    if (allTenants) {
      const [rows] = await pool.query('SELECT id FROM shops WHERE id = ? AND status <> ? LIMIT 1', [
        id,
        'deleted',
      ]);
      const ok = Array.isArray(rows) && rows.length > 0;
      if (!ok) return null;
      return { sql: ` AND ${alias}.shop_id = ? `, params: [id] };
    }
    const [rows] = await pool.query(
      'SELECT id FROM shops WHERE tenant_id = ? AND id = ? AND status <> ? LIMIT 1',
      [tenantId, id, 'deleted'],
    );
    const ok = Array.isArray(rows) && rows.length > 0;
    if (!ok) return null;
    return { sql: ` AND ${alias}.shop_id = ? `, params: [id] };
  }
  const sid = raw.toLowerCase();
  if (allTenants) {
    const [rows] = await pool.query(
      "SELECT id FROM shops WHERE LOWER(TRIM(platform_shop_id)) = ? AND status <> 'deleted' LIMIT 1",
      [sid],
    );
    if (!Array.isArray(rows) || rows.length === 0) return null;
    return { sql: ` AND ${alias}.shop_id = ? `, params: [rows[0].id] };
  }
  const [rows] = await pool.query(
    "SELECT id FROM shops WHERE tenant_id = ? AND LOWER(platform_shop_id) = ? AND status <> 'deleted' LIMIT 1",
    [tenantId, sid],
  );
  if (!Array.isArray(rows) || rows.length === 0) return null;
  return { sql: ` AND ${alias}.shop_id = ? `, params: [rows[0].id] };
}

/**
 * @param {string} alias
 * @param {unknown} qStatus
 * @returns {{ sql: string, params: unknown[] }}
 */
function analyticsStatusCondition(alias, qStatus) {
  const f = normalizeOrderFilter(qStatus);
  if (f === 'all') return { sql: '', params: [] };
  return { sql: ` AND ${alias}.analytics_status = ? `, params: [f] };
}

/**
 * 与 dashboard 缓存侧 `getCreateEpochSec` 一致：创建类 → 支付 → 更新，用于 Analytics 时间窗与 gmv-compare 分桶。
 * @param {string} [alias]
 */
function orderAnalyticsEventTimeExpr(alias = 'o') {
  return `COALESCE(${alias}.paid_at, ${alias}.created_at_platform, ${alias}.created_at)`;
}

/**
 * @param {{ range?: string, hours?: string|number, analytics_time_from?: Date|number }} q
 * @returns {number}
 */
function resolveHoursFromQuery(q) {
  const r = String(q.range || '').toLowerCase();
  if (r === '7d') return 168;
  if (r === '30d') return 720;
  if (r === '24h') return 24;
  const h = Number(q.hours);
  if (Number.isFinite(h) && h > 0) return Math.min(720, Math.max(1, h));
  return 24;
}

/**
 * 统一生成 Analytics 订单范围条件（含 status）；不含 WHERE 关键字，以 ` AND ` 前缀形式拼接。
 * @param {import('mysql2/promise').Pool} pool
 * @param {number} tenantId
 * @param {{ market?: string, shop_id?: string, hours?: number|string, range?: string, status?: string, orderFilter?: string, analytics_time_from?: Date|number, analytics_time_from_epoch_sec?: number, analytics_time_until_epoch_sec?: number }} q
 * @param {{ alias?: string, includeStatus?: boolean, skipTenant?: boolean, allTenantShops?: boolean }} [options]
 * @returns {Promise<{ sql: string, params: unknown[], invalidShop: boolean }>}
 */
async function buildAnalyticsFilter(pool, tenantId, q, options = {}) {
  const alias = options.alias || 'o';
  const includeStatus = options.includeStatus !== false;
  const skipTenant = options.skipTenant === true;
  const allTenantShops = options.allTenantShops === true;
  const parts = [];
  const params = [];

  if (!skipTenant && tenantId != null && Number.isFinite(Number(tenantId))) {
    parts.push(`${alias}.tenant_id = ?`);
    params.push(Number(tenantId));
  }

  const { normalizeRange, getTimeRangeBounds } = require('./dashboardTimeRange');
  const rangeNorm = q.range ? normalizeRange(q.range) : null;

  const fromEp = q.analytics_time_from_epoch_sec;
  const untilEp = q.analytics_time_until_epoch_sec;
  if (fromEp != null && untilEp != null) {
    const fs = Math.floor(Number(fromEp));
    const us = Math.floor(Number(untilEp));
    if (Number.isFinite(fs) && Number.isFinite(us) && us >= fs) {
      const te = orderAnalyticsEventTimeExpr(alias);
      parts.push(`${te} >= FROM_UNIXTIME(?)`);
      params.push(fs);
      parts.push(`${te} <= FROM_UNIXTIME(?)`);
      params.push(us);
    }
  } else if (q.analytics_time_from != null) {
    const ts = q.analytics_time_from instanceof Date ? q.analytics_time_from.getTime() : Number(q.analytics_time_from);
    const d = Number.isFinite(ts) ? new Date(ts) : new Date(q.analytics_time_from);
    const te = orderAnalyticsEventTimeExpr(alias);
    parts.push(`${te} >= ?`);
    params.push(d);
    parts.push(`${te} < NOW(3)`);
  } else if (rangeNorm) {
    const tb = getTimeRangeBounds(rangeNorm, q.startDate, q.endDate);
    const te = orderAnalyticsEventTimeExpr(alias);
    parts.push(`${te} >= FROM_UNIXTIME(?)`);
    params.push(tb.startSec);
    parts.push(`${te} <= FROM_UNIXTIME(?)`);
    params.push(tb.endSec);
  } else {
    const hours = resolveHoursFromQuery(q);
    const te = orderAnalyticsEventTimeExpr(alias);
    parts.push(`${te} >= DATE_SUB(NOW(3), INTERVAL ? HOUR)`);
    params.push(hours);
  }

  const mkt = marketClauseOrdersOnly(alias, q.market);
  if (mkt.sql) {
    parts.push(String(mkt.sql).replace(/^\s*AND\s+/i, '').trim());
    params.push(...mkt.params);
  }

  const shopRaw = q.shop_id;
  if (shopRaw != null && String(shopRaw).trim() !== '' && String(shopRaw).trim().toLowerCase() !== 'all') {
    const shopPart = await resolveShopClause(pool, tenantId, shopRaw, alias, { allTenants: allTenantShops });
    if (!shopPart) {
      return { sql: '', params: [], invalidShop: true };
    }
    if (shopPart.sql) {
      parts.push(String(shopPart.sql).replace(/^\s*AND\s+/i, '').trim());
      params.push(...shopPart.params);
    }
  }

  if (includeStatus) {
    const st = analyticsStatusCondition(alias, q.status ?? q.orderFilter);
    if (st.sql) {
      parts.push(String(st.sql).replace(/^\s*AND\s+/i, '').trim());
      params.push(...st.params);
    }
  }

  const sql = parts.map((p) => `(${p})`).join(' AND ');
  return { sql: ` AND (${sql})`, params, invalidShop: false };
}

module.exports = {
  buildAnalyticsFilter,
  resolveShopClause,
  analyticsStatusCondition,
  resolveHoursFromQuery,
  orderAnalyticsEventTimeExpr,
};
