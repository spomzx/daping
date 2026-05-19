'use strict';

/**
 * Analytics MySQL 服务：统一 `buildAnalyticsFilter`（tenant / 时间窗 / market / shop / analytics_status）。
 */

const { getMysqlPool } = require('../../db/mysqlPool');
const {
  normalizeCurrency,
  getCurrencyByMarket,
  convertToUSDSync,
  preloadUsdRates,
} = require('../../lib/currency');
const { marketColorHex, orderLevelFromUsd, isLargeOrderUsd, isMultiItem } = require('../../lib/marketOrderMeta');
const { normalizeOrderFilter } = require('../../lib/orderFilter');
const {
  buildAnalyticsFilter,
  resolveShopClause,
  analyticsStatusCondition,
  orderAnalyticsEventTimeExpr,
} = require('../../lib/analyticsFilter');
const { getTimeRangeBounds, normalizeRange } = require('../../lib/dashboardTimeRange');
const {
  resolveOrderCurrency,
  pickOrderAmount,
  amountToUsd,
  amountToUsdWithStatus,
  preloadUsdRates: preloadUsdRatesRows,
} = require('../../lib/orderRowMoney');
const { marketClauseOrdersOnly } = require('../../lib/analyticsMysqlScope');
const { logAnalyticsQuerySlow } = require('../../lib/analyticsQueryLog');
const { isPlatformScope } = require('../../lib/userScope');
const { strictAnalyticsFilterOpts } = require('../../lib/resolveTenantShop');

/** @param {unknown} auth */
function afOpts(_auth) {
  return strictAnalyticsFilterOpts();
}

/** @param {unknown} auth */
function cacheScope(tenantId, auth) {
  return auth && isPlatformScope(auth) ? 'super_admin' : String(tenantId);
}

/** Analytics 内存缓存 60s；键含 status / market / shop / hours / sort / granularity（gmv-compare 另见 compare 服务） */
const CACHE_TTL_MS = Math.min(120000, Math.max(15000, Number(process.env.ANALYTICS_CACHE_TTL_MS || 60000)));
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

function cacheKey(route, tenantId, parts) {
  return `${route}:${tenantId}:${JSON.stringify(parts)}`;
}

/** @param {string} name */
function logSqlError(name, err) {
  console.error('[analytics] SQL error', name, err && err.message ? err.message : err);
}

/** @param {string} name @param {number} ms */
function logSlow(name, ms) {
  if (ms > 1000) {
    console.warn('[analytics] slow', name, `${ms}ms`);
  }
}

async function timedQuery(name, fn) {
  const t0 = Date.now();
  try {
    return await fn();
  } catch (e) {
    logSqlError(name, e);
    throw e;
  } finally {
    logSlow(name, Date.now() - t0);
  }
}

/**
 * @param {number} tenantId
 * @param {{ market?: string, shop_id?: string, hours?: number, limit?: number, sort?: string }} q
 *   sort: qty | gmv | orders
 */
async function getTopProducts(tenantId, q, auth = null) {
  const pool = getMysqlPool();
  if (!pool) throw Object.assign(new Error('mysql_unavailable'), { code: 'mysql_unavailable' });

  const fo = afOpts(auth);
  const hours = Math.min(720, Math.max(1, Number(q.hours) || 24));
  const limit = Math.min(200, Math.max(1, Number(q.limit) || 20));
  const sortRaw = String(q.sort || 'qty').toLowerCase();
  let sort = 'qty';
  if (sortRaw === 'gmv') sort = 'gmv';
  else if (sortRaw === 'orders' || sortRaw === 'order') sort = 'orders';

  const st = normalizeOrderFilter(q.status ?? q.orderFilter);
  const ck = cacheKey('top-products', cacheScope(tenantId, auth), {
    market: String(q.market ?? '').trim() || 'ALL',
    shop_id: String(q.shop_id ?? '').trim() || 'all',
    hours,
    limit,
    sort,
    status: st,
    granularity: 'list',
  });
  const hit = cacheGet(ck);
  if (hit !== undefined) return hit;

  const af = await buildAnalyticsFilter(pool, tenantId, { ...q, hours }, fo);
  if (af.invalidShop) {
    const empty = [];
    cacheSet(ck, empty);
    return empty;
  }

  const grpExpr = `IF(
        TRIM(COALESCE(oi.product_id, '')) <> '' AND TRIM(COALESCE(oi.sku_id, '')) <> '',
        CONCAT('id:', oi.product_id, CHAR(31), oi.sku_id),
        CONCAT('nm:', LEFT(COALESCE(oi.product_name, ''), 64), CHAR(31), LEFT(COALESCE(oi.sku_name, ''), 64))
      )`;

  const oiTenantClause = fo.skipTenant ? '1=1' : 'oi.tenant_id = ?';

  const sql = `
    SELECT
      ${grpExpr} AS grp_key,
      MAX(COALESCE(oi.product_name, '')) AS product_name,
      MAX(COALESCE(oi.sku_name, '')) AS sku_name,
      SUM(oi.quantity) AS qty,
      SUM(oi.total_amount) AS gmv,
      COUNT(DISTINCT o.platform_order_id) AS orders,
      UPPER(MAX(COALESCE(NULLIF(TRIM(oi.market), ''), NULLIF(TRIM(o.market), ''), ''))) AS market,
      MAX(COALESCE(NULLIF(TRIM(oi.shop_name), ''), NULLIF(TRIM(s.shop_name), ''), '')) AS shop_name,
      UPPER(COALESCE(NULLIF(TRIM(oi.currency), ''), NULLIF(TRIM(o.currency), ''), '')) AS line_currency
    FROM order_items oi
    INNER JOIN orders o
      ON o.tenant_id = oi.tenant_id AND o.platform = oi.platform AND o.platform_order_id = oi.platform_order_id
    LEFT JOIN shops s ON s.id = oi.shop_id AND s.tenant_id = oi.tenant_id
    WHERE ${oiTenantClause}
      ${af.sql}
    GROUP BY ${grpExpr}, UPPER(COALESCE(NULLIF(TRIM(oi.currency), ''), NULLIF(TRIM(o.currency), ''), ''))
    ORDER BY SUM(oi.quantity) DESC
    LIMIT 500
  `;

  const params = fo.skipTenant ? [...af.params] : [tenantId, ...af.params];

  const tq0 = Date.now();
  const rows = await timedQuery('top-products', async () => {
    const [r] = await pool.query(sql, params);
    return Array.isArray(r) ? r : [];
  });
  logAnalyticsQuerySlow('top-products', st, Date.now() - tq0, rows.length);

  const curSet = rows.map((row) => {
    const lc = String(row.line_currency || '').trim();
    return normalizeCurrency(lc) || getCurrencyByMarket(String(row.market || '')) || 'USD';
  });
  const rates = await preloadUsdRates(curSet);

  const merged = new Map();
  for (const row of rows) {
    const key = String(row.grp_key || '');
    if (!key) continue;
    const cur =
      normalizeCurrency(String(row.line_currency || '').trim()) ||
      getCurrencyByMarket(String(row.market || '')) ||
      'USD';
    const gmvNative = Number(row.gmv) || 0;
    const gmvUsd = convertToUSDSync(gmvNative, cur, rates[cur]);
    const prev =
      merged.get(key) ||
      ({
        product_name: String(row.product_name || ''),
        sku_name: String(row.sku_name || ''),
        qty: 0,
        gmv_usd: 0,
        orders: 0,
        market: String(row.market || ''),
        shop_name: String(row.shop_name || ''),
      });
    prev.qty += Number(row.qty) || 0;
    prev.gmv_usd += gmvUsd;
    prev.orders += Number(row.orders) || 0;
    if (!prev.market && row.market) prev.market = String(row.market || '');
    if (!prev.shop_name && row.shop_name) prev.shop_name = String(row.shop_name || '');
    merged.set(key, prev);
  }

  const list = [...merged.values()];
  if (sort === 'gmv') {
    list.sort((a, b) => b.gmv_usd - a.gmv_usd);
  } else if (sort === 'orders') {
    list.sort((a, b) => b.orders - a.orders);
  } else {
    list.sort((a, b) => b.qty - a.qty);
  }

  const out = list.slice(0, limit).map((row) => ({
    product_name: row.product_name,
    sku_name: row.sku_name,
    qty: row.qty,
    gmv: Number(row.gmv_usd.toFixed(2)),
    gmv_currency: 'USD',
    orders: row.orders,
    market: row.market,
    shop_name: row.shop_name,
  }));

  cacheSet(ck, out);
  return out;
}

/**
 * @param {number} tenantId
 * @param {{ shop_id?: string, market?: string, groupBy?: string, hours?: number }} q
 * @param {unknown} [auth]
 */
async function getShopTrend(tenantId, q, auth = null) {
  const pool = getMysqlPool();
  if (!pool) throw Object.assign(new Error('mysql_unavailable'), { code: 'mysql_unavailable' });

  const fo = afOpts(auth);
  const hours = Math.min(720, Math.max(1, Number(q.hours) || 24));
  const groupBy = String(q.groupBy || 'hour').toLowerCase() === 'day' ? 'day' : 'hour';
  const evt = orderAnalyticsEventTimeExpr('o');
  const dateFmt =
    groupBy === 'day'
      ? `DATE_FORMAT(${evt}, '%Y-%m-%d 00:00:00')`
      : `DATE_FORMAT(${evt}, '%Y-%m-%d %H:00:00')`;

  const ck = cacheKey('shop-trend', cacheScope(tenantId, auth), { ...q, hours, groupBy });
  const hit = cacheGet(ck);
  if (hit !== undefined) return hit;

  const shopPart = await timedQuery('resolveShop-trend', () =>
    resolveShopClause(pool, tenantId, q.shop_id, 'o', { allTenants: fo.allTenantShops }),
  );
  if (q.shop_id && String(q.shop_id).trim() && String(q.shop_id).toLowerCase() !== 'all' && !shopPart) {
    cacheSet(ck, []);
    return [];
  }

  const mkt = marketClauseOrdersOnly('o', q.market);

  const subOi = fo.skipTenant
    ? `SELECT tenant_id, platform, platform_order_id, SUM(quantity) AS line_qty
      FROM order_items
      GROUP BY tenant_id, platform, platform_order_id`
    : `SELECT tenant_id, platform, platform_order_id, SUM(quantity) AS line_qty
      FROM order_items
      WHERE tenant_id = ?
      GROUP BY tenant_id, platform, platform_order_id`;

  const oTenantClause = fo.skipTenant ? '1=1' : 'o.tenant_id = ?';

  const rangeNorm = normalizeRange(q.range ?? (hours === 24 ? 'today' : ''));
  let timeClause = `${evt} >= DATE_SUB(NOW(3), INTERVAL ? HOUR)`;
  /** @type {unknown[]} */
  const timeParams = [hours];
  if (rangeNorm === 'today' || rangeNorm === 'yesterday') {
    const tb = getTimeRangeBounds(rangeNorm, q.startDate, q.endDate);
    timeClause = `${evt} >= FROM_UNIXTIME(?) AND ${evt} <= FROM_UNIXTIME(?)`;
    timeParams.length = 0;
    timeParams.push(tb.startSec, tb.endSec);
  } else if (rangeNorm === 'last7' || rangeNorm === 'last30' || rangeNorm === 'custom') {
    const tb = getTimeRangeBounds(rangeNorm, q.startDate, q.endDate);
    timeClause = `${evt} >= FROM_UNIXTIME(?) AND ${evt} <= FROM_UNIXTIME(?)`;
    timeParams.length = 0;
    timeParams.push(tb.startSec, tb.endSec);
  }

  const sql = `
    SELECT
      ${dateFmt} AS time,
      UPPER(COALESCE(NULLIF(TRIM(o.currency), ''), '')) AS line_currency,
      UPPER(COALESCE(NULLIF(TRIM(o.market), ''), '')) AS market,
      COUNT(DISTINCT o.platform_order_id) AS orders,
      COALESCE(SUM(o.total_amount), 0) AS gmv,
      COALESCE(SUM(oi_sum.line_qty), 0) AS items
    FROM orders o
    LEFT JOIN (
      ${subOi}
    ) oi_sum
      ON oi_sum.tenant_id = o.tenant_id
     AND oi_sum.platform = o.platform
     AND oi_sum.platform_order_id = o.platform_order_id
    WHERE ${oTenantClause}
      AND ${timeClause}
      ${shopPart ? shopPart.sql : ''}
      ${mkt.sql}
    GROUP BY ${dateFmt},
      UPPER(COALESCE(NULLIF(TRIM(o.currency), ''), '')),
      UPPER(COALESCE(NULLIF(TRIM(o.market), ''), ''))
    ORDER BY time ASC
  `;

  const params = fo.skipTenant
    ? [...timeParams, ...(shopPart ? shopPart.params : []), ...mkt.params]
    : [tenantId, tenantId, ...timeParams, ...(shopPart ? shopPart.params : []), ...mkt.params];

  const rows = await timedQuery('shop-trend', async () => {
    const [r] = await pool.query(sql, params);
    return Array.isArray(r) ? r : [];
  });

  const curSet = rows.map((row) =>
    normalizeCurrency(String(row.line_currency || '').trim()) ||
      getCurrencyByMarket(String(row.market || '')) ||
      'USD',
  );
  const rates = await preloadUsdRatesRows(curSet.length ? curSet : ['USD', 'THB', 'MYR', 'VND', 'PHP']);

  const byTime = new Map();
  for (const row of rows) {
    const t = String(row.time || '');
    if (!t) continue;
    const cur =
      normalizeCurrency(String(row.line_currency || '').trim()) ||
      getCurrencyByMarket(String(row.market || '')) ||
      'USD';
    const gmvUsd = amountToUsd(Number(row.gmv) || 0, cur, rates);
    const prev = byTime.get(t) || { time: t, orders: 0, gmv: 0, items: 0 };
    prev.orders += Number(row.orders) || 0;
    prev.items += Number(row.items) || 0;
    prev.gmv += gmvUsd;
    byTime.set(t, prev);
  }

  const out = [...byTime.values()].map((row) => ({
    time: row.time,
    orders: row.orders,
    gmv: Number(row.gmv.toFixed(2)),
    gmv_currency: 'USD',
    items: row.items,
  }));

  cacheSet(ck, out);
  return out;
}

/**
 * @param {number} tenantId
 * @param {{ range?: string, sort?: string, limit?: number }} q
 * range: 24h | 7d | 30d
 * sort: gmv | orders | items
 */
async function getTopShops(tenantId, q, auth = null) {
  const pool = getMysqlPool();
  if (!pool) throw Object.assign(new Error('mysql_unavailable'), { code: 'mysql_unavailable' });

  const fo = afOpts(auth);
  const range = String(q.range || '24h').toLowerCase();
  let hours = 24;
  if (range === '7d') hours = 168;
  else if (range === '30d') hours = 720;

  const sortRaw = String(q.sort || 'gmv').toLowerCase();
  let orderCol = 'gmv';
  if (sortRaw === 'orders' || sortRaw === 'order') orderCol = 'orders';
  else if (sortRaw === 'items' || sortRaw === 'qty') orderCol = 'items';

  const limit = Math.min(100, Math.max(1, Number(q.limit) || 30));

  const st = normalizeOrderFilter(q.status ?? q.orderFilter);
  const ck = cacheKey('top-shops', cacheScope(tenantId, auth), {
    market: String(q.market ?? '').trim() || 'ALL',
    shop_id: String(q.shop_id ?? '').trim() || 'all',
    range,
    hours,
    sort: orderCol,
    limit,
    status: st,
    granularity: 'list',
  });
  const hit = cacheGet(ck);
  if (hit !== undefined) return hit;

  const af = await buildAnalyticsFilter(pool, tenantId, { ...q, hours }, fo);
  if (af.invalidShop) {
    cacheSet(ck, []);
    return [];
  }

  const subOi = fo.skipTenant
    ? `SELECT tenant_id, platform, platform_order_id, SUM(quantity) AS line_qty
      FROM order_items
      GROUP BY tenant_id, platform, platform_order_id`
    : `SELECT tenant_id, platform, platform_order_id, SUM(quantity) AS line_qty
      FROM order_items
      WHERE tenant_id = ?
      GROUP BY tenant_id, platform, platform_order_id`;

  const sql = `
    SELECT
      o.shop_id AS shop_id,
      MAX(COALESCE(s.shop_name, o.shop_name, '')) AS shop_name,
      UPPER(MAX(COALESCE(s.market, o.market, ''))) AS market,
      UPPER(COALESCE(NULLIF(TRIM(o.currency), ''), '')) AS currency_key,
      COUNT(DISTINCT o.id) AS orders,
      COALESCE(SUM(o.total_amount), 0) AS gmv,
      COALESCE(SUM(oi_sum.line_qty), 0) AS items
    FROM orders o
    LEFT JOIN shops s ON s.id = o.shop_id AND s.tenant_id = o.tenant_id
    LEFT JOIN (
      ${subOi}
    ) oi_sum
      ON oi_sum.tenant_id = o.tenant_id
     AND oi_sum.platform = o.platform
     AND oi_sum.platform_order_id = o.platform_order_id
    WHERE 1=1
      ${af.sql}
    GROUP BY o.shop_id, UPPER(COALESCE(NULLIF(TRIM(o.currency), ''), ''))
  `;

  const tq0 = Date.now();
  const rows = await timedQuery('top-shops', async () => {
    const params = fo.skipTenant ? [...af.params] : [tenantId, ...af.params];
    const [r] = await pool.query(sql, params);
    return Array.isArray(r) ? r : [];
  });
  logAnalyticsQuerySlow('top-shops', st, Date.now() - tq0, rows.length);

  const curSet = rows.map((row) => {
    const ck = String(row.currency_key || '').trim();
    return normalizeCurrency(ck) || getCurrencyByMarket(String(row.market || '')) || 'USD';
  });
  const rates = await preloadUsdRates(curSet);

  const shopMap = new Map();
  for (const row of rows) {
    const sid = row.shop_id != null ? Number(row.shop_id) : null;
    if (sid == null) continue;
    const cur =
      normalizeCurrency(String(row.currency_key || '').trim()) ||
      getCurrencyByMarket(String(row.market || '')) ||
      'USD';
    const gmvUsd = convertToUSDSync(Number(row.gmv) || 0, cur, rates[cur]);
    const prev =
      shopMap.get(sid) ||
      ({
        shop_id: sid,
        shop_name: String(row.shop_name || ''),
        market: String(row.market || ''),
        orders: 0,
        items: 0,
        gmv_usd: 0,
      });
    prev.orders += Number(row.orders) || 0;
    prev.items += Number(row.items) || 0;
    prev.gmv_usd += gmvUsd;
    if (!prev.shop_name && row.shop_name) prev.shop_name = String(row.shop_name || '');
    if (!prev.market && row.market) prev.market = String(row.market || '');
    shopMap.set(sid, prev);
  }

  const list = [...shopMap.values()];
  if (orderCol === 'orders') {
    list.sort((a, b) => b.orders - a.orders);
  } else if (orderCol === 'items') {
    list.sort((a, b) => b.items - a.items);
  } else {
    list.sort((a, b) => b.gmv_usd - a.gmv_usd);
  }

  const out = list.slice(0, limit).map((row) => ({
    shop_id: row.shop_id,
    shop_name: row.shop_name,
    market: row.market,
    orders: row.orders,
    gmv: Number(row.gmv_usd.toFixed(2)),
    gmv_currency: 'USD',
    items: row.items,
  }));

  cacheSet(ck, out);
  return out;
}

/**
 * @param {number} tenantId
 * @param {{ market?: string, shop_id?: string, limit?: number, hours?: number|string, status?: string }} q
 */
async function getRecentOrders(tenantId, q, auth = null) {
  const pool = getMysqlPool();
  if (!pool) throw Object.assign(new Error('mysql_unavailable'), { code: 'mysql_unavailable' });

  const fo = afOpts(auth);
  const limit = Math.min(100, Math.max(1, Number(q.limit) || 40));
  const hours = Math.min(720, Math.max(1, Number(q.hours) || 24));

  const st = normalizeOrderFilter(q.status ?? q.orderFilter);
  const ck = cacheKey('recent-orders', cacheScope(tenantId, auth), {
    market: String(q.market ?? '').trim() || 'ALL',
    shop_id: String(q.shop_id ?? '').trim() || 'all',
    hours,
    limit,
    status: st,
    granularity: 'list',
  });
  const hit = cacheGet(ck);
  if (hit !== undefined) return hit;

  const af = await buildAnalyticsFilter(pool, tenantId, { ...q, hours }, fo);
  if (af.invalidShop) {
    cacheSet(ck, []);
    return [];
  }

  const subOi = fo.skipTenant
    ? `SELECT tenant_id, platform, platform_order_id, SUM(quantity) AS line_qty
      FROM order_items
      GROUP BY tenant_id, platform, platform_order_id`
    : `SELECT tenant_id, platform, platform_order_id, SUM(quantity) AS line_qty
      FROM order_items
      WHERE tenant_id = ?
      GROUP BY tenant_id, platform, platform_order_id`;

  const sql = `
    SELECT
      o.platform_order_id,
      o.shop_id AS shop_id,
      COALESCE(NULLIF(TRIM(o.shop_name), ''), NULLIF(TRIM(s.shop_name), ''), '') AS shop_name,
      UPPER(COALESCE(NULLIF(TRIM(o.market), ''), NULLIF(TRIM(s.market), ''), '')) AS market,
      UPPER(COALESCE(NULLIF(TRIM(o.currency), ''), '')) AS currency,
      o.total_amount AS amount,
      COALESCE(oi_sum.line_qty, 0) AS items,
      o.created_at_platform AS created_at_platform
    FROM orders o
    LEFT JOIN shops s ON s.id = o.shop_id AND s.tenant_id = o.tenant_id
    LEFT JOIN (
      ${subOi}
    ) oi_sum
      ON oi_sum.tenant_id = o.tenant_id
     AND oi_sum.platform = o.platform
     AND oi_sum.platform_order_id = o.platform_order_id
    WHERE 1=1
      ${af.sql}
    ORDER BY COALESCE(o.created_at_platform, o.created_at) DESC
    LIMIT ${limit}
  `;

  const tq0 = Date.now();
  const rows = await timedQuery('recent-orders', async () => {
    const params = fo.skipTenant ? [...af.params] : [tenantId, ...af.params];
    const [r] = await pool.query(sql, params);
    return Array.isArray(r) ? r : [];
  });
  logAnalyticsQuerySlow('recent-orders', st, Date.now() - tq0, rows.length);

  const curSet = rows.map((row) => resolveOrderCurrency(row));
  const rates = await preloadUsdRatesRows([...curSet, 'USD', 'THB', 'MYR', 'VND', 'PHP', 'SGD', 'CNY']);
  const cnyPer = rates.CNY || 0;

  const out = rows.map((row) => {
    const raw = pickOrderAmount(row);
    const cur = resolveOrderCurrency(row);
    const money = amountToUsdWithStatus(raw, cur, rates);
    const usdAmount = money.usd_pending ? null : money.usd;
    const cnyAmount = usdAmount != null && cnyPer > 0 ? usdAmount * cnyPer : 0;
    const rawDecimals = cur === 'VND' ? 0 : 2;
    const usd = usdAmount != null ? Number(Number(usdAmount).toFixed(2)) : null;
    const exchange_rate = money.exchange_rate;
    const it = Number(row.items) || 0;
    const mkt = String(row.market || '');
    const order_level = orderLevelFromUsd(usd != null ? usd : 0);
    return {
      platform_order_id: String(row.platform_order_id || ''),
      shop_id: row.shop_id != null && Number.isFinite(Number(row.shop_id)) ? Number(row.shop_id) : null,
      shop_name: String(row.shop_name || ''),
      market: mkt,
      currency: cur,
      original_currency: cur,
      original_amount: Number(raw.toFixed(rawDecimals)),
      amount: Number(raw.toFixed(rawDecimals)),
      usd_amount: usd,
      usd_pending: money.usd_pending,
      exchange_rate,
      cny_amount: Number(cnyAmount.toFixed(2)),
      items: it,
      is_large_order: isLargeOrderUsd(usd),
      is_multi_item: isMultiItem(it),
      market_color: marketColorHex(mkt),
      order_level,
      created_at_platform: row.created_at_platform
        ? row.created_at_platform instanceof Date
          ? formatMysqlDateTime(row.created_at_platform)
          : String(row.created_at_platform)
        : '',
    };
  });

  cacheSet(ck, out);
  return out;
}

function formatMysqlDateTime(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * @param {{ range?: string, hours?: string|number }} q
 */
function debugQueryHours(q) {
  const r = String(q.range || '').toLowerCase();
  if (r === '7d') return 168;
  if (r === '30d') return 720;
  if (r === '24h') return 24;
  const h = Number(q.hours);
  if (Number.isFinite(h) && h > 0) return Math.min(720, Math.max(1, h));
  return 24;
}

/**
 * 调试：与 Analytics 列表同一时间窗/市场/店铺下，各 status 订单数（按 analytics_status 列）。
 * @param {number} tenantId
 * @param {{ market?: string, shop_id?: string, range?: string, hours?: string|number }} q
 */
async function getStatusDebugCounts(tenantId, q, auth = null) {
  const pool = getMysqlPool();
  if (!pool) throw Object.assign(new Error('mysql_unavailable'), { code: 'mysql_unavailable' });

  const fo = afOpts(auth);
  const hours = debugQueryHours(q);
  const scope = await buildAnalyticsFilter(pool, tenantId, { ...q, hours }, { includeStatus: false, ...fo });
  if (scope.invalidShop) {
    const counts = { all: 0, valid: 0, unpaid: 0, sample: 0, cancelled: 0 };
    const payload = { tenantId, hours, market: q.market, shop_id: q.shop_id, counts, note: 'invalid_shop' };
    console.log('[analytics-status-debug]', JSON.stringify(payload));
    console.log('[analytics-status-debug]', 'invalid_shop', JSON.stringify(counts));
    return payload;
  }

  /** @type {Record<string, number>} */
  const counts = {};
  const keys = ['all', 'valid', 'unpaid', 'sample', 'cancelled'];
  for (const k of keys) {
    const stPart = k === 'all' ? { sql: '', params: [] } : analyticsStatusCondition('o', k);
    const sql = `SELECT COUNT(*) AS c FROM orders o WHERE 1=1 ${scope.sql} ${stPart.sql}`;
    const resultRows = await timedQuery(`status-debug-${k}`, async () => {
      const [r] = await pool.query(sql, [...scope.params, ...stPart.params]);
      return r;
    });
    const row0 = Array.isArray(resultRows) && resultRows[0] ? resultRows[0] : { c: 0 };
    counts[k] = Number(row0.c || 0);
  }

  const payload = {
    tenantId,
    hours,
    market: String(q.market || 'ALL').trim() || 'ALL',
    shop_id: q.shop_id != null && String(q.shop_id).trim() !== '' ? String(q.shop_id) : 'all',
    counts,
  };
  console.log('[analytics-status-debug]', JSON.stringify(payload));
  console.log(
    '[analytics-status-debug]',
    `all=${counts.all} valid=${counts.valid} unpaid=${counts.unpaid} sample=${counts.sample} cancelled=${counts.cancelled} tenant=${tenantId} hours=${hours} market=${payload.market} shop=${payload.shop_id}`,
  );
  return payload;
}

/**
 * @param {number} tenantId
 * @param {{ sku?: string, product_name?: string, limit?: number }} q
 */
async function searchSku(tenantId, q, auth = null) {
  const pool = getMysqlPool();
  if (!pool) throw Object.assign(new Error('mysql_unavailable'), { code: 'mysql_unavailable' });

  const fo = afOpts(auth);

  const skuQ = String(q.sku || '').trim();
  const nameQ = String(q.product_name || '').trim();
  const term = skuQ || nameQ;
  if (!term) return [];

  const limit = Math.min(200, Math.max(1, Number(q.limit) || 50));

  const ck = cacheKey('search-sku', cacheScope(tenantId, auth), {
    search: term,
    sku: skuQ || '',
    product_name: nameQ || '',
    limit,
    status: normalizeOrderFilter(q.status ?? q.orderFilter),
  });
  const hit = cacheGet(ck);
  if (hit !== undefined) return hit;

  const like = `%${term.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')}%`;

  const oiTenantClause = fo.skipTenant ? '1=1' : 'oi.tenant_id = ?';

  const sql = `
    SELECT
      oi.id,
      oi.platform_order_id,
      oi.sku_id,
      oi.product_id,
      oi.sku_name,
      oi.product_name,
      oi.quantity,
      oi.total_amount,
      UPPER(COALESCE(NULLIF(TRIM(oi.currency), ''), NULLIF(TRIM(o.currency), ''), '')) AS line_currency,
      UPPER(COALESCE(oi.market, o.market, '')) AS market,
      COALESCE(oi.shop_name, s.shop_name, o.shop_name, '') AS shop_name,
      o.created_at_platform AS order_created_at
    FROM order_items oi
    INNER JOIN orders o
      ON o.tenant_id = oi.tenant_id AND o.platform = oi.platform AND o.platform_order_id = oi.platform_order_id
    LEFT JOIN shops s ON s.id = oi.shop_id AND s.tenant_id = oi.tenant_id
    WHERE ${oiTenantClause}
      AND (
        oi.sku_name LIKE ? ESCAPE '\\\\'
        OR oi.product_name LIKE ? ESCAPE '\\\\'
        OR oi.sku_id LIKE ? ESCAPE '\\\\'
        OR oi.product_id LIKE ? ESCAPE '\\\\'
      )
    ORDER BY COALESCE(o.created_at_platform, o.created_at) DESC
    LIMIT ${limit}
  `;

  const rows = await timedQuery('search-sku', async () => {
    const params = fo.skipTenant ? [like, like, like, like] : [tenantId, like, like, like, like];
    const [r] = await pool.query(sql, params);
    return Array.isArray(r) ? r : [];
  });

  const curSet = rows.map((row) => {
    const lc = String(row.line_currency || '').trim();
    return normalizeCurrency(lc) || getCurrencyByMarket(String(row.market || '')) || 'USD';
  });
  const rates = await preloadUsdRates(curSet);

  const out = rows.map((row) => {
    const cur =
      normalizeCurrency(String(row.line_currency || '').trim()) ||
      getCurrencyByMarket(String(row.market || '')) ||
      'USD';
    const raw = Number(row.total_amount) || 0;
    const usd = convertToUSDSync(raw, cur, rates[cur]);
    return {
      id: row.id != null ? Number(row.id) : null,
      platform_order_id: String(row.platform_order_id || ''),
      sku_id: String(row.sku_id || ''),
      product_id: String(row.product_id || ''),
      sku_name: String(row.sku_name || ''),
      product_name: String(row.product_name || ''),
      quantity: Number(row.quantity) || 0,
      total_amount: raw,
      currency: cur,
      total_amount_usd: Number(usd.toFixed(2)),
      market: String(row.market || ''),
      shop_name: String(row.shop_name || ''),
      order_created_at: row.order_created_at
        ? row.order_created_at instanceof Date
          ? formatMysqlDateTime(row.order_created_at)
          : String(row.order_created_at)
        : '',
    };
  });

  cacheSet(ck, out);
  return out;
}

module.exports = {
  getTopProducts,
  getShopTrend,
  getTopShops,
  getRecentOrders,
  searchSku,
  getStatusDebugCounts,
};
