'use strict';

const { getMysqlPool } = require('../../db/mysqlPool');
const { extractLineItemsForOrder } = require('./orderLineItemsExtract');

let persistPending = {
  inserted: 0,
  updated: 0,
  skipped: 0,
  noItems: 0,
  zeroAmountSkipped: 0,
};
let persistLastLogMs = Date.now();

function recordOrderItemsStats(inserted, updated, skipped, noItems, zeroAmountSkipped) {
  persistPending.inserted += inserted;
  persistPending.updated += updated;
  persistPending.skipped += skipped;
  persistPending.noItems += noItems;
  persistPending.zeroAmountSkipped += zeroAmountSkipped;
  const now = Date.now();
  if (now - persistLastLogMs < 60000) return;
  if (
    persistPending.inserted +
      persistPending.updated +
      persistPending.skipped +
      persistPending.noItems +
      persistPending.zeroAmountSkipped ===
    0
  ) {
    return;
  }
  console.log('[persist-order-items]', {
    inserted: persistPending.inserted,
    updated: persistPending.updated,
    skipped: persistPending.skipped,
    noItems: persistPending.noItems,
    zeroAmountSkipped: persistPending.zeroAmountSkipped,
  });
  persistPending = {
    inserted: 0,
    updated: 0,
    skipped: 0,
    noItems: 0,
    zeroAmountSkipped: 0,
  };
  persistLastLogMs = now;
}

function pickPlatformOrderId(o) {
  const raw = o?.orderId ?? o?.id ?? o?._raw?.id ?? '';
  const s = String(raw).trim();
  return s || null;
}

function sqlId(v, max) {
  const s = String(v ?? '').trim();
  return s ? s.slice(0, max) : '';
}

const UPSERT_SQL = `
INSERT INTO order_items (
  tenant_id, order_id, platform, platform_order_id, platform_item_id,
  shop_id, shop_name, market,
  product_id, sku_id, sku_name, product_name, product_image,
  quantity, currency, unit_price, total_amount,
  raw_json, created_at_platform
) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
ON DUPLICATE KEY UPDATE
  product_name = VALUES(product_name),
  sku_name = VALUES(sku_name),
  quantity = VALUES(quantity),
  unit_price = VALUES(unit_price),
  total_amount = VALUES(total_amount),
  raw_json = VALUES(raw_json),
  updated_at = CURRENT_TIMESTAMP(3)
`;

/**
 * 异步写入商品明细；失败不影响调用方。
 * @param {unknown[]} rawOrders
 */
async function persistOrderItemsFromCache(rawOrders) {
  try {
    const pool = getMysqlPool();
    if (!pool) return;
    if (!Array.isArray(rawOrders) || rawOrders.length === 0) return;

    const [shopRows] = await pool.query(
      `SELECT id, tenant_id, platform_shop_id FROM shops WHERE platform = ? AND status <> 'deleted'`,
      ['tiktok'],
    );
    const shopByInternalId = new Map();
    for (const r of Array.isArray(shopRows) ? shopRows : []) {
      const meta = { id: Number(r.id), tenant_id: Number(r.tenant_id) };
      if (Number.isFinite(meta.id) && meta.id > 0) {
        shopByInternalId.set(String(meta.id), meta);
      }
    }

    const [orderRows] = await pool.query(
      `SELECT id, tenant_id, platform, platform_order_id FROM orders WHERE platform = ?`,
      ['tiktok'],
    );
    const orderIdByKey = new Map();
    for (const r of Array.isArray(orderRows) ? orderRows : []) {
      const plat = String(r.platform || 'tiktok').toLowerCase();
      const po = String(r.platform_order_id || '').trim();
      orderIdByKey.set(`${plat}::${po}`, { id: Number(r.id), tenant_id: Number(r.tenant_id) });
    }

    let inserted = 0;
    let updated = 0;
    let skipped = 0;
    let noItems = 0;
    let zeroAmountSkipped = 0;

    for (const o of rawOrders) {
      if (!o || typeof o !== 'object') {
        skipped += 1;
        continue;
      }
      const platform_order_id = pickPlatformOrderId(o);
      if (!platform_order_id) {
        skipped += 1;
        continue;
      }

      const platform = 'tiktok';
      const items = extractLineItemsForOrder(o);
      if (items.length === 0) {
        noItems += 1;
        continue;
      }

      const internalFromOrder = Number(o?.internal_shop_id);
      let shopMeta = null;
      if (Number.isFinite(internalFromOrder) && internalFromOrder > 0) {
        shopMeta = shopByInternalId.get(String(internalFromOrder)) || null;
      }
      const shop_id = shopMeta ? shopMeta.id : null;
      if (!shop_id) {
        skipped += 1;
        continue;
      }
      const rowTenantId = shopMeta.tenant_id;
      if (!Number.isFinite(rowTenantId) || rowTenantId <= 0) {
        skipped += 1;
        continue;
      }
      const shop_name = String(o?.shopName ?? o?.shop_name ?? '').trim().slice(0, 255) || null;
      const market = String(o?.region ?? o?.market ?? '').trim().slice(0, 32) || null;

      const orderKey = `${platform}::${platform_order_id.trim()}`;
      const orderMeta = orderIdByKey.has(orderKey) ? orderIdByKey.get(orderKey) : null;
      const order_id = orderMeta ? orderMeta.id : null;
      const itemTenantId = orderMeta && Number.isFinite(orderMeta.tenant_id) ? orderMeta.tenant_id : rowTenantId;

      for (const row of items) {
        if (Number(row.unit_price) === 0 && Number(row.total_amount) === 0) {
          zeroAmountSkipped += 1;
        }
        const qty = Math.max(1, Math.round(Number(row.quantity)) || 1);

        const vals = [
          itemTenantId,
          order_id,
          platform,
          platform_order_id.slice(0, 128),
          sqlId(row.platform_item_id, 128),
          shop_id,
          shop_name,
          market,
          sqlId(row.product_id, 128),
          sqlId(row.sku_id, 128),
          row.sku_name != null ? String(row.sku_name).slice(0, 255) : '',
          row.product_name != null ? String(row.product_name).slice(0, 512) : '',
          row.product_image,
          qty,
          row.currency,
          row.unit_price,
          row.total_amount,
          row.raw_json,
          row.created_at_platform,
        ];

        const [res] = await pool.execute(UPSERT_SQL, vals);
        const ar = Number(res?.affectedRows ?? 0);
        if (ar === 1) inserted += 1;
        else if (ar === 2) updated += 1;
        else skipped += 1;
      }
    }

    recordOrderItemsStats(inserted, updated, skipped, noItems, zeroAmountSkipped);
  } catch (e) {
    console.error('[persist-order-items]', e && e.message ? e.message : e);
  }
}

module.exports = { persistOrderItemsFromCache };
