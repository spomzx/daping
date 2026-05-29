'use strict';

const path = require('path');
const fs = require('fs');
const { getMysqlPool } = require('../../db/mysqlPool');
const { getMysqlConfig, isMysqlConfigured } = require('../../config/database');
const { isPlatformScope } = require('../../lib/userScope');
const {
  loadMysqlShopGateForTenant,
  orderMatchesEligibleMysqlGate,
} = require('../../lib/dashboardShopGate');
const {
  getCreateEpochSec,
  getOrderDedupKey,
  dedupeOrdersByOrderId,
} = require('../../tiktok-api/ordersDashboardFromCache');
const { extractLineItemsForOrder } = require('./orderLineItemsExtract');
const { orderAnalyticsEventTimeExpr } = require('../../lib/analyticsFilter');
const { isMysqlPrimaryDashboard } = require('./mysqlDashboardOrdersService');
const { cacheFileStats, ORDERS_CACHE_PATH, STORAGE_DIR } = require('../../lib/ordersCachePath');

const DEFAULT_WINDOW_HOURS = Number(process.env.RECONCILE_WINDOW_HOURS || 24) || 24;

function readJsonSafe(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function pickPlatformOrderId(o) {
  const k = getOrderDedupKey(o);
  if (k) return k;
  const raw = o?.orderId ?? o?.id ?? o?._raw?.id ?? '';
  const s = String(raw).trim();
  return s || null;
}

function normalizeStatus(v) {
  const s = String(v ?? '').trim().toLowerCase();
  return s || null;
}

function normalizeStatusFromCache(o) {
  if (!o || typeof o !== 'object') return null;
  const raw = o._raw && typeof o._raw === 'object' ? o._raw : null;
  return (
    normalizeStatus(o.orderStatus ?? o.status ?? o.order_status) ||
    normalizeStatus(raw?.order_status ?? raw?.status)
  );
}

function normalizeAmountFromCache(o) {
  const amt = Number(o?.orderAmountBase ?? o?.totalAmount ?? o?.payment?.total_amount ?? 0);
  return Number.isFinite(amt) ? Number(amt.toFixed(2)) : 0;
}

function compositeKey(platform, platformOrderId) {
  return `${String(platform).toLowerCase()}::${String(platformOrderId).trim()}`;
}

function itemReconcileCompareKey(platformOrderId, platformItemId, skuId, productId) {
  const sep = '\x1f';
  return [
    String(platformOrderId).trim(),
    String(platformItemId ?? ''),
    String(skuId ?? ''),
    String(productId ?? ''),
  ].join(sep);
}

function cacheFileMeta(cachePath) {
  try {
    if (!cachePath || !fs.existsSync(cachePath)) {
      return { cache_file_path: cachePath, cache_updated_at: null, cache_file_exists: false };
    }
    const st = fs.statSync(cachePath);
    return {
      cache_file_path: cachePath,
      cache_updated_at: st.mtime ? new Date(st.mtime).toISOString() : null,
      cache_file_exists: true,
      cache_file_size_bytes: st.size,
    };
  } catch {
    return { cache_file_path: cachePath, cache_updated_at: null, cache_file_exists: false };
  }
}

/** 全量 cache 订单索引（含窗口外），用于差异归因 */
function buildCacheAllByCompositeKey(allOrders, gate) {
  const map = new Map();
  for (const o of allOrders) {
    if (!o || typeof o !== 'object') continue;
    if (!orderMatchesEligibleMysqlGate(o, gate)) continue;
    const pid = pickPlatformOrderId(o);
    if (!pid) continue;
    const k = compositeKey('tiktok', pid);
    map.set(k, o);
  }
  return map;
}

function classifyMysqlOnlyDiff(m, cacheAllMap, cutoffSec, gate) {
  const k = compositeKey(m.platform, m.platform_order_id);
  const co = cacheAllMap.get(k);
  if (!co) {
    const pid = String(m.platform_shop_id || '').trim().toLowerCase();
    if (pid && gate.shopIdSet && !gate.shopIdSet.has(pid)) {
      return {
        diff_type: 'mysql_only',
        diff_reason: 'shop_scope_mismatch',
      };
    }
    return {
      diff_type: 'mysql_only',
      diff_reason: 'cache_not_refreshed',
    };
  }
  const ep = getCreateEpochSec(co);
  if (ep > 0 && ep < cutoffSec) {
    return {
      diff_type: 'mysql_only',
      diff_reason: 'time_window_mismatch',
    };
  }
  const cs = normalizeStatusFromCache(co);
  const ms = normalizeStatus(m.order_status);
  if (cs && ms && cs !== ms) {
    return {
      diff_type: 'mysql_only',
      diff_reason: 'status_filter_mismatch',
    };
  }
  return {
    diff_type: 'mysql_only',
    diff_reason: 'cache_not_refreshed',
  };
}

function classifyCacheOnlyDiff(c, mysqlAllInScope) {
  const k = compositeKey(c.platform, c.platform_order_id);
  if (mysqlAllInScope && mysqlAllInScope.has(k)) {
    return { diff_type: 'cache_only', diff_reason: 'time_window_mismatch' };
  }
  return { diff_type: 'cache_only', diff_reason: 'cache_not_refreshed' };
}

function buildItemDiffSample(
  itemMissingInMysql,
  itemMissingInCache,
  itemMismatchQuantity,
  itemMismatchAmount,
  limit = 20,
) {
  const out = [];
  const push = (row) => {
    if (out.length >= limit) return;
    out.push(row);
  };
  for (const x of itemMissingInCache) {
    push({
      order_id: x.platform_order_id,
      sku_id: x.sku_id,
      mysql_item_qty: x.mysqlQuantity,
      cache_item_qty: 0,
      mysql_exists: true,
      cache_exists: false,
      diff_type: 'mysql_item_only',
      diff_reason: 'cache_not_refreshed',
    });
  }
  for (const x of itemMissingInMysql) {
    push({
      order_id: x.platform_order_id,
      sku_id: x.sku_id,
      mysql_item_qty: 0,
      cache_item_qty: null,
      mysql_exists: false,
      cache_exists: true,
      diff_type: 'cache_item_only',
      diff_reason: 'cache_not_refreshed',
    });
  }
  for (const x of itemMismatchQuantity) {
    push({
      order_id: x.platform_order_id,
      sku_id: x.sku_id,
      mysql_item_qty: x.mysqlQuantity,
      cache_item_qty: x.cacheQuantity,
      mysql_exists: true,
      cache_exists: true,
      diff_type: 'qty_mismatch',
      diff_reason: 'order_id_mapping_mismatch',
    });
  }
  for (const x of itemMismatchAmount) {
    push({
      order_id: x.platform_order_id,
      sku_id: x.sku_id,
      mysql_item_qty: null,
      cache_item_qty: null,
      mysql_exists: true,
      cache_exists: true,
      diff_type: 'amount_mismatch',
      diff_reason: 'unknown',
    });
  }
  return out;
}

function summarizeDiffReasons(rows, field = 'diff_reason') {
  const counts = {};
  for (const r of rows) {
    const k = String(r[field] || 'unknown');
    counts[k] = (counts[k] || 0) + 1;
  }
  return counts;
}

/**
 * 与 cache 侧 getCreateEpochSec / Analytics 一致：创建类 → 支付 → 更新，落在近 N 小时。
 * 不用单独 updated_at 入库时间作为唯一条件，避免历史单因近期同步误判进窗。
 */
function orderCreateTimeWindowSql(alias = 'o', windowHours = DEFAULT_WINDOW_HOURS) {
  const h = windowHours;
  const evt = orderAnalyticsEventTimeExpr(alias);
  return `${evt} IS NOT NULL AND ${evt} >= DATE_SUB(NOW(3), INTERVAL ${h} HOUR)`;
}

/**
 * 对账范围：优先 shop_id；兼容 persist 时 shop_id 为空但 tenant_id 已写入的历史行。
 * @param {string} alias
 * @param {{ platformMode?: boolean, tenantId?: number | null, shopDbIds?: number[] }} ctx
 */
function buildOrderScopeSql(alias, ctx) {
  const shopDbIds = Array.isArray(ctx.shopDbIds) ? ctx.shopDbIds.filter((id) => Number.isFinite(id)) : [];
  if (shopDbIds.length === 0) {
    return { clause: '1=0', params: [] };
  }
  const ph = shopDbIds.map(() => '?').join(',');
  if (ctx.platformMode === true) {
    return {
      clause: `(
        ${alias}.shop_id IN (${ph})
        OR (
          ${alias}.shop_id IS NULL
          AND ${alias}.tenant_id IN (
            SELECT DISTINCT s.tenant_id FROM shops s WHERE s.id IN (${ph})
          )
        )
      )`,
      params: [...shopDbIds, ...shopDbIds],
    };
  }
  const tenantId = Number(ctx.tenantId);
  return {
    clause: `(
      ${alias}.shop_id IN (${ph})
      OR (${alias}.shop_id IS NULL AND ${alias}.tenant_id = ?)
    )`,
    params: [...shopDbIds, tenantId],
  };
}

/** order_items 与 orders 同范围（按 shop_id 或 tenant 兜底） */
function buildOrderItemScopeSql(alias, ctx) {
  const shopDbIds = Array.isArray(ctx.shopDbIds) ? ctx.shopDbIds.filter((id) => Number.isFinite(id)) : [];
  if (shopDbIds.length === 0) {
    return { clause: '1=0', params: [] };
  }
  const ph = shopDbIds.map(() => '?').join(',');
  if (ctx.platformMode === true) {
    return {
      clause: `(
        ${alias}.shop_id IN (${ph})
        OR (
          ${alias}.shop_id IS NULL
          AND ${alias}.tenant_id IN (
            SELECT DISTINCT s.tenant_id FROM shops s WHERE s.id IN (${ph})
          )
        )
      )`,
      params: [...shopDbIds, ...shopDbIds],
    };
  }
  const tenantId = Number(ctx.tenantId);
  return {
    clause: `(
      ${alias}.shop_id IN (${ph})
      OR (${alias}.shop_id IS NULL AND ${alias}.tenant_id = ?)
    )`,
    params: [...shopDbIds, tenantId],
  };
}

/**
 * @param {import('mysql2/promise').Pool} pool
 */
async function loadPlatformReconcileGate(pool) {
  const [rows] = await pool.query(
    `SELECT id, tenant_id, platform_shop_id, shop_name, display_name, market, region, status, hidden, sync_enabled
     FROM shops
     WHERE status = 'active' AND hidden = 0`,
  );
  const eligList = Array.isArray(rows) ? rows : [];
  const shopIdSet = new Set();
  const nameMarketKeySet = new Set();
  const shopDbIds = [];

  for (const r of eligList) {
    const pid = String(r.platform_shop_id || '').trim().toLowerCase();
    if (!pid) continue;
    shopIdSet.add(pid);
    shopDbIds.push(Number(r.id));
    const label = String(r.display_name || r.shop_name || '').trim();
    const km = `${label.toLowerCase().replace(/\s+/g, ' ')}|${String(r.market || r.region || '').trim().toUpperCase()}`;
    if (km && km !== '|') nameMarketKeySet.add(km);
  }

  return {
    tenantId: null,
    platformMode: true,
    shopIdSet,
    nameMarketKeySet,
    shopDbIds,
    eligibleShopCount: shopIdSet.size,
  };
}

/**
 * @param {import('mysql2/promise').Pool} pool
 * @param {{ platformMode?: boolean, tenantId?: number, shopDbIds?: number[] }} ctx
 */
async function countMysqlTotals(pool, ctx) {
  const orderScope = buildOrderScopeSql('o', ctx);
  const itemScope = buildOrderItemScopeSql('oi', ctx);

  let ordersTotal = 0;
  let itemsTotal = 0;

  if (orderScope.params.length > 0) {
    const [[oRow]] = await pool.query(
      `SELECT COUNT(*) AS c FROM orders o WHERE ${orderScope.clause}`,
      orderScope.params,
    );
    ordersTotal = Number(oRow?.c) || 0;

    const [[iRow]] = await pool.query(
      `SELECT COUNT(*) AS c FROM order_items oi WHERE ${itemScope.clause}`,
      itemScope.params,
    );
    itemsTotal = Number(iRow?.c) || 0;
  }

  return { ordersTotal, itemsTotal };
}

/**
 * @param {import('mysql2/promise').Pool} pool
 * @param {{ platformMode?: boolean, tenantId?: number, shopDbIds?: number[] }} ctx
 */
async function loadMysqlOrdersInWindow(pool, ctx, windowHours = DEFAULT_WINDOW_HOURS) {
  const orderScope = buildOrderScopeSql('o', ctx);
  if (orderScope.params.length === 0) return [];

  const evt = orderAnalyticsEventTimeExpr('o');
  const [rows] = await pool.query(
    `SELECT o.platform, o.platform_order_id, o.total_amount, o.order_status, o.tenant_id, o.shop_id,
            s.platform_shop_id, ${evt} AS event_time, o.created_at_platform, o.updated_at
     FROM orders o
     LEFT JOIN shops s ON s.id = o.shop_id
     WHERE ${orderScope.clause}
       AND ${orderCreateTimeWindowSql('o', windowHours)}`,
    orderScope.params,
  );

  return Array.isArray(rows) ? rows : [];
}

/**
 * @param {import('mysql2/promise').Pool} pool
 * @param {{ platformMode?: boolean, tenantId?: number, shopDbIds?: number[] }} ctx
 */
async function loadMysqlItemsInWindow(pool, ctx, windowHours = DEFAULT_WINDOW_HOURS) {
  const orderScope = buildOrderScopeSql('o', ctx);
  if (orderScope.params.length === 0) {
    return { rows: [], count: 0 };
  }

  const baseFrom = `
    FROM order_items oi
    INNER JOIN orders o
      ON o.tenant_id = oi.tenant_id
      AND o.platform = oi.platform
      AND o.platform_order_id = oi.platform_order_id
    WHERE ${orderScope.clause}
      AND ${orderCreateTimeWindowSql('o', windowHours)}
  `;

  const [[countRow]] = await pool.query(`SELECT COUNT(*) AS c ${baseFrom}`, orderScope.params);
  const [itemRows] = await pool.query(
    `SELECT oi.platform, oi.platform_order_id, oi.platform_item_id, oi.sku_id, oi.product_id, oi.quantity, oi.total_amount
     ${baseFrom}`,
    orderScope.params,
  );

  return {
    rows: Array.isArray(itemRows) ? itemRows : [],
    count: Number(countRow?.c) || 0,
  };
}

/**
 * @param {number} tenantId JWT tenant
 * @param {{ scope?: string, role?: string, user_id?: number } | null} auth
 */
async function buildOrdersReconcileReport(tenantId, auth, opts = {}) {
  const WINDOW_HOURS =
    opts.windowHours != null && Number.isFinite(Number(opts.windowHours))
      ? Math.min(720, Math.max(1, Number(opts.windowHours)))
      : DEFAULT_WINDOW_HOURS;
  const pool = getMysqlPool();
  if (!pool) {
    throw Object.assign(new Error('mysql_unavailable'), { code: 'mysql_unavailable' });
  }

  const platformMode = isPlatformScope(auth);
  let gate;
  let reconcileTenantId = Number(tenantId);

  if (platformMode) {
    gate = await loadPlatformReconcileGate(pool);
    reconcileTenantId = null;
  } else {
    gate = await loadMysqlShopGateForTenant(reconcileTenantId, { skipDashboardLog: true });
    if (!gate) {
      throw Object.assign(new Error('mysql_unavailable'), { code: 'mysql_unavailable' });
    }
    const [idRows] = await pool.query(
      `SELECT id FROM shops WHERE tenant_id = ? AND status = 'active' AND hidden = 0`,
      [reconcileTenantId],
    );
    gate.shopDbIds = (Array.isArray(idRows) ? idRows : []).map((r) => Number(r.id)).filter(Boolean);
  }

  const ctx = {
    platformMode,
    tenantId: reconcileTenantId,
    shopDbIds: gate.shopDbIds || [],
  };

  const dbMeta = isMysqlConfigured() ? getMysqlConfig() : null;
  const mysqlTotals = await countMysqlTotals(pool, ctx);

  const cutoffSec = Math.floor(Date.now() / 1000) - WINDOW_HOURS * 3600;

  const cachePath = ORDERS_CACHE_PATH;
  const pack = readJsonSafe(cachePath) || {};
  const allOrders = Array.isArray(pack.orders) ? pack.orders : [];
  const cacheMeta = { ...cacheFileMeta(cachePath), ...cacheFileStats() };
  const cacheLagMin = cacheMeta.cache_lag_minutes;
  const cacheAllByKey = buildCacheAllByCompositeKey(allOrders, gate);
  const windowStartIso = new Date(cutoffSec * 1000).toISOString();
  const windowEndIso = new Date().toISOString();
  const mysqlTimeExpr = 'COALESCE(created_at_platform, created_at, paid_at, updated_at)';
  const cacheTimeExpr = 'getCreateEpochSec(order) — create_time/createTime/paid/update 与 Analytics 一致';

  const cacheInWindow = allOrders.filter((o) => {
    if (!o || typeof o !== 'object') return false;
    if (!orderMatchesEligibleMysqlGate(o, gate)) return false;
    const ep = getCreateEpochSec(o);
    return ep >= cutoffSec;
  });
  const { orders: cacheDeduped } = dedupeOrdersByOrderId(cacheInWindow);

  const cacheMap = new Map();
  for (const o of cacheDeduped) {
    const pid = pickPlatformOrderId(o);
    if (!pid) continue;
    const platform = 'tiktok';
    const k = compositeKey(platform, pid);
    cacheMap.set(k, {
      platform,
      platform_order_id: pid.slice(0, 128),
      total_amount: normalizeAmountFromCache(o),
      order_status: normalizeStatusFromCache(o),
      shopId: String(o?.shopId ?? '').trim().toLowerCase() || null,
    });
  }

  const mysqlList = await loadMysqlOrdersInWindow(pool, ctx, WINDOW_HOURS);
  const mysqlMap = new Map();
  for (const r of mysqlList) {
    const platform = String(r.platform || 'tiktok').toLowerCase();
    const pid = String(r.platform_order_id || '').trim();
    if (!pid) continue;
    const k = compositeKey(platform, pid);
    const tamt = Number(r.total_amount);
    const amt = Number.isFinite(tamt) ? Number(tamt.toFixed(2)) : 0;
    mysqlMap.set(k, {
      platform,
      platform_order_id: pid,
      total_amount: amt,
      order_status: normalizeStatus(r.order_status),
      shop_id: r.shop_id,
      platform_shop_id: r.platform_shop_id,
      event_time: r.event_time,
      updated_at: r.updated_at,
    });
  }

  const dupScope = buildOrderScopeSql('o', ctx);
  const [dupRows] =
    dupScope.params.length > 0
      ? await pool.query(
          `SELECT o.platform, o.platform_order_id, COUNT(*) AS c
           FROM orders o
           WHERE ${dupScope.clause}
             AND ${orderCreateTimeWindowSql('o', WINDOW_HOURS)}
           GROUP BY o.platform, o.platform_order_id
           HAVING COUNT(*) > 1`,
          dupScope.params,
        )
      : [[]];

  const duplicatedOrders = (Array.isArray(dupRows) ? dupRows : []).map((r) => ({
    platform: r.platform,
    platform_order_id: r.platform_order_id,
    count: Number(r.c) || 0,
  }));

  const missingInMysql = [];
  const mismatchAmountOrders = [];
  const mismatchStatusOrders = [];

  for (const [k, c] of cacheMap) {
    const m = mysqlMap.get(k);
    if (!m) {
      const co = cacheAllByKey.get(k);
      const ep = co ? getCreateEpochSec(co) : 0;
      const cls = classifyCacheOnlyDiff(c, null);
      missingInMysql.push({
        platform: c.platform,
        platform_order_id: c.platform_order_id,
        tiktok_order_id: c.platform_order_id,
        shop_id: c.shopId,
        market: null,
        amount: c.total_amount,
        mysql_created_at: null,
        mysql_updated_at: null,
        mysql_status: null,
        cache_exists: true,
        cache_created_at: ep > 0 ? new Date(ep * 1000).toISOString() : null,
        cache_updated_at: co?.updateTime ? String(co.updateTime) : null,
        cache_status: normalizeStatusFromCache(co || c),
        diffType: cls.diff_type,
        diff_reason: cls.diff_reason,
        sourceField: 'orders-cache',
      });
    } else {
      if (Math.abs(c.total_amount - m.total_amount) > 0.009) {
        mismatchAmountOrders.push({
          platform: c.platform,
          platform_order_id: c.platform_order_id,
          cacheAmount: c.total_amount,
          mysqlAmount: m.total_amount,
        });
      }
      const cs = c.order_status;
      const ms = m.order_status;
      if (cs && ms && cs !== ms) {
        mismatchStatusOrders.push({
          platform: c.platform,
          platform_order_id: c.platform_order_id,
          cacheStatus: cs,
          mysqlStatus: ms,
        });
      }
    }
  }

  const missingInCache = [];
  for (const [k, m] of mysqlMap) {
    if (!cacheMap.has(k)) {
      const cls = classifyMysqlOnlyDiff(m, cacheAllByKey, cutoffSec, gate);
      const co = cacheAllByKey.get(k);
      const ep = co ? getCreateEpochSec(co) : 0;
      missingInCache.push({
        platform: m.platform,
        platform_order_id: m.platform_order_id,
        order_id: m.platform_order_id,
        tiktok_order_id: m.platform_order_id,
        shop_id: m.shop_id != null ? String(m.shop_id) : null,
        market: null,
        amount: m.total_amount,
        mysqlAmount: m.total_amount,
        mysql_created_at: m.event_time != null ? String(m.event_time) : null,
        mysql_updated_at: m.updated_at != null ? String(m.updated_at) : null,
        mysql_status: m.order_status,
        cache_exists: Boolean(co),
        cache_created_at: ep > 0 ? new Date(ep * 1000).toISOString() : null,
        cache_updated_at: co?.updateTime ? String(co.updateTime) : null,
        cache_status: co ? normalizeStatusFromCache(co) : null,
        shopId: m.shop_id != null ? String(m.shop_id) : null,
        platformShopId: m.platform_shop_id != null ? String(m.platform_shop_id) : null,
        createTime: m.event_time != null ? String(m.event_time) : null,
        updateTime: m.updated_at != null ? String(m.updated_at) : null,
        diffType: cls.diff_type,
        diff_reason: cls.diff_reason,
        sourceField: 'mysql.orders',
      });
    }
  }

  const ok =
    missingInMysql.length === 0 &&
    missingInCache.length === 0 &&
    mismatchAmountOrders.length === 0 &&
    mismatchStatusOrders.length === 0 &&
    duplicatedOrders.length === 0;

  const diffCount =
    missingInMysql.length +
    missingInCache.length +
    mismatchAmountOrders.length +
    mismatchStatusOrders.length +
    duplicatedOrders.length;

  let itemCacheRows = 0;
  let noItems = 0;
  const cacheItemMap = new Map();

  for (const o of cacheDeduped) {
    const pid = pickPlatformOrderId(o);
    if (!pid) continue;
    const platform = 'tiktok';
    const lines = extractLineItemsForOrder(o);
    if (lines.length === 0) {
      noItems += 1;
      continue;
    }
    itemCacheRows += lines.length;
    for (const row of lines) {
      const k = itemReconcileCompareKey(pid, row.platform_item_id, row.sku_id, row.product_id);
      cacheItemMap.set(k, {
        quantity: row.quantity,
        total_amount: row.total_amount,
        platform,
        platform_order_id: pid,
        platform_item_id: row.platform_item_id,
        sku_id: row.sku_id,
        product_id: row.product_id,
      });
    }
  }

  const { rows: mysqlItemList, count: itemMysqlRowCount } = await loadMysqlItemsInWindow(pool, ctx, WINDOW_HOURS);

  const mysqlItemMap = new Map();
  for (const r of mysqlItemList) {
    const platform = String(r.platform || 'tiktok').toLowerCase();
    const pid = String(r.platform_order_id || '').trim();
    const k = itemReconcileCompareKey(pid, r.platform_item_id, r.sku_id, r.product_id);
    const qty = Math.max(1, Number(r.quantity) || 0);
    const tamt = Number(r.total_amount);
    const total_amount = Number.isFinite(tamt) ? Number(tamt.toFixed(4)) : 0;
    mysqlItemMap.set(k, {
      quantity: qty,
      total_amount,
      platform,
      platform_order_id: pid,
      platform_item_id: String(r.platform_item_id ?? ''),
      sku_id: String(r.sku_id ?? ''),
      product_id: String(r.product_id ?? ''),
    });
  }

  const itemMissingInMysql = [];
  const itemMissingInCache = [];
  const itemMismatchQuantity = [];
  const itemMismatchAmount = [];

  for (const [, c] of cacheItemMap) {
    const k = itemReconcileCompareKey(c.platform_order_id, c.platform_item_id, c.sku_id, c.product_id);
    const m = mysqlItemMap.get(k);
    if (!m) {
      itemMissingInMysql.push({
        platform: c.platform,
        platform_order_id: c.platform_order_id,
        platform_item_id: c.platform_item_id,
        sku_id: c.sku_id,
        product_id: c.product_id,
      });
    } else if (c.quantity !== m.quantity) {
      itemMismatchQuantity.push({
        platform: c.platform,
        platform_order_id: c.platform_order_id,
        platform_item_id: c.platform_item_id,
        sku_id: c.sku_id,
        product_id: c.product_id,
        cacheQuantity: c.quantity,
        mysqlQuantity: m.quantity,
      });
    } else if (Math.abs(c.total_amount - m.total_amount) > 0.0002) {
      itemMismatchAmount.push({
        platform: c.platform,
        platform_order_id: c.platform_order_id,
        platform_item_id: c.platform_item_id,
        sku_id: c.sku_id,
        product_id: c.product_id,
        cacheAmount: c.total_amount,
        mysqlAmount: m.total_amount,
      });
    }
  }

  for (const [, m] of mysqlItemMap) {
    const k = itemReconcileCompareKey(m.platform_order_id, m.platform_item_id, m.sku_id, m.product_id);
    if (!cacheItemMap.has(k)) {
      itemMissingInCache.push({
        platform: m.platform,
        platform_order_id: m.platform_order_id,
        platform_item_id: m.platform_item_id,
        sku_id: m.sku_id,
        product_id: m.product_id,
        mysqlQuantity: m.quantity,
        mysqlAmount: m.total_amount,
      });
    }
  }

  const itemDiffCount =
    itemMissingInMysql.length +
    itemMissingInCache.length +
    itemMismatchQuantity.length +
    itemMismatchAmount.length;

  const itemsOk =
    itemMissingInMysql.length === 0 &&
    itemMissingInCache.length === 0 &&
    itemMismatchQuantity.length === 0 &&
    itemMismatchAmount.length === 0;

  const windowOk = ok;
  const cacheAffectsAnalytics = missingInMysql.length > 0 || missingInCache.length > 0;

  const orderDiffDetails = [...missingInMysql, ...missingInCache].slice(0, 50);
  const orderDiffReasonStats = summarizeDiffReasons(orderDiffDetails);
  const itemDiffSamples = buildItemDiffSample(
    itemMissingInMysql,
    itemMissingInCache,
    itemMismatchQuantity,
    itemMismatchAmount,
    20,
  );
  const itemDiffReasonStats = summarizeDiffReasons(itemDiffSamples);

  const cacheInWindowCount = cacheDeduped.length;
  const cacheTotalCount = allOrders.length;

  return {
    cacheOrders: cacheMap.size,
    mysqlOrders: mysqlMap.size,
    missingInMysql,
    missingInCache,
    duplicatedOrders,
    mismatchAmountOrders,
    mismatchStatusOrders,
    sections: {
      historical: {
        mysqlOrdersTotal: mysqlTotals.ordersTotal,
        mysqlOrderItemsTotal: mysqlTotals.itemsTotal,
        referenceOnly: true,
      },
      window: {
        windowHours: WINDOW_HOURS,
        mysqlOrders: mysqlMap.size,
        cacheOrders: cacheMap.size,
        diffCount,
        healthy: windowOk,
        missingInMysql,
        missingInCache,
        mismatchAmountOrders,
        mismatchStatusOrders,
        duplicatedOrders,
      },
      cacheConsistency: {
        cacheWindowOrders: cacheMap.size,
        mysqlWindowOrders: mysqlMap.size,
        cacheOnlyCount: missingInMysql.length,
        mysqlOnlyCount: missingInCache.length,
        affectsAnalytics: cacheAffectsAnalytics,
        hintOnly: !cacheAffectsAnalytics && itemDiffCount > 0,
        itemDiffCount,
      },
    },
    summary: {
      ok: windowOk,
      itemsOk,
      windowOk,
      historicalOk: true,
      overallSeverity: windowOk ? (itemsOk ? 'ok' : 'warn') : 'error',
    },
    meta: {
      windowHours: WINDOW_HOURS,
      cutoffEpochSec: cutoffSec,
      tenantId: reconcileTenantId,
      platformMode,
      scopeShops: gate.shopIdSet ? gate.shopIdSet.size : gate.eligibleShopCount || 0,
      diffCount,
      cacheOrdersWindow: cacheMap.size,
      mysqlOrdersWindow: mysqlMap.size,
      itemCacheRows,
      itemMysqlRows: itemMysqlRowCount,
      itemDiffCount,
      noItems,
      database: dbMeta ? dbMeta.database : null,
      mysqlHost: dbMeta ? dbMeta.host : null,
      mysqlOrdersTableTotal: mysqlTotals.ordersTotal,
      mysqlOrderItemsTableTotal: mysqlTotals.itemsTotal,
      ordersTable: 'orders',
      orderItemsTable: 'order_items',
      cacheFile: cachePath,
      timeField: mysqlTimeExpr,
    },
    debug: {
      window: {
        window_hours: WINDOW_HOURS,
        window_start: windowStartIso,
        window_end: windowEndIso,
        mysql_time_expr: mysqlTimeExpr,
        cache_time_expr: cacheTimeExpr,
        order_status_filter: 'none（对账窗口内全状态）',
        tenant_filter: platformMode ? 'platform' : String(reconcileTenantId),
        shop_filter: `eligible shops=${gate.shopIdSet ? gate.shopIdSet.size : 0}`,
        market_filter: 'none',
      },
      cacheSource: {
        ...cacheMeta,
        cache_file_path: ORDERS_CACHE_PATH,
        cache_worker: 'tiktok-openapi-sync → backend/tiktok-api/scheduler.js (collectOnce)',
        cache_rebuild_api: 'POST /api/ops/orders/rebuild-cache',
        cache_persist_mysql: 'persistOrdersFromCache + persistOrderItemsFromCache（OpenAPI 后写 MySQL；可反向 rebuild）',
        cache_order_count_total: cacheTotalCount,
        cache_order_count_window: cacheInWindowCount,
        cache_item_count_window: itemCacheRows,
        cache_item_count_total: null,
        cache_lag_minutes: cacheLagMin,
        cache_missing_orders: missingInCache.length,
        cache_missing_items: itemMissingInCache.length,
        reference_only: true,
        primary_source: 'mysql',
        single_file: true,
        note: '对账与 Analytics 主统计以 MySQL 为准；cache 仅健康/对账参考',
      },
      mysqlSource: {
        mysql_order_count_total: mysqlTotals.ordersTotal,
        mysql_order_count_window: mysqlMap.size,
        mysql_item_count_total: mysqlTotals.itemsTotal,
        mysql_item_count_window: itemMysqlRowCount,
      },
      orderDiffDetails,
      orderDiffReasonStats,
      itemDiffSamples,
      itemDiffReasonStats,
      analyticsPrimary: isMysqlPrimaryDashboard() ? 'mysql' : 'orders-cache.json',
    },
    itemMissingInMysql,
    itemMissingInCache,
    itemMismatchQuantity,
    itemMismatchAmount,
  };
}

module.exports = {
  buildOrdersReconcileReport,
  DEFAULT_WINDOW_HOURS,
  loadPlatformReconcileGate,
};
