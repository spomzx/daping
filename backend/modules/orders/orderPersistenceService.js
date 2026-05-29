'use strict';

const dayjs = require('dayjs');
const { getMysqlPool } = require('../../db/mysqlPool');

/** 构建 shops 索引：internal id 为权威；platform_shop_id 仅作无歧义时的辅助 */
function buildShopMetaMaps(shopRows) {
  const byInternalId = new Map();
  const byPlatformPid = new Map();

  for (const r of Array.isArray(shopRows) ? shopRows : []) {
    const meta = {
      id: Number(r.id),
      tenant_id: Number(r.tenant_id),
      shop_name: r.shop_name,
      market: r.market || r.region,
      platform_shop_id: String(r.platform_shop_id || '').trim(),
    };
    if (!Number.isFinite(meta.id) || meta.id <= 0) continue;
    if (!Number.isFinite(meta.tenant_id) || meta.tenant_id <= 0) continue;

    byInternalId.set(String(meta.id), meta);
    const k = String(meta.platform_shop_id || '').trim().toLowerCase();
    if (!k) continue;
    const prev = byPlatformPid.get(k);
    if (!prev) {
      byPlatformPid.set(k, meta);
    } else if (prev.id !== meta.id) {
      byPlatformPid.set(k, { ...prev, _ambiguous: true });
    }
  }

  return { byInternalId, byPlatformPid };
}

/**
 * tenant_id 必须来自 shops.tenant_id（禁止 DASHBOARD_TENANT_ID 兜底写库）
 * @param {number|null} shopId
 * @param {{ internal_shop_id?: number|null, platform_shop_id?: string, tenant_id?: number|null }|null} shopContext
 * @param {{ byInternalId: Map<string, object>, byPlatformPid: Map<string, object> }} maps
 */
function resolveShopMetaForPersist(shopId, shopContext, maps) {
  const internalCandidates = [
    shopContext?.internal_shop_id,
    shopId,
  ];
  for (const c of internalCandidates) {
    const n = Number(c);
    if (Number.isFinite(n) && n > 0) {
      const hit = maps.byInternalId.get(String(n));
      if (hit) return hit;
    }
  }

  const pid = String(
    shopContext?.platform_shop_id || '',
  )
    .trim()
    .toLowerCase();
  if (pid) {
    const hit = maps.byPlatformPid.get(pid);
    if (hit && !hit._ambiguous) return hit;
    if (hit && hit._ambiguous && shopContext?.tenant_id != null) {
      const wantTid = Number(shopContext.tenant_id);
      for (const meta of maps.byInternalId.values()) {
        if (
          String(meta.platform_shop_id || '').trim().toLowerCase() === pid &&
          Number(meta.tenant_id) === wantTid
        ) {
          return meta;
        }
      }
    }
  }

  return null;
}
const { inferOrderCurrency, normalizeCurrency } = require('../../lib/currency');
const { deriveAnalyticsStatusFromOrder } = require('../../lib/orderFilter');

/** 累计汇总，最多每 60 秒打印一行 */
let persistPending = { inserted: 0, updated: 0, skipped: 0 };
let persistLastLogMs = Date.now();

function recordPersistStats(inserted, updated, skipped) {
  persistPending.inserted += inserted;
  persistPending.updated += updated;
  persistPending.skipped += skipped;
  const now = Date.now();
  if (now - persistLastLogMs < 60000) return;
  if (persistPending.inserted + persistPending.updated + persistPending.skipped === 0) return;
  console.log('[persist-orders]', {
    inserted: persistPending.inserted,
    updated: persistPending.updated,
    skipped: persistPending.skipped,
  });
  persistPending = { inserted: 0, updated: 0, skipped: 0 };
  persistLastLogMs = now;
}

function pickPlatformOrderId(o) {
  const nested = o?._raw && typeof o._raw === 'object' ? o._raw : null;
  const candidates = [
    o?.orderId,
    o?.id,
    o?.platform_order_id,
    nested?.id,
    nested?.order_id,
    nested?.order_sn,
  ];
  for (const c of candidates) {
    const s = String(c ?? '').trim();
    if (s) return s;
  }
  return null;
}

function truncateRawJson(raw) {
  if (raw == null) return null;
  const s = String(raw);
  const max = 4_000_000;
  return s.length > max ? s.slice(0, max) : s;
}

/**
 * MySQL INSERT ... ON DUPLICATE KEY UPDATE 的 affectedRows 语义（mysql2）
 * @param {import('mysql2').ResultSetHeader} res
 */
function classifyMysqlUpsertResult(res) {
  const ar = Number(res?.affectedRows ?? 0);
  const cr = Number(res?.changedRows ?? 0);
  if (ar === 1) return 'inserted';
  if (ar === 2) return 'updated';
  if (ar === 0 && cr === 0) return 'updated_unchanged';
  if (ar === 0 && cr > 0) return 'updated';
  return 'unknown';
}

/** 同批 API 订单按 platform_order_id 去重，后出现的覆盖（第 2 页优先） */
function dedupeNormalizedRows(rows) {
  const map = new Map();
  for (const r of Array.isArray(rows) ? rows : []) {
    const pid = String(r?.platform_order_id || '').trim();
    if (!pid) continue;
    map.set(pid, r);
  }
  return [...map.values()];
}

function emptyPersistDebug() {
  return {
    api_orders_received: 0,
    api_orders_after_dedupe: 0,
    orders_to_insert: 0,
    orders_inserted: 0,
    orders_updated: 0,
    orders_updated_unchanged: 0,
    duplicate_skipped: 0,
    normalize_skipped: 0,
    normalize_skip_reasons: {},
    duplicate_conflicts: [],
    transaction_rollback: false,
    failed_order_ids: [],
    missing_after_insert: [],
  };
}

function parseMysqlDatetime3(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  if (Number.isFinite(n) && n > 0) {
    const ms = n > 1e12 ? n : n * 1000;
    const d = dayjs(ms);
    return d.isValid() ? d.format('YYYY-MM-DD HH:mm:ss.SSS') : null;
  }
  const d = dayjs(String(v));
  return d.isValid() ? d.format('YYYY-MM-DD HH:mm:ss.SSS') : null;
}

/**
 * @param {Record<string, unknown>} o
 * @param {{ byInternalId: Map<string, object>, byPlatformPid: Map<string, object> }} shopMaps
 * @param {{ internal_shop_id?: number|null, platform_shop_id?: string, shop_name?: string, market?: string, tenant_id?: number|null }|null} shopContext
 */
function normalizeCacheOrderRow(o, shopMaps, shopContext = null) {
  const platform_order_id = pickPlatformOrderId(o);
  if (!platform_order_id) return null;

  const platform = 'tiktok';
  const sid = String(o?.shopId ?? o?.shop_id ?? '').trim().toLowerCase();
  const ctxPid = shopContext?.platform_shop_id
    ? String(shopContext.platform_shop_id).trim().toLowerCase()
    : '';

  let shop_id = null;
  let shop_name = String(o?.shopName ?? o?.shop_name ?? '').trim().slice(0, 255) || null;
  let market = String(o?.region ?? o?.market ?? '').trim().slice(0, 32) || null;

  if (shopContext) {
    const internal = Number(shopContext.internal_shop_id);
    if (Number.isFinite(internal) && internal > 0) {
      shop_id = internal;
    } else if (ctxPid) {
      console.warn('[order-persist-warning]', {
        reason: 'missing_internal_shop_id',
        platform_shop_id: ctxPid,
        platform_order_id,
        message: '禁止按 market 默认写入其他店；跳过该订单',
      });
      return null;
    } else {
      console.warn('[order-persist-warning]', {
        reason: 'missing_platform_shop_id_in_context',
        platform_order_id,
      });
      return null;
    }
    if (shopContext.shop_name) shop_name = String(shopContext.shop_name).trim().slice(0, 255) || shop_name;
    if (shopContext.market) market = String(shopContext.market).trim().slice(0, 32).toUpperCase() || market;

    if (ctxPid && sid && sid !== ctxPid && sid !== String(shop_id)) {
      console.warn('[order-persist-warning]', {
        reason: 'shop_id_mismatch_cache_vs_sync_context',
        cache_shop_id: sid,
        sync_platform_shop_id: ctxPid,
        platform_order_id,
      });
    }
  } else {
    const internalFromOrder = Number(o?.internal_shop_id);
    if (Number.isFinite(internalFromOrder) && internalFromOrder > 0) {
      const hit = shopMaps.byInternalId.get(String(internalFromOrder));
      if (hit) shop_id = hit.id;
    }
    if (!shop_id) {
      const shopMeta =
        sid && shopMaps.byPlatformPid.has(sid) && !shopMaps.byPlatformPid.get(sid)?._ambiguous
          ? shopMaps.byPlatformPid.get(sid)
          : null;
      shop_id = shopMeta ? shopMeta.id : null;
    }
    if (!shop_id && sid) {
      console.warn('[order-persist-warning]', {
        reason: 'no_shop_context_and_unmapped_platform_shop_id',
        platform_shop_id: sid,
        platform_order_id,
        message: '批量写库无 shopContext 且无法映射 internal shop_id',
      });
    }
  }

  if (!shop_id) {
    return null;
  }

  const shopMeta = resolveShopMetaForPersist(shop_id, shopContext, shopMaps);
  if (!shopMeta || !Number.isFinite(shopMeta.tenant_id) || shopMeta.tenant_id <= 0) {
    console.warn('[order-persist-warning]', {
      reason: 'missing_shop_tenant_from_mysql',
      shop_id,
      platform_shop_id: ctxPid || sid,
      platform_order_id,
    });
    return null;
  }

  const tenant_id = shopMeta.tenant_id;
  shop_id = shopMeta.id;
  if (shopMeta.shop_name) shop_name = String(shopMeta.shop_name).trim().slice(0, 255) || shop_name;
  if (shopMeta.market) market = String(shopMeta.market).trim().slice(0, 32).toUpperCase() || market;

  let currency = normalizeCurrency(String(o?.currency ?? '').trim()) || inferOrderCurrency(o) || null;
  if (currency) currency = String(currency).trim().slice(0, 16) || null;
  const buyer_name = String(o?.customerName ?? '').trim().slice(0, 255) || null;
  const order_status = String(o?.orderStatus ?? o?.status ?? '').trim().slice(0, 64) || null;

  const amt = Number(o?.orderAmountBase ?? o?.totalAmount ?? o?.payment?.total_amount ?? 0);
  const total_amount = Number.isFinite(amt) ? Number(amt.toFixed(2)) : 0;

  const created_at_platform = parseMysqlDatetime3(o?.createTime ?? o?.create_time ?? o?.created_at);
  const paid_at = parseMysqlDatetime3(o?.paidTime ?? o?.paymentTime ?? o?.paid_time ?? o?.paid_time);

  let raw_json;
  try {
    raw_json = truncateRawJson(JSON.stringify(o));
  } catch {
    raw_json = null;
  }

  const analytics_status = deriveAnalyticsStatusFromOrder(o);

  let platform_shop_id =
    shopContext?.platform_shop_id != null
      ? String(shopContext.platform_shop_id).trim().slice(0, 128)
      : ctxPid
        ? ctxPid.slice(0, 128)
        : null;
  if (!platform_shop_id && shopMeta.platform_shop_id) {
    platform_shop_id = String(shopMeta.platform_shop_id).slice(0, 128);
  }

  return {
    tenant_id,
    shop_id,
    platform_shop_id,
    platform,
    platform_order_id: platform_order_id.slice(0, 128),
    shop_name,
    market,
    currency,
    buyer_name,
    order_status,
    analytics_status,
    total_amount,
    created_at_platform,
    paid_at,
    raw_json,
    _target_platform_shop_id: ctxPid || sid || null,
  };
}

const UPSERT_SQL = `
INSERT INTO orders (
  tenant_id, shop_id, platform_shop_id, platform, platform_order_id,
  shop_name, market, currency, buyer_name,
  order_status, analytics_status, total_amount,
  created_at_platform, paid_at, raw_json
) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
ON DUPLICATE KEY UPDATE
  shop_id = VALUES(shop_id),
  platform_shop_id = VALUES(platform_shop_id),
  shop_name = VALUES(shop_name),
  market = VALUES(market),
  tenant_id = VALUES(tenant_id),
  order_status = VALUES(order_status),
  analytics_status = VALUES(analytics_status),
  total_amount = VALUES(total_amount),
  paid_at = VALUES(paid_at),
  raw_json = VALUES(raw_json),
  updated_at = CURRENT_TIMESTAMP(3)
`;

function logOrderPersistPreview(rows, shopContext) {
  const preview = rows.slice(0, 3).map((row) => ({
    platform_order_id: row.platform_order_id,
    target_internal_shop_id: row.shop_id,
    target_platform_shop_id: row._target_platform_shop_id || shopContext?.platform_shop_id || null,
    target_shop_name: row.shop_name,
    market: row.market,
    total_amount: row.total_amount,
    created_at_platform: row.created_at_platform,
  }));
  console.log('[order-persist-preview]', JSON.stringify(preview, null, 2));
}

/**
 * 将 fetchOrdersInTimeRange 的 data 按 requestPages.orders_extracted_count 切页（诊断用）
 * @param {unknown[]} orders
 * @param {Array<{ orders_extracted_count?: number, orders_count_api?: number, orders_count?: number }>} requestPages
 */
function splitOrdersByApiPages(orders, requestPages) {
  const list = Array.isArray(orders) ? orders : [];
  const pages = Array.isArray(requestPages) ? requestPages : [];
  if (!pages.length) {
    return [{ page: 1, api_orders: list.length, orders: list }];
  }
  const out = [];
  let offset = 0;
  for (let i = 0; i < pages.length; i += 1) {
    const p = pages[i];
    const n = Math.max(0, Number(p.orders_extracted_count ?? 0));
    const slice = list.slice(offset, offset + n);
    offset += n;
    out.push({
      page: i + 1,
      api_orders: Number(p.orders_count_api ?? p.orders_count ?? n) || n,
      orders: slice,
    });
  }
  if (offset < list.length) {
    out.push({
      page: out.length + 1,
      api_orders: list.length - offset,
      orders: list.slice(offset),
    });
  }
  return out;
}

/**
 * @param {import('mysql2/promise').Pool} pool
 * @param {ReturnType<typeof normalizeCacheOrderRow>} row
 * @param {ReturnType<typeof emptyPersistDebug>} debug
 */
async function upsertOneOrderRow(pool, row, debug) {
  const [existingRows] = await pool.query(
    `SELECT id, shop_id, tenant_id FROM orders WHERE platform = ? AND platform_order_id = ? LIMIT 1`,
    [row.platform, row.platform_order_id],
  );
  const existing = Array.isArray(existingRows) && existingRows[0] ? existingRows[0] : null;
  if (
    existing &&
    (Number(existing.shop_id) !== Number(row.shop_id) ||
      Number(existing.tenant_id) !== Number(row.tenant_id))
  ) {
    debug.duplicate_conflicts.push({
      platform_order_id: row.platform_order_id,
      previous_shop_id: existing.shop_id,
      previous_tenant_id: existing.tenant_id,
      target_shop_id: row.shop_id,
      target_tenant_id: row.tenant_id,
    });
  }

  const vals = [
    row.tenant_id,
    row.shop_id,
    row.platform_shop_id,
    row.platform,
    row.platform_order_id,
    row.shop_name,
    row.market,
    row.currency,
    row.buyer_name,
    row.order_status,
    row.analytics_status,
    row.total_amount,
    row.created_at_platform,
    row.paid_at,
    row.raw_json,
  ];

  const [res] = await pool.execute(UPSERT_SQL, vals);
  return classifyMysqlUpsertResult(res);
}

/**
 * @param {unknown[]} rawOrders
 * @param {{ shopContext?: { internal_shop_id?: number|null, platform_shop_id?: string, shop_name?: string, market?: string, tenant_id?: number|null }, preview?: boolean, persistDebug?: boolean, verifyAfterInsert?: boolean }} [options]
 */
async function persistOrdersFromCache(rawOrders, options = {}) {
  const stats = {
    inserted: 0,
    updated: 0,
    skipped: 0,
    updated_unchanged: 0,
    persist_debug: emptyPersistDebug(),
  };
  const debug = stats.persist_debug;
  debug.api_orders_received = Array.isArray(rawOrders) ? rawOrders.length : 0;

  const pool = getMysqlPool();
  if (!pool) {
    console.error('[persist-orders] no mysql pool');
    return stats;
  }
  if (!Array.isArray(rawOrders) || rawOrders.length === 0) return stats;

  const shopContext = options.shopContext || null;
  if (shopContext && !Number.isFinite(Number(shopContext.internal_shop_id))) {
    console.error('[persist-orders] shopContext.internal_shop_id required for tenant-safe persist');
    return stats;
  }

  try {
    const [shopRows] = await pool.query(
      `SELECT id, tenant_id, platform_shop_id, shop_name, market, region FROM shops WHERE platform = ? AND status <> 'deleted'`,
      ['tiktok'],
    );
    const shopMaps = buildShopMetaMaps(shopRows);

    if (shopContext?.platform_shop_id && !shopContext.internal_shop_id) {
      const k = String(shopContext.platform_shop_id).trim().toLowerCase();
      const hit = shopMaps.byPlatformPid.get(k);
      if (hit && !hit._ambiguous) {
        shopContext.internal_shop_id = hit.id;
        shopContext.tenant_id = hit.tenant_id;
      } else if (hit && hit._ambiguous && shopContext.tenant_id != null) {
        const resolved = resolveShopMetaForPersist(null, shopContext, shopMaps);
        if (resolved) shopContext.internal_shop_id = resolved.id;
      }
    }
    if (shopContext?.internal_shop_id && !shopContext.tenant_id) {
      const hit = shopMaps.byInternalId.get(String(shopContext.internal_shop_id));
      if (hit) shopContext.tenant_id = hit.tenant_id;
    }

    const normalizedRows = [];
    const skipReasons = debug.normalize_skip_reasons;

    for (const o of rawOrders) {
      if (!o || typeof o !== 'object') {
        stats.skipped += 1;
        skipReasons.invalid_object = (skipReasons.invalid_object || 0) + 1;
        continue;
      }
      const sid = String(o?.shopId ?? o?.shop_id ?? '').trim().toLowerCase();
      let row = normalizeCacheOrderRow(o, shopMaps, shopContext);
      if (!row && !shopContext && sid) {
        const [sr] = await pool.query(
          `SELECT id, tenant_id, platform_shop_id, shop_name, market, region FROM shops WHERE platform = ? AND LOWER(TRIM(platform_shop_id)) = ? AND status <> 'deleted' ORDER BY id DESC LIMIT 1`,
          ['tiktok', sid],
        );
        const hit = Array.isArray(sr) && sr[0] ? sr[0] : null;
        if (hit) {
          row = normalizeCacheOrderRow(o, shopMaps, {
            internal_shop_id: Number(hit.id),
            tenant_id: Number(hit.tenant_id),
            platform_shop_id: sid,
            shop_name: String(hit.shop_name || o?.shopName || o?.shop_name || ''),
            market: String(hit.market || hit.region || o?.region || o?.market || ''),
          });
        }
      }
      if (!row) {
        stats.skipped += 1;
        debug.normalize_skipped += 1;
        if (!pickPlatformOrderId(o)) skipReasons.no_platform_order_id = (skipReasons.no_platform_order_id || 0) + 1;
        else skipReasons.normalize_returned_null = (skipReasons.normalize_returned_null || 0) + 1;
        continue;
      }
      if (!row.shop_id) {
        stats.skipped += 1;
        debug.normalize_skipped += 1;
        skipReasons.no_shop_id = (skipReasons.no_shop_id || 0) + 1;
        continue;
      }
      normalizedRows.push(row);
    }

    const dedupedRows = dedupeNormalizedRows(normalizedRows);
    debug.api_orders_after_dedupe = dedupedRows.length;
    debug.orders_to_insert = dedupedRows.length;

    if (options.preview !== false && dedupedRows.length > 0) {
      logOrderPersistPreview(dedupedRows, shopContext);
      const tenantDbg = dedupedRows.slice(0, 3).map((r) => ({
        shop_id: r.shop_id,
        tenant_id: r.tenant_id,
        platform_shop_id: r.platform_shop_id,
        analytics_status: r.analytics_status,
      }));
      console.log('[order-persist-tenant]', JSON.stringify(tenantDbg));
    }

    for (const row of dedupedRows) {
      try {
        const kind = await upsertOneOrderRow(pool, row, debug);
        if (kind === 'inserted') {
          stats.inserted += 1;
          debug.orders_inserted += 1;
        } else if (kind === 'updated') {
          stats.updated += 1;
          debug.orders_updated += 1;
        } else if (kind === 'updated_unchanged') {
          stats.updated_unchanged += 1;
          debug.orders_updated_unchanged += 1;
        } else {
          stats.skipped += 1;
          debug.duplicate_skipped += 1;
        }
      } catch (rowErr) {
        stats.skipped += 1;
        const msg = String(rowErr?.message || rowErr);
        debug.failed_order_ids.push({
          platform_order_id: row.platform_order_id,
          error: msg,
        });
        console.error('[persist-orders-row-fail]', {
          platform_order_id: row.platform_order_id,
          shop_id: row.shop_id,
          error: msg,
        });
      }
    }

    if (options.verifyAfterInsert && dedupedRows.length > 0) {
      const ids = dedupedRows.map((r) => r.platform_order_id);
      const placeholders = ids.map(() => '?').join(',');
      const [found] = await pool.query(
        `SELECT LOWER(TRIM(platform_order_id)) AS pid FROM orders
         WHERE platform = 'tiktok' AND shop_id = ? AND tenant_id = ?
           AND platform_order_id IN (${placeholders})`,
        [dedupedRows[0].shop_id, dedupedRows[0].tenant_id, ...ids],
      );
      const foundSet = new Set((Array.isArray(found) ? found : []).map((r) => String(r.pid)));
      for (const pid of ids) {
        const k = String(pid).trim().toLowerCase();
        if (!foundSet.has(k)) debug.missing_after_insert.push(k);
      }
    }

    recordPersistStats(stats.inserted, stats.updated, stats.skipped);
    if (
      options.persistDebug ||
      debug.failed_order_ids.length > 0 ||
      debug.missing_after_insert.length > 0 ||
      debug.normalize_skipped > 0
    ) {
      console.log('[persist_debug]', JSON.stringify(debug, null, 2));
    }
    return stats;
  } catch (e) {
    debug.transaction_rollback = false;
    const msg = String(e?.message || e);
    console.error('[persist-orders-fatal]', msg);
    debug.failed_order_ids.push({ platform_order_id: '*batch*', error: msg });
    return stats;
  }
}

module.exports = {
  persistOrdersFromCache,
  normalizeCacheOrderRow,
  splitOrdersByApiPages,
  emptyPersistDebug,
  pickPlatformOrderId,
};
