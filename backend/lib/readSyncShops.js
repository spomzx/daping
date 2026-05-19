'use strict';

/**
 * SaaS 数据中台 — 同步店铺唯一读取入口（MySQL Single Source of Truth）
 * worker / scheduler / reconcile / audit 均应 require 本模块。
 *
 * OPENAPI_SHOPS_SOURCE=mysql（默认）| json（紧急回滚，禁止生产默认）
 */

const dayjs = require('dayjs');
const { getMysqlPool } = require('../db/mysqlPool');
const { readShops, listEligibleDashboardShops, shopCipherString } = require('../tiktok-api/shops');

const CAVERA_PLATFORM_SHOP_ID = '7496312889470388950';

const DB_SCHEMA_DOC = {
  shops: {
    internal_shop_id: 'shops.id — orders.shop_id FK',
    platform_shop_id: 'shops.platform_shop_id — TikTok 店铺 ID',
    tenant_id: 'shops.tenant_id',
    sync_enabled: 'shops.sync_enabled — 1 才进 worker',
    status: "shops.status = 'active'",
    hidden: 'shops.hidden = 0',
    market: 'shops.market / shops.region',
  },
  shop_auth_tokens: {
    access_token: 'shop_auth_tokens.access_token',
    refresh_token: 'shop_auth_tokens.refresh_token',
    token_expire_at: 'shop_auth_tokens.token_expire_at',
    shop_cipher: 'shop_auth_tokens.raw_auth_json.shop_cipher',
  },
  orders: {
    shop_id: 'orders.shop_id → shops.id（内部主键，禁止存 platform_shop_id）',
    platform_shop_id: 'orders.platform_shop_id — TikTok 店铺 ID（列见 migrateOrders30）',
    platform_order_id: 'orders.platform_order_id',
    tenant_id: 'orders.tenant_id',
  },
};

function getOpenApiShopsSource() {
  return String(process.env.OPENAPI_SHOPS_SOURCE || 'mysql').trim().toLowerCase();
}

function cipherTail(cipher) {
  const s = String(cipher || '').trim();
  if (!s) return '';
  return s.length <= 8 ? s : s.slice(-8);
}

function parseJsonField(v) {
  if (v == null) return {};
  if (typeof v === 'object') return v;
  try {
    return JSON.parse(String(v));
  } catch {
    return {};
  }
}

function scopeIncludesOrderInfo(scopeJson, rawAuth) {
  const parts = [];
  const sj = parseJsonField(scopeJson);
  if (Array.isArray(sj)) parts.push(...sj);
  else if (typeof sj === 'string') parts.push(...sj.split(/[,\s]+/));
  const raw = rawAuth && typeof rawAuth === 'object' ? rawAuth : parseJsonField(rawAuth);
  const gs = raw.granted_scopes || raw.grantedScopes || raw.scope;
  if (Array.isArray(gs)) parts.push(...gs);
  else if (typeof gs === 'string') parts.push(...gs.split(/[,\s]+/));
  return parts.some((s) => String(s).includes('seller.order.info'));
}

function extractShopCipher(rawAuth) {
  const raw = rawAuth && typeof rawAuth === 'object' ? rawAuth : parseJsonField(rawAuth);
  return String(raw.shop_cipher || raw.shopCipher || '').trim();
}

/**
 * 统一同步店铺结构（OpenAPI worker 消费）
 * @typedef {object} SyncShopRecord
 * @property {number} internal_shop_id
 * @property {number} shop_id
 * @property {string} platform_shop_id
 * @property {string} shop_name
 * @property {string} market
 * @property {number} tenant_id
 * @property {boolean} sync_enabled
 * @property {string} shop_cipher
 * @property {string} access_token
 * @property {string} refresh_token
 * @property {string} token_expire_at
 */

/**
 * @param {import('mysql2/promise').Pool} pool
 * @param {{ tenantId?: number }} [opts]
 * @returns {Promise<SyncShopRecord[]>}
 */
async function readSyncShopsFromMysql(pool, opts = {}) {
  if (!pool) return [];

  const tenantClause =
    opts.tenantId != null && Number.isFinite(Number(opts.tenantId))
      ? ' AND s.tenant_id = ? '
      : '';
  const params = opts.tenantId != null && Number.isFinite(Number(opts.tenantId)) ? [Number(opts.tenantId)] : [];

  const [rows] = await pool.query(
    `
    SELECT
      s.id AS internal_shop_id,
      s.tenant_id,
      s.platform,
      s.platform_shop_id,
      s.shop_name,
      s.display_name,
      s.market,
      s.region,
      s.sync_enabled,
      s.hidden,
      s.status,
      s.last_sync_at,
      t.access_token,
      t.refresh_token,
      t.token_expire_at,
      t.refresh_token_expire_at,
      t.scope_json,
      t.raw_auth_json
    FROM shops s
    INNER JOIN shop_auth_tokens t ON t.id = (
      SELECT t2.id FROM shop_auth_tokens t2
      WHERE t2.shop_id = s.id ORDER BY t2.id DESC LIMIT 1
    )
    WHERE s.platform = 'tiktok'
      AND s.status = 'active'
      AND (s.hidden = 0 OR s.hidden IS NULL)
      AND s.sync_enabled = 1
      AND TRIM(COALESCE(s.market, s.region, '')) <> ''
      ${tenantClause}
    ORDER BY s.sort_order ASC, s.id ASC
    `,
    params,
  );

  const eligible = [];
  const skipped = [];

  for (const r of Array.isArray(rows) ? rows : []) {
    const internal_shop_id = Number(r.internal_shop_id);
    const platform_shop_id = String(r.platform_shop_id || '').trim();
    const market = String(r.market || r.region || '').trim().toUpperCase();
    const shop_cipher = extractShopCipher(r.raw_auth_json);
    const access_token = String(r.access_token || '').trim();
    const refresh_token = String(r.refresh_token || '').trim();

    const reasons = [];
    if (!platform_shop_id) reasons.push('missing_platform_shop_id');
    if (!market) reasons.push('missing_market');
    if (!shop_cipher) reasons.push('missing_shop_cipher');
    if (!access_token) reasons.push('missing_access_token');
    if (!scopeIncludesOrderInfo(r.scope_json, r.raw_auth_json)) {
      reasons.push('missing_seller.order.info_scope');
    }

    if (reasons.length > 0) {
      skipped.push({
        internal_shop_id,
        platform_shop_id,
        shop_name: String(r.display_name || r.shop_name || '').trim(),
        market,
        reasons,
      });
      continue;
    }

    const rawTokenPayload = parseJsonField(r.raw_auth_json);
    if (!rawTokenPayload.shop_cipher) rawTokenPayload.shop_cipher = shop_cipher;

    eligible.push({
      internal_shop_id,
      shop_id: internal_shop_id,
      platform_shop_id,
      shop_name: String(r.display_name || r.shop_name || platform_shop_id).trim(),
      market,
      tenant_id: Number(r.tenant_id),
      sync_enabled: true,
      shop_cipher,
      access_token,
      refresh_token,
      token_expire_at: r.token_expire_at ? dayjs(r.token_expire_at).format('YYYY-MM-DD HH:mm:ss.SSS') : null,
      shopId: platform_shop_id,
      shopName: String(r.display_name || r.shop_name || platform_shop_id).trim(),
      region: market,
      shopCipher: shop_cipher,
      accessToken: access_token,
      refreshToken: refresh_token,
      accessTokenExpiresAt: r.token_expire_at ? dayjs(r.token_expire_at).toISOString() : '',
      refreshTokenExpiresAt: r.refresh_token_expire_at
        ? dayjs(r.refresh_token_expire_at).toISOString()
        : '',
      grantedScopes: parseJsonField(r.scope_json),
      rawTokenPayload,
      enabled: true,
      status: 'active',
      lastSyncAt: r.last_sync_at ? dayjs(r.last_sync_at).format('YYYY-MM-DD HH:mm:ss') : '',
    });
  }

  if (skipped.length > 0) {
    console.warn('[read-sync-shops-skipped]', JSON.stringify({ count: skipped.length, shops: skipped }, null, 2));
  }

  eligible.sort((a, b) => {
    const aC = String(a.platform_shop_id) === CAVERA_PLATFORM_SHOP_ID ? 0 : 1;
    const bC = String(b.platform_shop_id) === CAVERA_PLATFORM_SHOP_ID ? 0 : 1;
    if (aC !== bC) return aC - bC;
    return String(a.shop_name || '').localeCompare(String(b.shop_name || ''));
  });

  return eligible;
}

async function loadShopsFromJsonLegacy() {
  const jsonShops = readShops().filter((s) => s && s.enabled !== false);
  return listEligibleDashboardShops(jsonShops);
}

async function loadShopsForOpenApiCollect(opts = {}) {
  const source = getOpenApiShopsSource();
  if (source === 'json') {
    console.warn('[read-sync-shops] OPENAPI_SHOPS_SOURCE=json — legacy shops.json（非生产）');
    return loadShopsFromJsonLegacy();
  }

  const pool = getMysqlPool();
  if (!pool) {
    const err = new Error('[read-sync-shops] MySQL unavailable; OPENAPI_SHOPS_SOURCE=mysql');
    err.code = 'mysql_unavailable';
    throw err;
  }

  const shops = await readSyncShopsFromMysql(pool, opts);
  if (shops.length === 0) {
    const err = new Error(
      '[read-sync-shops] MySQL sync shop list empty — refusing shops.json fallback. Run importLegacyShopsJson.js or fix tokens.',
    );
    err.code = 'mysql_sync_shops_empty';
    throw err;
  }
  return shops;
}

async function patchMysqlShopSyncState(internalShopId, patch = {}) {
  const pool = getMysqlPool();
  if (!pool || !Number.isFinite(Number(internalShopId))) return null;

  const id = Number(internalShopId);
  const fields = ['last_sync_at = CURRENT_TIMESTAMP(3)'];
  const params = [];

  if (patch.lastSyncError != null) {
    fields.push('last_health_message = ?');
    params.push(String(patch.lastSyncError).slice(0, 2000));
  }
  if (patch.lastSyncOk === true) fields.push("last_health_status = 'ok'");
  else if (patch.lastSyncOk === false) fields.push("last_health_status = 'warning'");
  if (patch.status === 'expired') fields.push("auth_status = 'expired'");

  params.push(id);
  await pool.execute(`UPDATE shops SET ${fields.join(', ')}, updated_at = CURRENT_TIMESTAMP(3) WHERE id = ?`, params);
  return { id };
}

async function loadOpenApiSyncStateFromMysql() {
  const pool = getMysqlPool();
  const map = new Map();
  if (!pool) return map;

  const [rows] = await pool.query(
    `SELECT id, platform_shop_id, last_sync_at, last_health_status, last_health_message, sync_enabled
     FROM shops WHERE platform = 'tiktok' AND status <> 'deleted'`,
  );

  for (const r of Array.isArray(rows) ? rows : []) {
    const pid = String(r.platform_shop_id || '').trim().toLowerCase();
    if (!pid) continue;
    map.set(pid, {
      lastSyncAtMs: r.last_sync_at ? dayjs(r.last_sync_at).valueOf() : 0,
      lastSyncOk: String(r.last_health_status || '') === 'ok',
      lastSyncError: String(r.last_health_message || ''),
      enabled: r.sync_enabled !== 0,
      internal_shop_id: Number(r.id),
    });
  }
  return map;
}

function buildShopSyncLogPayload(shop) {
  const cipher = shopCipherString(shop);
  return {
    internal_shop_id: shop.internal_shop_id ?? shop.shop_id ?? null,
    platform_shop_id: String(shop.platform_shop_id || shop.shopId || '').trim(),
    shop_name: String(shop.shop_name || shop.shopName || '').trim(),
    market: String(shop.market || shop.region || '').trim().toUpperCase(),
    shop_cipher_tail: cipherTail(cipher),
    sync_enabled: shop.sync_enabled !== false,
    has_shop_cipher: Boolean(cipher),
    has_token: Boolean(String(shop.access_token || shop.accessToken || '').trim()),
  };
}

function buildOpenApiSyncShopListLog(shops) {
  const markets = [...new Set(shops.map((s) => String(s.market || '').toUpperCase()).filter(Boolean))];
  return {
    source: getOpenApiShopsSource(),
    architecture: 'mysql_single_source_of_truth',
    total: shops.length,
    markets,
    shops: shops.map((s) => buildShopSyncLogPayload(s)),
  };
}

function buildShopSyncResultLog(shop, result) {
  return {
    ...buildShopSyncLogPayload(shop),
    total_count: result.total_count ?? 0,
    raw_orders_length: result.raw_orders_length ?? 0,
    saved_orders: result.saved_orders ?? 0,
    saved_items: result.saved_items ?? 0,
    mysql_written: result.mysql_written ?? 0,
    cache_written: result.cache_written ?? 0,
    duration_ms: result.duration_ms ?? 0,
    ok: result.ok !== false,
    error: result.error || null,
  };
}

function stampOrdersWithShopContext(orders, shop) {
  const pid = String(shop.platform_shop_id || shop.shopId || '').trim();
  const name = String(shop.shop_name || shop.shopName || '').trim();
  const market = String(shop.market || shop.region || '').trim().toUpperCase();
  const internalId = shop.internal_shop_id ?? shop.shop_id ?? null;
  const ctx = buildShopSyncLogPayload(shop);

  if (!pid || !internalId) {
    console.warn('[order-shop-stamp-skip]', { reason: 'missing_ids', ctx });
    return { orders: [], ctx: { ...ctx, internal_shop_id: internalId } };
  }

  const out = [];
  for (const o of Array.isArray(orders) ? orders : []) {
    if (!o || typeof o !== 'object') continue;
    out.push({
      ...o,
      internal_shop_id: internalId,
      platform_shop_id: pid,
      shopId: pid,
      shop_id: pid,
      shopName: name || o.shopName,
      shop_name: name || o.shop_name,
      region: market || o.region,
      market,
    });
  }
  return {
    orders: out,
    ctx: {
      ...ctx,
      internal_shop_id: internalId,
      tenant_id: Number(shop.tenant_id) || null,
    },
  };
}

module.exports = {
  CAVERA_PLATFORM_SHOP_ID,
  DB_SCHEMA_DOC,
  getOpenApiShopsSource,
  cipherTail,
  readSyncShopsFromMysql,
  loadShopsForOpenApiCollect,
  loadShopsFromJsonLegacy,
  patchMysqlShopSyncState,
  loadOpenApiSyncStateFromMysql,
  buildShopSyncLogPayload,
  buildOpenApiSyncShopListLog,
  buildShopSyncResultLog,
  stampOrdersWithShopContext,
};
