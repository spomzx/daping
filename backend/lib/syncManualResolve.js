'use strict';

const dayjs = require('dayjs');
const { getMysqlPool } = require('../db/mysqlPool');
const {
  normalizeTokenStatus,
  extractShopCipher,
  computeHasShopCipher,
} = require('./shopTokenStatus');
const { authTenantId, resolveTenantShop } = require('./resolveTenantShop');

function parseJson(v) {
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
  const sj = parseJson(scopeJson);
  if (Array.isArray(sj)) parts.push(...sj);
  else if (typeof sj === 'string') parts.push(...sj.split(/[,\s]+/));
  const raw = rawAuth && typeof rawAuth === 'object' ? rawAuth : parseJson(rawAuth);
  const gs = raw.granted_scopes || raw.grantedScopes || raw.scope;
  if (Array.isArray(gs)) parts.push(...gs);
  else if (typeof gs === 'string') parts.push(...gs.split(/[,\s]+/));
  return parts.some((s) => String(s).includes('seller.order.info'));
}

/**
 * @param {import('mysql2/promise').Pool} pool
 * @param {number} tenantId
 * @param {string} shopKey
 */
async function fetchShopRowForManual(pool, tenantId, shopKey) {
  const tid = authTenantId({ tenant_id: tenantId }) ?? Number(tenantId);
  const key = String(shopKey || '').trim();
  if (!key || !Number.isFinite(tid) || tid <= 0) return null;

  const numId = Number(key);
  if (Number.isFinite(numId) && numId > 0 && String(numId) === key) {
    return resolveTenantShop(pool, tid, { shopId: numId });
  }
  return resolveTenantShop(pool, tid, { platformShopId: key });
}

/**
 * @param {Record<string, unknown>} r
 */
function eligibilityReason(r) {
  if (!r) return 'shop_not_found';
  if (String(r.shop_status || r.status || '').toLowerCase() !== 'active') return 'shop_disabled';
  if (r.hidden === 1 || r.hidden === true) return 'shop_hidden';
  if (r.sync_enabled === 0 || r.sync_enabled === false) return 'sync_disabled';

  const token_status = normalizeTokenStatus(r);
  if (token_status === 'missing') return 'missing_token';
  if (token_status === 'expired') return 'token_expired';

  const shop_cipher = extractShopCipher(r.raw_auth_json);
  if (!shop_cipher) return 'missing_shop_cipher';
  const market = String(r.market || r.region || '').trim().toUpperCase();
  if (!market) return 'missing_market';
  if (!scopeIncludesOrderInfo(r.scope_json, r.raw_auth_json)) {
    return 'missing_scope';
  }
  return null;
}

/**
 * @param {Record<string, unknown>} r
 */
function toSyncShopRecord(r) {
  const internal_shop_id = Number(r.internal_shop_id);
  const platform_shop_id = String(r.platform_shop_id || '').trim();
  const market = String(r.market || r.region || '').trim().toUpperCase();
  const shop_cipher = extractShopCipher(r.raw_auth_json);
  const access_token = String(r.access_token || '').trim();
  const rawTokenPayload = parseJson(r.raw_auth_json);
  if (!rawTokenPayload.shop_cipher) rawTokenPayload.shop_cipher = shop_cipher;

  return {
    internal_shop_id,
    shop_id: internal_shop_id,
    platform_shop_id,
    shop_name: String(r.display_name || r.shop_name || platform_shop_id).trim(),
    market,
    tenant_id: Number(r.tenant_id),
    sync_enabled: true,
    shop_cipher,
    access_token,
    refresh_token: String(r.refresh_token || '').trim(),
    token_expire_at: r.token_expire_at ? dayjs(r.token_expire_at).format('YYYY-MM-DD HH:mm:ss.SSS') : null,
    shopId: platform_shop_id,
    shopName: String(r.display_name || r.shop_name || platform_shop_id).trim(),
    region: market,
    shopCipher: shop_cipher,
    accessToken: access_token,
    refreshToken: String(r.refresh_token || '').trim(),
    accessTokenExpiresAt: r.token_expire_at ? dayjs(r.token_expire_at).toISOString() : '',
    rawTokenPayload,
    enabled: true,
    status: 'active',
  };
}

/**
 * @param {number} tenantId
 * @param {string} shopKey
 */
async function resolveManualSyncShop(tenantId, shopKey, auth) {
  const pool = getMysqlPool();
  const input_shop_id = String(shopKey || '').trim();
  const tid = authTenantId(auth) ?? authTenantId({ tenant_id: tenantId }) ?? Number(tenantId);
  if (!pool) {
    return {
      shop: null,
      reason: 'mysql_unavailable',
      meta: { input_shop_id, resolved_shop_id: null, platform_shop_id: null, eligible: false },
    };
  }

  const row = await fetchShopRowForManual(pool, tid, shopKey);
  if (!row) {
    const denied = {
      input_shop_id,
      resolved_shop_id: null,
      platform_shop_id: null,
      eligible: false,
      reason: 'shop_not_found_or_not_eligible',
    };
    console.log('[sync-manual-run-denied]', JSON.stringify(denied));
    return { shop: null, reason: 'shop_not_found_or_not_eligible', meta: denied };
  }

  const token_status = normalizeTokenStatus(row);
  const has_token = token_status === 'active' || token_status === 'expired';
  const has_shop_cipher = computeHasShopCipher(row) === 1;
  const resolved_shop_id = Number(row.internal_shop_id);
  const platform_shop_id = String(row.platform_shop_id || '').trim();
  const sync_enabled = row.sync_enabled === 1 || row.sync_enabled === true;

  const reason = eligibilityReason(row);
  const eligible = !reason;

  const authCheck = {
    tenant_id: tid,
    shop_id: resolved_shop_id,
    platform_shop_id,
    token_status,
    has_token,
    has_shop_cipher: has_shop_cipher === 1,
    sync_enabled: sync_enabled ? 1 : 0,
    eligible,
    reason,
  };

  if (!eligible) {
    console.log('[sync-manual-run-denied]', JSON.stringify({ input_shop_id, ...authCheck }));
    return { shop: null, reason: reason || 'shop_not_found_or_not_eligible', meta: authCheck };
  }

  console.log('[sync-manual-run]', JSON.stringify({ input_shop_id, ...authCheck }));
  return { shop: toSyncShopRecord(row), reason: null, meta: authCheck };
}

module.exports = { resolveManualSyncShop, fetchShopRowForManual, eligibilityReason };
