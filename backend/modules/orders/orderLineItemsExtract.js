'use strict';

const dayjs = require('dayjs');

/**
 * 单笔订单只选用「第一个非空」明细来源；packages 仅顶层全无明细时使用。
 * 与写入、对账共用同一套：空白行剔除 + 业务键去重 + 稳定 platform_item_id。
 */

function nzStr(v) {
  const s = String(v ?? '').trim();
  return s || '';
}

/** @param {Record<string, unknown>} order */
function pickSingleSourceRawItems(order) {
  if (!order || typeof order !== 'object') return [];

  /** @type {Array<() => unknown>} */
  const getters = [
    () => order.lineItems,
    () => order.line_items,
    () => order.order_items,
    () => order.items,
    () => order.products,
    () => (order._raw && typeof order._raw === 'object' ? order._raw.line_items : null),
    () => (order._raw && typeof order._raw === 'object' ? order._raw.order_items : null),
    () => (order._raw && typeof order._raw === 'object' ? order._raw.item_list : null),
  ];

  for (const get of getters) {
    let arr;
    try {
      arr = get();
    } catch {
      continue;
    }
    if (Array.isArray(arr) && arr.length > 0) {
      return arr.filter((x) => x != null && typeof x === 'object');
    }
  }

  const pkgs = order.packages;
  if (!Array.isArray(pkgs)) return [];

  const acc = [];
  for (const p of pkgs) {
    if (!p || typeof p !== 'object') continue;
    const nested = p.items ?? p.line_items ?? p.order_items;
    if (Array.isArray(nested)) {
      for (const x of nested) {
        if (x != null && typeof x === 'object') acc.push(x);
      }
    }
  }
  return acc;
}

/**
 * 四类标识全空 → 无效行（不写库、不入对账行数）
 * @param {{ product_name: string, sku_name: string, product_id: string, sku_id: string }} row
 */
function isBlankItem(row) {
  return (
    !nzStr(row.product_name) &&
    !nzStr(row.sku_name) &&
    !nzStr(row.product_id) &&
    !nzStr(row.sku_id)
  );
}

/** 同一订单内业务去重键（与 platform_order_id 组合后在订单内唯一） */
function innerBusinessDedupeKey(row) {
  return [
    nzStr(row.product_id),
    nzStr(row.sku_id),
    nzStr(row.product_name).toLowerCase(),
    nzStr(row.sku_name).toLowerCase(),
  ].join('\x1f');
}

function parseQuantity(it) {
  const n = Math.round(Number(it.quantity ?? it.quantity_sold ?? it.count ?? it.item_quantity ?? it.qty));
  if (!Number.isFinite(n) || n < 1) return 1;
  return n;
}

function resolveUnitAndTotal(it, qty) {
  const safeQty = Math.max(1, qty);

  const lineTotalCandidates = [
    it.total_amount,
    it.original_total_product_price,
    it.line_subtotal,
    it.item_total,
    it.payment_amount,
    it.sub_total,
    it.extended_total,
  ];

  for (const x of lineTotalCandidates) {
    const n = Number(x);
    if (Number.isFinite(n) && Math.abs(n) > 0) {
      const total_amount = Number(Math.abs(n).toFixed(4));
      const unit_price = Number((total_amount / safeQty).toFixed(4));
      return { unit_price, total_amount };
    }
  }

  const unitCandidates = [it.sale_price, it.price, it.item_price, it.sku_sale_price, it.unit_price];
  for (const x of unitCandidates) {
    const u = Number(x);
    if (Number.isFinite(u) && u > 0) {
      const unit_price = Number(u.toFixed(4));
      const total_amount = Number((unit_price * safeQty).toFixed(4));
      return { unit_price, total_amount };
    }
  }

  return { unit_price: 0, total_amount: 0 };
}

/**
 * @param {Record<string, unknown>} it
 * @param {Record<string, unknown>} order
 * @param {number} rawLineIndex
 */
function normalizeLineItemRow(it, order, rawLineIndex) {
  const apiPlatformItemId = nzStr(
    it.id ?? it.line_item_id ?? it.order_line_item_id ?? it.item_id ?? it.sku_item_id ?? it.order_line_id,
  ).slice(0, 128);

  const sku_id = nzStr(it.sku_id ?? it.skuId ?? it.seller_sku_id).slice(0, 128);
  const product_id = nzStr(it.product_id ?? it.productId ?? it.item_product_id).slice(0, 128);

  let quantity = parseQuantity(it);
  if (quantity < 1) quantity = 1;

  const { unit_price, total_amount } = resolveUnitAndTotal(it, quantity);

  const oc = order?.currency ?? (order._raw && order._raw.currency);
  const currency = nzStr(it.currency ?? it.currency_code ?? oc).slice(0, 16) || null;

  const product_name = nzStr(it.product_name ?? it.title ?? it.product_title).slice(0, 512);
  const sku_name = nzStr(it.sku_name ?? it.sku_display_name).slice(0, 255);
  const pi = it.product_image;
  let imgSrc = '';
  if (pi != null && typeof pi === 'object' && pi.url != null) imgSrc = nzStr(pi.url);
  else imgSrc = nzStr(pi ?? it.image_url ?? it.sku_image);
  const product_image = imgSrc.slice(0, 1024) || null;

  let created_at_platform = null;
  const ct = it.create_time ?? it.created_at ?? it.item_create_time ?? null;
  if (ct != null && ct !== '') {
    const n = Number(ct);
    if (Number.isFinite(n) && n > 0) {
      const ms = n > 1e12 ? n : n * 1000;
      const d = dayjs(ms);
      created_at_platform = d.isValid() ? d.format('YYYY-MM-DD HH:mm:ss.SSS') : null;
    } else {
      const d = dayjs(String(ct));
      created_at_platform = d.isValid() ? d.format('YYYY-MM-DD HH:mm:ss.SSS') : null;
    }
  }

  let raw_json;
  try {
    raw_json = JSON.stringify(it);
  } catch {
    raw_json = null;
  }

  const row = {
    platform_item_id: apiPlatformItemId || `line_${rawLineIndex}`,
    _apiPlatformItemId: apiPlatformItemId,
    sku_id,
    product_id,
    quantity,
    currency,
    unit_price,
    total_amount,
    sku_name,
    product_name,
    product_image,
    created_at_platform,
    raw_json,
  };

  return row;
}

/**
 * 与写入、对账完全一致的有效行。
 * @param {Record<string, unknown>} order
 */
function extractLineItemsForOrder(order) {
  const rawItems = pickSingleSourceRawItems(order);
  /** @type {ReturnType<normalizeLineItemRow>[]} */
  const normalized = [];
  rawItems.forEach((it, idx) => {
    normalized.push(normalizeLineItemRow(it, order, idx));
  });

  const nonBlank = normalized.filter((r) => !isBlankItem(r));

  const seenBiz = new Set();
  /** @type {typeof normalized} */
  const deduped = [];
  for (const r of nonBlank) {
    const k = innerBusinessDedupeKey(r);
    if (seenBiz.has(k)) continue;
    seenBiz.add(k);
    deduped.push(r);
  }

  deduped.forEach((row, finalIdx) => {
    const api = nzStr(row._apiPlatformItemId);
    row.platform_item_id = (api || `line_${finalIdx}`).slice(0, 128);
    delete row._apiPlatformItemId;
  });

  return deduped;
}

function listDistinctLineItemsForOrder(order, _platformOrderId) {
  return extractLineItemsForOrder(order);
}

function itemCompositeKey(platform, platformOrderId, platformItemId, skuId, productId) {
  const sep = '\x1f';
  return [
    String(platform).toLowerCase(),
    String(platformOrderId).trim(),
    String(platformItemId ?? ''),
    String(skuId ?? ''),
    String(productId ?? ''),
  ].join(sep);
}

module.exports = {
  extractLineItemsForOrder,
  listDistinctLineItemsForOrder,
  normalizeLineItemRow,
  itemCompositeKey,
  pickSingleSourceRawItems,
  isBlankItem,
  innerBusinessDedupeKey,
};
