'use strict';

const dayjs = require('dayjs');
const { getTenantById } = require('../tenants/service');
const { countShopsForTenant } = require('./service');
const {
  assertTenantActive,
  resolveShopLimit,
  MSG_SHOP_LIMIT,
} = require('../tenants/planService');

/**
 * @typedef {object} NormalizedOAuthShop
 * @property {string} shopId platform_shop_id
 * @property {string} shopCipher
 * @property {string} shopName
 * @property {string} region
 * @property {string} [currency]
 * @property {string} accessToken
 * @property {string} refreshToken
 * @property {string} [accessTokenExpiresAt]
 * @property {string} [refreshTokenExpiresAt]
 * @property {string|object} [scope]
 * @property {object} [rawTokenPayload]
 */

function parseExpireAt(iso) {
  if (!iso) return null;
  const d = dayjs(iso);
  return d.isValid() ? d.format('YYYY-MM-DD HH:mm:ss.SSS') : null;
}

function scopeToJson(scope) {
  if (scope == null) return null;
  if (typeof scope === 'object') return JSON.stringify(scope);
  const s = String(scope).trim();
  if (!s) return null;
  if (s.startsWith('[') || s.startsWith('{')) {
    try {
      JSON.parse(s);
      return s;
    } catch {
      /* fall through */
    }
  }
  return JSON.stringify(s.split(/[,\s]+/).filter(Boolean));
}

/**
 * @param {import('mysql2/promise').Pool} pool
 * @param {number} tenantId
 * @param {NormalizedOAuthShop[]} normalizedShops
 */
async function persistOAuthShopsToMysql(pool, tenantId, normalizedShops, opts = {}) {
  const tid = Number(tenantId);
  if (!Number.isFinite(tid) || tid <= 0) {
    const err = new Error('oauth_missing_tenant');
    err.code = 'oauth_missing_tenant';
    throw err;
  }

  const tenant = await getTenantById(pool, tid);
  if (!tenant) {
    const err = new Error('tenant_not_found');
    err.code = 'tenant_not_found';
    throw err;
  }

  if (!opts.unlimitedShops) {
    await assertTenantActive(pool, tid);
  }

  const unlimited = Boolean(opts.unlimitedShops);
  const maxShops = unlimited ? Number.MAX_SAFE_INTEGER : resolveShopLimit(tenant);
  let currentCount = await countShopsForTenant(pool, tid);
  let pendingNewInBatch = 0;
  const nowSql = dayjs().format('YYYY-MM-DD HH:mm:ss.SSS');

  let imported_count = 0;
  let updated_count = 0;
  let skipped_count = 0;
  const skipped = [];
  const shops = [];
  /** @type {string[]} platform_shop_id 已成功 import/update，可供 shops.json 双写 */
  const allowedShopIds = [];

  for (const norm of normalizedShops || []) {
    const platform = 'tiktok';
    const platform_shop_id = String(norm.shopId || '').trim().slice(0, 128);
    const shop_cipher = String(norm.shopCipher || '').trim();
    if (!platform_shop_id || !shop_cipher) {
      skipped_count += 1;
      skipped.push({ platform_shop_id: platform_shop_id || null, reason: 'missing_shop_id_or_cipher' });
      continue;
    }

    const shop_name = String(norm.shopName || platform_shop_id).trim().slice(0, 255);
    const region = String(norm.region || '').trim().toUpperCase().slice(0, 32) || null;
    const market = region;
    const seller_type = norm.sellerType
      ? String(norm.sellerType).trim().toLowerCase().slice(0, 32)
      : null;
    const currency = norm.currency ? String(norm.currency).trim().toUpperCase().slice(0, 8) : null;

    const [found] = await pool.query(
      `SELECT id, status FROM shops
       WHERE tenant_id = ? AND platform = ? AND platform_shop_id = ?
       LIMIT 1`,
      [tid, platform, platform_shop_id],
    );
    const existing = Array.isArray(found) && found[0] ? found[0] : null;

    if (existing) {
      await pool.execute(
        `UPDATE shops SET
           shop_name = ?,
           display_name = COALESCE(display_name, ?),
           market = ?,
           region = ?,
           seller_type = COALESCE(?, seller_type),
           currency = COALESCE(?, currency),
           status = 'active',
           auth_status = 'authorized',
           sync_enabled = 1,
           hidden = 0,
           last_authorized_at = ?,
           updated_at = CURRENT_TIMESTAMP(3)
         WHERE id = ? AND tenant_id = ?`,
        [shop_name, shop_name, market, region, seller_type, currency, nowSql, existing.id, tid],
      );
      updated_count += 1;
      await upsertShopAuthToken(pool, {
        tenantId: tid,
        shopId: Number(existing.id),
        platform,
        norm,
        nowSql,
      });
      shops.push({ id: existing.id, platform_shop_id, shop_name, action: 'updated' });
      allowedShopIds.push(platform_shop_id);
      continue;
    }

    if (currentCount + pendingNewInBatch >= maxShops) {
      skipped_count += 1;
      skipped.push({
        platform_shop_id,
        shop_name,
        reason: 'shop_limit_reached',
        skipped_reason: 'shop_limit_reached',
        message: MSG_SHOP_LIMIT,
        max_shops: maxShops,
        current: currentCount,
        pending_new_in_batch: pendingNewInBatch,
      });
      continue;
    }

    const [ins] = await pool.execute(
      `INSERT INTO shops (
         tenant_id, platform, platform_shop_id, shop_name, display_name, market, region, seller_type, currency,
         status, auth_status, sort_order, hidden, sync_enabled, imported_from_cache, last_authorized_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 'authorized', 0, 0, 1, 0, ?)`,
      [tid, platform, platform_shop_id, shop_name, shop_name, market, region, seller_type, currency, nowSql],
    );
    const shopRowId = Number(ins.insertId);
    currentCount += 1;
    pendingNewInBatch += 1;
    imported_count += 1;
    await upsertShopAuthToken(pool, {
      tenantId: tid,
      shopId: shopRowId,
      platform,
      norm,
      nowSql,
    });
    shops.push({ id: shopRowId, platform_shop_id, shop_name, action: 'imported' });
    allowedShopIds.push(platform_shop_id);
  }

  return {
    ok: imported_count + updated_count > 0,
    imported: imported_count,
    updated: updated_count,
    imported_count,
    updated_count,
    skipped_count,
    skipped,
    allowedShopIds,
    max_shops: maxShops,
    shops,
  };
}

async function upsertShopAuthToken(pool, { tenantId, shopId, platform, norm, nowSql }) {
  const access = String(norm.accessToken || '');
  const refresh = String(norm.refreshToken || '');
  const tokenExpire = parseExpireAt(norm.accessTokenExpiresAt);
  const refreshExpire = parseExpireAt(norm.refreshTokenExpiresAt);
  const scopeJson = scopeToJson(norm.scope ?? norm.grantedScopes);

  const [rows] = await pool.query(
    'SELECT id, raw_auth_json FROM shop_auth_tokens WHERE tenant_id = ? AND shop_id = ? ORDER BY id DESC LIMIT 1',
    [tenantId, shopId],
  );
  const existingId = Array.isArray(rows) && rows[0] ? Number(rows[0].id) : null;

  let shopCipher = String(norm.shopCipher || '').trim();
  if (!shopCipher && existingId && rows[0]?.raw_auth_json) {
    try {
      const prev =
        typeof rows[0].raw_auth_json === 'object'
          ? rows[0].raw_auth_json
          : JSON.parse(String(rows[0].raw_auth_json || '{}'));
      shopCipher = String(prev.shop_cipher || prev.shopCipher || '').trim();
    } catch {
      /* keep empty */
    }
  }

  const rawPayload = {
    ...(norm.rawTokenPayload && typeof norm.rawTokenPayload === 'object' ? norm.rawTokenPayload : {}),
    shop_cipher: shopCipher || norm.shopCipher,
    shopCipher: shopCipher || norm.shopCipher,
    shop_id: norm.shopId,
    seller_type: norm.sellerType || null,
    market: norm.region || null,
    authorized_at: nowSql,
  };

  if (existingId) {
    await pool.execute(
      `UPDATE shop_auth_tokens SET
         platform = ?,
         access_token = ?,
         refresh_token = ?,
         token_expire_at = ?,
         refresh_token_expire_at = ?,
         scope_json = ?,
         raw_auth_json = ?,
         updated_at = CURRENT_TIMESTAMP(3)
       WHERE id = ?`,
      [
        platform,
        access,
        refresh,
        tokenExpire,
        refreshExpire,
        scopeJson,
        JSON.stringify(rawPayload),
        existingId,
      ],
    );
    return;
  }

  await pool.execute(
    `INSERT INTO shop_auth_tokens (
       tenant_id, shop_id, platform, access_token, refresh_token,
       token_expire_at, refresh_token_expire_at, scope_json, raw_auth_json
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      tenantId,
      shopId,
      platform,
      access,
      refresh,
      tokenExpire,
      refreshExpire,
      scopeJson,
      JSON.stringify(rawPayload),
    ],
  );
}

module.exports = { persistOAuthShopsToMysql };
