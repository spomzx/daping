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
  const raw = o?.orderId ?? o?.id ?? o?._raw?.id ?? '';
  const s = String(raw).trim();
  return s || null;
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
    raw_json = JSON.stringify(o);
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
 * @param {unknown[]} rawOrders
 * @param {{ shopContext?: { internal_shop_id?: number|null, platform_shop_id?: string, shop_name?: string, market?: string }, preview?: boolean }} [options]
 * @returns {Promise<{ inserted: number, updated: number, skipped: number }>}
 */
async function persistOrdersFromCache(rawOrders, options = {}) {
  const stats = { inserted: 0, updated: 0, skipped: 0 };
  try {
    const pool = getMysqlPool();
    if (!pool) return stats;
    if (!Array.isArray(rawOrders) || rawOrders.length === 0) return stats;

    const shopContext = options.shopContext || null;

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
    let inserted = 0;
    let updated = 0;
    let skipped = 0;

    for (const o of rawOrders) {
      if (!o || typeof o !== 'object') {
        skipped += 1;
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
      if (!row || !row.shop_id) {
        skipped += 1;
        continue;
      }
      normalizedRows.push(row);
    }

    if (options.preview !== false && normalizedRows.length > 0) {
      logOrderPersistPreview(normalizedRows, shopContext);
      const tenantDbg = normalizedRows.slice(0, 3).map((r) => ({
        shop_id: r.shop_id,
        tenant_id: r.tenant_id,
        platform_shop_id: r.platform_shop_id,
      }));
      console.log('[order-persist-tenant]', JSON.stringify(tenantDbg));
    }

    for (const row of normalizedRows) {
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
      const ar = Number(res?.affectedRows ?? 0);
      if (ar === 1) inserted += 1;
      else if (ar === 2) updated += 1;
      else skipped += 1;
    }

    recordPersistStats(inserted, updated, skipped);
    stats.inserted = inserted;
    stats.updated = updated;
    stats.skipped = skipped;
    return stats;
  } catch (e) {
    console.error('[persist-orders]', e && e.message ? e.message : e);
    return stats;
  }
}

module.exports = { persistOrdersFromCache, normalizeCacheOrderRow };
