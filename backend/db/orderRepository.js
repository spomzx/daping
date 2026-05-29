'use strict';

/**
 * 订单 SQLite 仓储：upsert / 按时间与市场查询 / 按天清理。
 * 大屏当前仍走 orders-cache；此处为后续「同步写入 DB」预留，不在此文件接入业务路由。
 */

const dayjs = require('dayjs');
const { getDb } = require('./sqlite');
const { getTimeRangeBounds } = require('../lib/dashboardTimeRange');

function nowIso() {
  return dayjs().format('YYYY-MM-DD HH:mm:ss');
}

function pickOrderId(order) {
  return String(order?.order_id ?? order?.orderId ?? order?.id ?? '').trim();
}

function parseCreatedTs(order) {
  const ct = order?.create_time ?? order?.createTime ?? order?.created_at;
  if (ct == null || ct === '') return Math.floor(Date.now() / 1000);
  const n = Number(ct);
  if (Number.isFinite(n) && n > 0) return n > 1e12 ? Math.floor(n / 1000) : Math.floor(n);
  const ms = dayjs(String(ct)).valueOf();
  if (Number.isFinite(ms) && ms > 0) return Math.floor(ms / 1000);
  return Math.floor(Date.now() / 1000);
}

/**
 * 按 order_id 幂等写入；已存在则更新。
 * @param {Record<string, unknown>} order
 * @returns {{ ok: boolean, skipped?: boolean, error?: string }}
 */
function upsertOrder(order) {
  const db = getDb();
  if (!db) return { ok: false, skipped: true };
  const oid = pickOrderId(order);
  if (!oid) return { ok: false, error: 'missing_order_id' };

  const rawJson = JSON.stringify(order);
  let productItems = order?.line_items ?? order?.lineItems ?? order?.order_line_list ?? [];
  if (!Array.isArray(productItems)) {
    productItems = productItems && typeof productItems === 'object' ? [productItems] : [];
  }
  const product_items_json = JSON.stringify(productItems);

  const shop_id = String(order?.shop_id ?? order?.shopId ?? '')
    .trim()
    .toLowerCase();
  const shop_name = String(order?.shop_name ?? order?.shopName ?? '').trim();
  const market = String(order?.market ?? order?.region ?? '')
    .trim()
    .toUpperCase();
  const status = String(order?.status ?? order?.order_status ?? order?.orderStatus ?? '').trim();
  const currency = String(order?.currency ?? order?.currency_code ?? '')
    .trim()
    .toUpperCase();
  const amount =
    Number(order?.totalAmount ?? order?.orderAmountBase ?? order?.order_amount ?? order?.payment?.total_amount ?? 0) ||
    0;
  const amount_target =
    Number(order?.orderAmountTarget ?? order?.amount_target ?? order?.amountTarget ?? amount) || 0;
  const target_currency = String(order?.target_currency ?? order?.targetCurrency ?? '')
    .trim()
    .toUpperCase();
  const customer_name = String(
    order?.customer_name ?? order?.customerName ?? order?.buyer_nickname ?? order?.buyerNickname ?? '',
  ).trim();

  const created_ts = parseCreatedTs(order);
  const created_at = dayjs.unix(created_ts).format('YYYY-MM-DD HH:mm:ss');
  const updated_ts = Math.floor(Date.now() / 1000);
  const updated_at = nowIso();
  const synced_at = nowIso();

  const stmt = db.prepare(`
    INSERT INTO orders (
      order_id, shop_id, shop_name, market, status, currency, amount, amount_target, target_currency,
      customer_name, product_items_json, raw_json, created_at, created_ts, updated_at, updated_ts, synced_at
    ) VALUES (
      @order_id, @shop_id, @shop_name, @market, @status, @currency, @amount, @amount_target, @target_currency,
      @customer_name, @product_items_json, @raw_json, @created_at, @created_ts, @updated_at, @updated_ts, @synced_at
    )
    ON CONFLICT(order_id) DO UPDATE SET
      shop_id = excluded.shop_id,
      shop_name = excluded.shop_name,
      market = excluded.market,
      status = excluded.status,
      currency = excluded.currency,
      amount = excluded.amount,
      amount_target = excluded.amount_target,
      target_currency = excluded.target_currency,
      customer_name = excluded.customer_name,
      product_items_json = excluded.product_items_json,
      raw_json = excluded.raw_json,
      updated_at = excluded.updated_at,
      updated_ts = excluded.updated_ts,
      synced_at = excluded.synced_at
  `);

  stmt.run({
    order_id: oid,
    shop_id,
    shop_name,
    market,
    status,
    currency,
    amount,
    amount_target,
    target_currency,
    customer_name,
    product_items_json,
    raw_json: rawJson,
    created_at,
    created_ts,
    updated_at,
    updated_ts,
    synced_at,
  });

  return { ok: true };
}

/**
 * 转为与 orders-cache 聚合入口相近的扁平结构（供后续替换数据源时复用）。
 * @param {Record<string, unknown>} row
 */
function rowToOrderLike(row) {
  let raw = {};
  try {
    raw = row.raw_json ? JSON.parse(String(row.raw_json)) : {};
  } catch (_) {
    raw = {};
  }
  return {
    orderId: row.order_id,
    id: row.order_id,
    shopId: row.shop_id || '',
    shopName: row.shop_name || '',
    orderStatus: row.status || '',
    status: row.status || '',
    region: row.market || '',
    market: row.market || '',
    customerName: row.customer_name || '',
    currency: row.currency || '',
    totalAmount: Number(row.amount) || 0,
    orderAmountBase: Number(row.amount) || 0,
    orderAmountTarget: Number(row.amount_target) || 0,
    createTime: row.created_ts != null ? String(row.created_ts) : '',
    targetCurrency: row.target_currency || '',
    _raw: raw,
  };
}

/**
 * @param {{ range?: string, startDate?: string, endDate?: string, market?: string, shopId?: string, status?: string, limit?: number }} params
 */
function queryOrders(params = {}) {
  const db = getDb();
  if (!db) return [];
  const range = params.range != null ? String(params.range) : 'today';
  const b = getTimeRangeBounds(range, params.startDate, params.endDate);
  const startSec = b.startSec;
  const endSec = b.endSec;

  const cond = ['created_ts IS NOT NULL', 'created_ts >= ?', 'created_ts <= ?'];
  const vals = [startSec, endSec];

  const market = params.market != null ? String(params.market).trim().toUpperCase() : '';
  if (market && market !== 'ALL') {
    cond.push('market = ?');
    vals.push(market);
  }

  const shopId = params.shopId != null ? String(params.shopId).trim().toLowerCase() : '';
  if (shopId && shopId !== 'all') {
    cond.push('lower(shop_id) = ?');
    vals.push(shopId);
  }

  const status = params.status != null ? String(params.status).trim() : '';
  if (status) {
    cond.push('status = ?');
    vals.push(status);
  }

  const limit = Math.min(5000, Math.max(1, Number(params.limit) || 2000));
  const sql = `SELECT * FROM orders WHERE ${cond.join(' AND ')} ORDER BY created_ts DESC LIMIT ?`;
  const rows = db.prepare(sql).all(...vals, limit);
  return rows.map(rowToOrderLike);
}

/**
 * 删除 created_ts 早于「当前时间 - days 天」的订单（默认保留 90 天）。
 * @param {number} [days=90]
 */
function deleteOrdersBefore(days = 90) {
  const db = getDb();
  if (!db) return { ok: false, skipped: true };
  const d = Math.max(1, Number(days) || 90);
  const cutoff = Math.floor(Date.now() / 1000) - d * 86400;
  const info = db.prepare('DELETE FROM orders WHERE created_ts < ?').run(cutoff);
  return { ok: true, changes: info.changes };
}

module.exports = {
  upsertOrder,
  queryOrders,
  deleteOrdersBefore,
};
