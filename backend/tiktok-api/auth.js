const crypto = require('crypto');
const dayjs = require('dayjs');
const { upsertShop } = require('./shops');
const { signOpenApiRequest } = require('./client');

require('dotenv').config();

const PARTNER_AUTH_URL = 'https://services.tiktokshop.com/open/authorize';
const OAUTH_TOKEN_URL = 'https://auth.tiktok-shops.com/api/v2/token/get';
const API_BASE = process.env.TIKTOK_API_BASE_URL || 'https://open-api.tiktokglobalshop.com';

const OAUTH_STATE_TTL_MS = 15 * 60 * 1000;
/** @type {Map<string, { region: string, tenantId: number, userId: number, nonce: string, timestamp: number, expiresAt: number }>} */
const oauthPendingByState = new Map();
const ALLOWED_OAUTH_REGIONS = new Set(['TH', 'MY', 'SG', 'PH', 'VN']);

function randomState() {
  return crypto.randomBytes(12).toString('hex');
}

function pruneOAuthStates() {
  const now = Date.now();
  for (const [k, v] of oauthPendingByState.entries()) {
    if (v.expiresAt <= now) oauthPendingByState.delete(k);
  }
}

/**
 * @param {{ region: string, tenantId: number, userId: number }} ctx
 */
function registerOAuthState(ctx) {
  pruneOAuthStates();
  const tenantId = Number(ctx?.tenantId);
  const userId = Number(ctx?.userId);
  if (!Number.isFinite(tenantId) || tenantId <= 0 || !Number.isFinite(userId) || userId <= 0) {
    throw new Error('oauth_missing_tenant');
  }
  const state = randomState();
  oauthPendingByState.set(state, {
    region: String(ctx.region || '').toUpperCase(),
    tenantId,
    userId,
    nonce: crypto.randomBytes(8).toString('hex'),
    timestamp: Date.now(),
    expiresAt: Date.now() + OAUTH_STATE_TTL_MS,
  });
  return state;
}

function consumeOAuthState(state) {
  pruneOAuthStates();
  const key = String(state || '').trim();
  const row = oauthPendingByState.get(key);
  if (!row || row.expiresAt < Date.now()) {
    if (row) oauthPendingByState.delete(key);
    return null;
  }
  oauthPendingByState.delete(key);
  return {
    region: row.region,
    tenantId: row.tenantId,
    userId: row.userId,
    nonce: row.nonce,
    timestamp: row.timestamp,
  };
}

function normalizeOAuthRegion(value) {
  const r = String(value || '').trim().toUpperCase();
  if (!r) return null;
  if (ALLOWED_OAUTH_REGIONS.has(r)) return r;
  return null;
}

function edgeSlice(value, n) {
  const v = String(value || '');
  if (!v) return { prefix: '', suffix: '' };
  if (v.length <= n * 2) return { prefix: v, suffix: v };
  return { prefix: v.slice(0, n), suffix: v.slice(-n) };
}

/**
 * 构建 TikTok Partner 授权跳转 URL（含服务端登记的 state，防 CSRF）
 * @param {string} region - TH | MY | SG | PH | VN
 * @param {{ tenant_id: number, user_id: number }} authContext
 */
function buildPartnerAuthorizeUrl(region, authContext) {
  const r = normalizeOAuthRegion(region);
  if (!r) {
    throw new Error('invalid_oauth_region');
  }
  const tenantId = Number(authContext?.tenant_id);
  const userId = Number(authContext?.user_id);
  if (!Number.isFinite(tenantId) || tenantId <= 0 || !Number.isFinite(userId) || userId <= 0) {
    throw new Error('oauth_missing_tenant');
  }
  const appKey = process.env.TIKTOK_APP_KEY;
  const appId = process.env.TIKTOK_APP_ID;
  const redirectUri = process.env.TIKTOK_REDIRECT_URI;
  if (!appKey || !redirectUri) {
    throw new Error('Missing TIKTOK_APP_KEY or TIKTOK_REDIRECT_URI');
  }
  if (!appId) {
    throw new Error('Missing TIKTOK_APP_ID');
  }
  const state = registerOAuthState({ region: r, tenantId, userId });
  const u = new URL(PARTNER_AUTH_URL);
  u.searchParams.set('service_id', appId);
  u.searchParams.set('app_key', appKey);
  u.searchParams.set('redirect_url', redirectUri);
  u.searchParams.set('state', state);
  u.searchParams.set('region', r);
  return u.toString();
}

/**
 * @param {string} [region] - 未传时使用 TIKTOK_AUTH_DEFAULT_REGION 或 TH
 * @param {{ tenant_id: number, user_id: number }} [authContext]
 */
function getAuthUrl(region, authContext) {
  const r =
    normalizeOAuthRegion(region) ||
    normalizeOAuthRegion(process.env.TIKTOK_AUTH_DEFAULT_REGION) ||
    'TH';
  if (!authContext?.tenant_id) {
    throw new Error('oauth_missing_tenant');
  }
  return { url: buildPartnerAuthorizeUrl(r, authContext) };
}

async function exchangeCodeForToken(code) {
  const appKey = process.env.TIKTOK_APP_KEY || '';
  const appSecret = process.env.TIKTOK_APP_SECRET || '';
  const tokenUrl = new URL(OAUTH_TOKEN_URL);
  tokenUrl.searchParams.set('app_key', appKey);
  tokenUrl.searchParams.set('app_secret', appSecret);
  tokenUrl.searchParams.set('auth_code', code || '');
  tokenUrl.searchParams.set('grant_type', 'authorized_code');
  const tokenUrlStr = tokenUrl.toString();
  console.log('[tiktok-callback] token request', {
    tokenUrl: tokenUrlStr,
    app_key: appKey,
    has_auth_code: Boolean(code),
  });
  const resp = await fetch(tokenUrlStr, { method: 'GET' });
  const status = resp.status;
  const bodyText = await resp.text();
  console.log('[tiktok-callback] token response', { tokenUrl: tokenUrlStr, status, body: bodyText });
  if (!resp.ok) {
    const err = new Error(`token_http_${status}`);
    err.debug = { tokenUrl: tokenUrlStr, status, body: bodyText };
    throw err;
  }
  let payload = null;
  try {
    payload = bodyText ? JSON.parse(bodyText) : {};
  } catch {
    const err = new Error('token_payload_invalid_json');
    err.debug = { tokenUrl: tokenUrlStr, status, body: bodyText };
    throw err;
  }
  const data = payload?.data ?? payload;
  const access = data?.access_token ?? data?.accessToken;
  const refresh = data?.refresh_token ?? data?.refreshToken;
  if (!access || !refresh) {
    const err = new Error('token_payload_invalid');
    err.debug = { tokenUrl: tokenUrlStr, status, body: bodyText };
    throw err;
  }
  return { ...data, access_token: access, refresh_token: refresh };
}

function mapTokenDataToShop(data) {
  const now = Date.now();
  const accessExpiresIn = Number(data.expires_in || data.access_token_expire_in || 0);
  const refreshExpiresIn = Number(data.refresh_expires_in || data.refresh_token_expire_in || 0);
  const accessExpiresAt = dayjs(now + accessExpiresIn * 1000).toISOString();
  const refreshExpiresAt = dayjs(now + refreshExpiresIn * 1000).toISOString();
  const appId = String(process.env.TIKTOK_APP_ID || '').trim();
  const appKey = String(process.env.TIKTOK_APP_KEY || '').trim();
  const primaryShopId = String(data.shop_id || data.seller_id || data.shop_cipher || '').trim();
  const shopCipher = String(data.shop_cipher || '').trim();
  const openId = String(data.open_id || data.openid || '').trim();
  const sellerBaseRegion = String(data.seller_base_region || data.sellerBaseRegion || '').toUpperCase();
  const shopId = primaryShopId || openId || [appId || appKey, 'oauth'].filter(Boolean).join('_') || `oauth_${now}`;
  return {
    shopId,
    shopCipher,
    shopName: String(data.seller_name || data.shop_name || shopId || 'TikTok Shop'),
    region: String(data.region || data.market || sellerBaseRegion || '').toUpperCase(),
    currency: String(data.currency || '').toUpperCase(),
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresIn: accessExpiresIn,
    refreshExpiresIn,
    accessTokenExpiresAt: accessExpiresAt,
    refreshTokenExpiresAt: refreshExpiresAt,
    appId,
    appKey,
    openId,
    sellerBaseRegion,
    tokenType: String(data.token_type || ''),
    scope: data.scope || '',
    rawTokenPayload: data,
    enabled: true,
  };
}

function extractShopList(payload) {
  const data = payload?.data ?? payload ?? {};
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.shops)) return data.shops;
  if (Array.isArray(data?.shop_list)) return data.shop_list;
  if (Array.isArray(data?.authorized_shop_list)) return data.authorized_shop_list;
  if (Array.isArray(data?.shop_list_info)) return data.shop_list_info;
  if (Array.isArray(data?.shopList)) return data.shopList;
  if (Array.isArray(data?.shop_infos)) return data.shop_infos;
  return [];
}

function normalizeAuthorizedShop(raw, tokenData) {
  const now = Date.now();
  const accessExpiresIn = Number(tokenData?.expires_in || tokenData?.access_token_expire_in || 0);
  const refreshExpiresIn = Number(tokenData?.refresh_expires_in || tokenData?.refresh_token_expire_in || 0);
  const accessExpiresAt = dayjs(now + accessExpiresIn * 1000).toISOString();
  const refreshExpiresAt = dayjs(now + refreshExpiresIn * 1000).toISOString();
  const appId = String(process.env.TIKTOK_APP_ID || '').trim();
  const appKey = String(process.env.TIKTOK_APP_KEY || '').trim();
  const openId = String(tokenData?.open_id || tokenData?.openid || '').trim();
  const shopId = String(raw?.shop_id || raw?.seller_id || raw?.id || '').trim();
  const shopCipher = String(raw?.shop_cipher || raw?.shopCipher || raw?.cipher || '').trim();
  const shopName = String(raw?.shop_name || raw?.seller_name || raw?.name || shopId || 'TikTok Shop').trim();
  const sellerBaseRegion = String(raw?.seller_base_region || raw?.sellerBaseRegion || '').toUpperCase();
  const region = String(raw?.region || raw?.market || sellerBaseRegion || '').toUpperCase();
  const grantedScopes = raw?.granted_scopes || raw?.grantedScopes || tokenData?.granted_scopes || tokenData?.scope || '';
  return {
    shopId,
    shopCipher,
    shopName,
    region,
    sellerBaseRegion,
    currency: String(raw?.currency || '').toUpperCase(),
    accessToken: tokenData?.access_token,
    refreshToken: tokenData?.refresh_token,
    expiresIn: accessExpiresIn,
    refreshExpiresIn,
    accessTokenExpiresAt: accessExpiresAt,
    refreshTokenExpiresAt: refreshExpiresAt,
    appId,
    appKey,
    openId,
    tokenType: String(tokenData?.token_type || ''),
    scope: tokenData?.scope || '',
    grantedScopes,
    rawTokenPayload: tokenData || {},
    enabled: true,
  };
}

async function fetchAuthorizedShops(accessToken) {
  const appKey = String(process.env.TIKTOK_APP_KEY || '');
  const appSecret = String(process.env.TIKTOK_APP_SECRET || '');
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const pathname = '/authorization/202309/shops';
  const query = { app_key: appKey, timestamp };
  const signMeta = signOpenApiRequest(pathname, query, '');
  query.sign = signMeta.generatedSign;
  const u = new URL(pathname, API_BASE);
  for (const [k, v] of Object.entries(query)) u.searchParams.set(k, String(v));
  const requestUrl = u.toString();
  const requestMethod = 'GET';
  const hasXttsAccessToken = Boolean(accessToken);
  const secretEdges = edgeSlice(appSecret, 6);
  const stringToSignMasked = `${secretEdges.prefix || ''}***${signMeta.signSource}***${secretEdges.suffix || ''}`;
  const requestDebug = {
    request_url: requestUrl,
    request_method: requestMethod,
    query,
    path: pathname,
    timestamp,
    sign: signMeta.generatedSign,
    sortedQueryKeys: signMeta.sortedQueryKeys,
    appKeyUsed: appKey,
    appSecretPrefix: secretEdges.prefix || '',
    appSecretSuffix: secretEdges.suffix || '',
    stringToSignMasked,
    has_x_tts_access_token: hasXttsAccessToken,
  };
  console.log('[tiktok-callback] authorized shops request', requestDebug);

  const resp = await fetch(requestUrl, {
    method: requestMethod,
    headers: {
      'x-tts-access-token': String(accessToken || ''),
      'content-type': 'application/json',
    },
  });
  const bodyText = await resp.text();
  let payload = {};
  try {
    payload = bodyText ? JSON.parse(bodyText) : {};
  } catch {
    payload = {};
  }

  const responseCode = payload?.code ?? payload?.error_code ?? null;
  const responseMessage = payload?.message || payload?.msg || payload?.error_msg || '';
  const responseData = payload?.data ?? null;
  const requestId = payload?.request_id || payload?.requestId || '';
  const responseDebug = {
    ...requestDebug,
    response_http_status: resp.status,
    response_code: responseCode,
    response_message: responseMessage,
    response_data: responseData,
    request_id: requestId,
    raw_body: bodyText,
  };
  console.log('[tiktok-callback] authorized shops response', responseDebug);

  const list = extractShopList(payload);
  if (!resp.ok || (responseCode != null && Number(responseCode) !== 0) || list.length === 0) {
    const err = new Error('authorized_shops_invalid');
    err.debug = responseDebug;
    throw err;
  }
  return { list, debug: responseDebug };
}

async function runAuthorizedShopsSignTest(accessToken) {
  try {
    const { list, debug } = await fetchAuthorizedShops(accessToken);
    return {
      ok: true,
      ...debug,
      response_data: debug.response_data ?? { shops: list },
    };
  } catch (e) {
    return {
      ok: false,
      ...(e?.debug || {}),
      response_message: e?.debug?.response_message || String(e?.message || e),
    };
  }
}

async function debugShopList(accessToken) {
  const appKey = String(process.env.TIKTOK_APP_KEY || '');
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const candidates = [
    '/authorization/202309/shops',
    '/authorization/202309/shops/search',
    '/seller/202309/shops',
    '/shop/202309/authorized_shops',
    '/authorization/202309/authorized_shops',
  ];
  const out = [];
  for (const pathname of candidates) {
    const query = { app_key: appKey, timestamp };
    const signMeta = signOpenApiRequest(pathname, query, '');
    query.sign = signMeta.generatedSign;
    const u = new URL(pathname, API_BASE);
    for (const [k, v] of Object.entries(query)) u.searchParams.set(k, String(v));
    const finalUrl = u.toString();
    let status = 0;
    let body = '';
    try {
      const resp = await fetch(finalUrl, {
        method: 'GET',
        headers: { 'x-tts-access-token': String(accessToken || '') },
      });
      status = resp.status;
      body = await resp.text();
    } catch (e) {
      status = 0;
      body = String(e?.message || e);
    }
    console.log('[tiktok-debug-shop-list]', {
      path: pathname,
      pathForSign: signMeta.pathForSign,
      signKeys: signMeta.signKeys,
      bodyForSign: signMeta.bodyForSign,
      generatedSign: signMeta.generatedSign,
      finalUrl,
      status,
      body,
    });
    out.push({ path: pathname, finalUrl, status, body });
  }
  return out;
}

/**
 * @param {string} code
 * @param {{ oauthRegion?: string, tenantId?: number, userId?: number }} [opts]
 */
async function handleCallbackByCode(code, opts = {}) {
  const tenantId = Number(opts.tenantId);
  if (!Number.isFinite(tenantId) || tenantId <= 0) {
    const err = new Error('oauth_missing_tenant');
    err.code = 'oauth_missing_tenant';
    throw err;
  }

  const oauthRegion = normalizeOAuthRegion(opts.oauthRegion) || '';
  const tokenData = await exchangeCodeForToken(code);
  const shopsResult = await fetchAuthorizedShops(tokenData.access_token);
  const shopsRaw = Array.isArray(shopsResult?.list) ? shopsResult.list : [];
  const normalizedList = [];
  const authorizedAt = dayjs().toISOString();
  if (Array.isArray(shopsRaw) && shopsRaw.length > 0) {
    for (const raw of shopsRaw) {
      let normalized = normalizeAuthorizedShop(raw, tokenData);
      if (!normalized.shopId || !normalized.shopCipher) continue;
      if (oauthRegion && !String(normalized.region || '').trim()) {
        normalized = { ...normalized, region: oauthRegion };
      }
      normalizedList.push(normalized);
    }
  }

  let mysqlResult = {
    ok: false,
    imported: 0,
    updated: 0,
    imported_count: 0,
    updated_count: 0,
    skipped_count: 0,
    skipped: [],
    allowedShopIds: [],
    shops: [],
  };

  const { getMysqlPool } = require('../db/mysqlPool');
  const pool = getMysqlPool();
  if (pool && normalizedList.length > 0) {
    const { persistOAuthShopsToMysql } = require('../modules/shops/oauthMysqlPersist');
    const { isPlatformScopeUser } = require('../lib/userScope');
    let unlimitedShops = false;
    const userId = Number(opts.userId);
    if (Number.isFinite(userId) && userId > 0) {
      const [[urow]] = await pool.query('SELECT scope FROM users WHERE id = ? LIMIT 1', [userId]);
      unlimitedShops = isPlatformScopeUser({ scope: urow?.scope });
    }
    mysqlResult = await persistOAuthShopsToMysql(pool, tenantId, normalizedList, { unlimitedShops });
  }

  const allowedSet = new Set(
    (mysqlResult.allowedShopIds || []).map((id) => String(id || '').trim().toLowerCase()).filter(Boolean),
  );
  const savedList = [];
  for (const normalized of normalizedList) {
    const pid = String(normalized.shopId || '').trim().toLowerCase();
    if (!pid || !allowedSet.has(pid)) continue;
    const expIso = normalized.accessTokenExpiresAt;
    const expireTime =
      expIso && dayjs(expIso).isValid() ? Math.floor(dayjs(expIso).valueOf() / 1000) : null;
    savedList.push(
      upsertShop({
        ...normalized,
        authorizedAt,
        expireTime,
        tenantId,
      }),
    );
  }

  return {
    ok: mysqlResult.ok || savedList.length > 0,
    mysql: mysqlResult,
    imported_count: mysqlResult.imported_count,
    updated_count: mysqlResult.updated_count,
    skipped_count: mysqlResult.skipped_count,
    skipped: mysqlResult.skipped,
    authorizedShopsDebug:
      shopsResult?.debug || {
        message: 'Authorized shops debug missing.',
      },
    shops: savedList,
  };
}

module.exports = {
  getAuthUrl,
  buildPartnerAuthorizeUrl,
  normalizeOAuthRegion,
  consumeOAuthState,
  handleCallbackByCode,
  debugShopList,
  runAuthorizedShopsSignTest,
};

