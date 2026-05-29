'use strict';

const dayjs = require('dayjs');
const { classifyTikTokAuthError } = require('./shopAuthErrorClassifier');
const { OAUTH_TOKEN_REFRESH_URL } = require('../tiktok-api/oauthUrls');

const APP_KEY = String(process.env.TIKTOK_APP_KEY || '').trim();
const APP_SECRET = String(process.env.TIKTOK_APP_SECRET || '').trim();

/**
 * @typedef {{
 *   ok: boolean,
 *   shop?: Record<string, unknown>,
 *   category?: string,
 *   userLabel?: string,
 *   fullMessage?: string,
 *   httpStatus?: number,
 *   tiktokCode?: unknown,
 *   accessTokenExpiresAt?: string,
 *   refreshTokenExpiresAt?: string,
 * }} RefreshResult
 */

/**
 * @param {Record<string, unknown>} data — TikTok token 响应 data 段
 */
function expireAtFromTikTokTokenData(data) {
  const now = Date.now();
  let accessIn = Number(data.expires_in || data.access_token_expire_in || 0);
  let refreshIn = Number(data.refresh_expires_in || data.refresh_token_expire_in || 0);
  if (accessIn > 1e12) {
    return {
      accessExpire: dayjs(accessIn).format('YYYY-MM-DD HH:mm:ss.SSS'),
      refreshExpire:
        refreshIn > 1e12
          ? dayjs(refreshIn).format('YYYY-MM-DD HH:mm:ss.SSS')
          : dayjs(now + refreshIn * 1000).format('YYYY-MM-DD HH:mm:ss.SSS'),
    };
  }
  return {
    accessExpire: dayjs(now + accessIn * 1000).format('YYYY-MM-DD HH:mm:ss.SSS'),
    refreshExpire: dayjs(now + refreshIn * 1000).format('YYYY-MM-DD HH:mm:ss.SSS'),
  };
}

/**
 * @param {import('mysql2/promise').Pool} pool
 * @param {number} tokenRowId
 * @param {Record<string, unknown>} shop
 * @param {Record<string, unknown>} data
 */
async function persistRefreshedTokenToMysql(pool, tokenRowId, shop, data) {
  const { accessExpire, refreshExpire } = expireAtFromTikTokTokenData(data);

  const [rows] = await pool.query('SELECT raw_auth_json FROM shop_auth_tokens WHERE id = ? LIMIT 1', [
    tokenRowId,
  ]);
  const row = Array.isArray(rows) && rows[0] ? rows[0] : null;
  let raw = {};
  try {
    raw = row?.raw_auth_json ? JSON.parse(String(row.raw_auth_json)) : {};
  } catch {
    raw = {};
  }
  raw.access_token = data.access_token;
  if (data.refresh_token) raw.refresh_token = data.refresh_token;

  await pool.execute(
    `UPDATE shop_auth_tokens SET
       access_token = ?,
       refresh_token = COALESCE(?, refresh_token),
       token_expire_at = ?,
       refresh_token_expire_at = ?,
       raw_auth_json = ?,
       updated_at = CURRENT_TIMESTAMP(3)
     WHERE id = ?`,
    [
      data.access_token,
      data.refresh_token || null,
      accessExpire,
      refreshExpire,
      JSON.stringify(raw),
      tokenRowId,
    ],
  );

  const cipher = String(raw.shop_cipher || raw.shopCipher || shop.shop_cipher || shop.shopCipher || '').trim();
  return {
    ...shop,
    accessToken: data.access_token,
    refreshToken: data.refresh_token || shop.refreshToken,
    accessTokenExpiresAt: dayjs(accessExpire).toISOString(),
    refreshTokenExpiresAt: dayjs(refreshExpire).toISOString(),
    token_expire_at: accessExpire,
    shop_cipher: cipher,
    shopCipher: cipher,
    rawTokenPayload: raw,
  };
}

/**
 * 与 tiktok-api/auth.js exchangeCodeForToken 一致：auth.tiktok-shops.com GET + query
 * @param {Record<string, unknown>} shop — 需含 refreshToken / internal_shop_id
 * @returns {Promise<RefreshResult>}
 */
async function refreshShopAccessToken(shop) {
  const refreshToken = String(shop.refreshToken || shop.refresh_token || '').trim();
  if (!refreshToken) {
    const c = classifyTikTokAuthError('missing_refresh_token');
    return { ok: false, ...c, fullMessage: c.fullMessage };
  }
  if (!APP_KEY || !APP_SECRET) {
    const c = classifyTikTokAuthError('missing TIKTOK_APP_KEY or TIKTOK_APP_SECRET');
    return { ok: false, ...c, fullMessage: c.fullMessage };
  }

  const tokenUrl = new URL(OAUTH_TOKEN_REFRESH_URL);
  tokenUrl.searchParams.set('app_key', APP_KEY);
  tokenUrl.searchParams.set('app_secret', APP_SECRET);
  tokenUrl.searchParams.set('refresh_token', refreshToken);
  tokenUrl.searchParams.set('grant_type', 'refresh_token');
  const tokenUrlStr = tokenUrl.toString();

  let resp;
  let bodyText = '';
  try {
    resp = await fetch(tokenUrlStr, { method: 'GET' });
    bodyText = await resp.text();
  } catch (e) {
    const msg = String(e?.message || e);
    const c = classifyTikTokAuthError(msg);
    console.warn('[tiktok-token-refresh] network-fail', msg);
    return { ok: false, ...c, fullMessage: msg };
  }

  /** @type {Record<string, unknown>} */
  let payload = {};
  try {
    payload = bodyText ? JSON.parse(bodyText) : {};
  } catch {
    payload = { raw_body: bodyText };
  }

  const data = /** @type {Record<string, unknown>} */ (payload?.data || payload);
  const tiktokMessage = String(
    payload?.message || payload?.msg || payload?.error_description || data?.message || '',
  ).trim();
  const tiktokCode = payload?.code ?? payload?.error_code ?? data?.code;
  const accessToken = data?.access_token ?? data?.accessToken;
  const bizOk = tiktokCode == null || Number(tiktokCode) === 0;
  const hasAccess = accessToken != null && String(accessToken).trim() !== '';

  if (!resp.ok || !bizOk || !hasAccess) {
    const httpStatus = resp.status;
    const errLine = tiktokMessage || `refresh_http_${httpStatus}`;
    const c = classifyTikTokAuthError(errLine, {
      httpStatus,
      tiktokCode,
      tiktokMessage: tiktokMessage || errLine,
    });
    console.warn(
      '[tiktok-token-refresh] refresh-fail',
      `url=${OAUTH_TOKEN_REFRESH_URL}`,
      `http=${httpStatus}`,
      `code=${tiktokCode ?? ''}`,
      `message=${tiktokMessage || errLine}`,
      `category=${c.category}`,
    );
    return {
      ok: false,
      category: c.category,
      userLabel: c.userLabel,
      fullMessage: tiktokMessage || errLine,
      httpStatus,
      tiktokCode,
    };
  }

  const { getMysqlPool } = require('../db/mysqlPool');
  const pool = getMysqlPool();
  const internalId = Number(shop.internal_shop_id ?? shop.shop_id);
  const normalizedData = {
    ...data,
    access_token: String(accessToken),
    refresh_token: data.refresh_token ?? data.refreshToken ?? refreshToken,
  };
  let updatedShop = {
    ...shop,
    accessToken: normalizedData.access_token,
    refreshToken: String(normalizedData.refresh_token || refreshToken),
    ...(() => {
      const ex = expireAtFromTikTokTokenData(normalizedData);
      return {
        accessTokenExpiresAt: dayjs(ex.accessExpire).toISOString(),
        refreshTokenExpiresAt: dayjs(ex.refreshExpire).toISOString(),
        token_expire_at: ex.accessExpire,
      };
    })(),
  };

  if (pool && Number.isFinite(internalId) && internalId > 0) {
    const [tokRows] = await pool.query(
      'SELECT id FROM shop_auth_tokens WHERE shop_id = ? ORDER BY updated_at DESC, id DESC LIMIT 1',
      [internalId],
    );
    const tok = Array.isArray(tokRows) && tokRows[0] ? tokRows[0] : null;
    if (tok?.id) {
      updatedShop = await persistRefreshedTokenToMysql(pool, Number(tok.id), shop, normalizedData);
    }
  }

  console.log(
    '[tiktok-token-refresh] refresh-ok',
    `shop_id=${internalId}`,
    `url=${OAUTH_TOKEN_REFRESH_URL}`,
    `expire=${updatedShop.accessTokenExpiresAt || ''}`,
  );

  return {
    ok: true,
    category: 'access_expired_refresh_ok',
    userLabel: '刷新成功',
    shop: updatedShop,
    fullMessage: 'refresh_ok',
    accessTokenExpiresAt: updatedShop.accessTokenExpiresAt,
    refreshTokenExpiresAt: updatedShop.refreshTokenExpiresAt,
  };
}

/**
 * access 将过期或已过期时尝试 refresh
 * @param {Record<string, unknown>} shop
 * @param {{ skewMs?: number }} [opts]
 */
async function ensureShopAccessTokenFresh(shop, opts = {}) {
  const skewMs = Number(opts.skewMs) > 0 ? Number(opts.skewMs) : 60_000;
  const expIso = shop.accessTokenExpiresAt || shop.token_expire_at;
  if (expIso) {
    const expMs = new Date(expIso).getTime();
    if (Number.isFinite(expMs) && expMs > Date.now() + skewMs) {
      return { ok: true, category: 'access_ok', shop, refreshed: false };
    }
  }
  const refreshed = await refreshShopAccessToken(shop);
  if (refreshed.ok) {
    return { ...refreshed, refreshed: true };
  }
  return { ...refreshed, refreshed: false };
}

module.exports = {
  refreshShopAccessToken,
  ensureShopAccessTokenFresh,
  persistRefreshedTokenToMysql,
  OAUTH_TOKEN_REFRESH_URL,
};
