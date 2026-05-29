require('../loadEnv');

const crypto = require('crypto');
const dayjs = require('dayjs');
const { getMysqlPool } = require('../db/mysqlPool');
const { readShops, writeShops } = require('./shops');
const { getOpenApiShopsSource } = require('../lib/readSyncShops');

const API_BASE = process.env.TIKTOK_API_BASE_URL || 'https://open-api.tiktokglobalshop.com';

function appKey() {
  return String(process.env.TIKTOK_APP_KEY || '').trim();
}

function appSecret() {
  return String(process.env.TIKTOK_APP_SECRET || '').trim();
}

/**
 * 合并 OpenAPI query：业务参数 + 强制 app_key/timestamp（禁止空 app_key 覆盖）
 * @param {Record<string, unknown>} businessQuery
 */
function mergeOpenApiQueryParams(businessQuery = {}) {
  const key = appKey();
  if (!key) {
    const err = new Error('TIKTOK_APP_KEY missing');
    err.code = 'tiktok_app_key_missing';
    throw err;
  }
  const cleaned = { ...(businessQuery && typeof businessQuery === 'object' ? businessQuery : {}) };
  delete cleaned.app_key;
  delete cleaned.timestamp;
  delete cleaned.sign;
  delete cleaned.access_token;
  return {
    ...cleaned,
    app_key: key,
    timestamp: Math.floor(Date.now() / 1000).toString(),
  };
}

function buildUrlWithQuery(pathname, params) {
  const u = new URL(pathname, API_BASE);
  for (const [k, v] of Object.entries(params)) {
    if (v == null || v === '') continue;
    u.searchParams.set(k, String(v));
  }
  return u.toString();
}

/** 脱敏 URL / query 元信息（日志用） */
function buildOpenApiRequestMeta(pathname, params, finalUrl) {
  const queryKeys = Object.keys(params)
    .filter((k) => params[k] != null && params[k] !== '')
    .sort();
  const keyVal = String(params.app_key || '');
  let safeFinalUrl = finalUrl;
  try {
    const u = new URL(finalUrl);
    if (u.searchParams.has('app_key')) {
      u.searchParams.set('app_key', '[redacted]');
    }
    if (u.searchParams.has('sign')) {
      u.searchParams.set('sign', '[redacted]');
    }
    safeFinalUrl = u.toString();
  } catch {
    safeFinalUrl = String(pathname || '');
  }
  return {
    pathname,
    query_keys: queryKeys,
    has_app_key: queryKeys.includes('app_key'),
    app_key_length: keyVal.length,
    has_timestamp: queryKeys.includes('timestamp'),
    has_sign: queryKeys.includes('sign'),
    safeFinalUrl,
  };
}

function signOpenApiRequest(pathname, params, bodyForSign = '') {
  const signKeys = Object.keys(params)
    .filter((k) => k !== 'sign' && k !== 'access_token' && params[k] != null && params[k] !== '')
    .sort();
  let sortedKeyValueString = '';
  for (const k of signKeys) {
    sortedKeyValueString += `${k}${params[k]}`;
  }
  const signSource = `${pathname}${sortedKeyValueString}${bodyForSign}`;
  const secret = appSecret();
  const wrapped = `${secret}${signSource}${secret}`;
  const generatedSign = crypto.createHmac('sha256', secret).update(wrapped).digest('hex');
  return {
    generatedSign,
    pathForSign: pathname,
    signKeys,
    sortedQueryKeys: signKeys,
    sortedKeyValueString,
    signSource,
    bodyForSign,
  };
}

function isExpired(iso) {
  if (!iso) return true;
  return dayjs(iso).valueOf() <= Date.now() + 60_000;
}

async function persistRefreshedTokenToMysql(shop, data) {
  const internalId = Number(shop.internal_shop_id);
  const pool = getMysqlPool();
  if (!pool || !Number.isFinite(internalId) || internalId <= 0) return null;

  const accessExpire = dayjs(Date.now() + Number(data.access_token_expire_in || 0) * 1000).format(
    'YYYY-MM-DD HH:mm:ss.SSS',
  );
  const refreshExpire = dayjs(Date.now() + Number(data.refresh_token_expire_in || 0) * 1000).format(
    'YYYY-MM-DD HH:mm:ss.SSS',
  );

  const [rows] = await pool.query(
    'SELECT id, raw_auth_json FROM shop_auth_tokens WHERE shop_id = ? ORDER BY id DESC LIMIT 1',
    [internalId],
  );
  const row = Array.isArray(rows) && rows[0] ? rows[0] : null;
  if (!row) return null;

  let raw = {};
  try {
    raw = row.raw_auth_json ? JSON.parse(String(row.raw_auth_json)) : {};
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
      row.id,
    ],
  );
  return {
    ...shop,
    accessToken: data.access_token,
    refreshToken: data.refresh_token || shop.refreshToken,
    accessTokenExpiresAt: dayjs(accessExpire).toISOString(),
    refreshTokenExpiresAt: dayjs(refreshExpire).toISOString(),
  };
}

async function refreshAccessToken(shop) {
  const { refreshShopAccessToken } = require('../lib/tiktokTokenRefresh');
  const result = await refreshShopAccessToken(shop);
  if (!result.ok) {
    const err = new Error(result.fullMessage || 'refresh_failed');
    err.category = result.category;
    err.httpStatus = result.httpStatus;
    err.tiktokCode = result.tiktokCode;
    throw err;
  }
  const data = {
    access_token: result.shop?.accessToken,
    refresh_token: result.shop?.refreshToken,
    access_token_expire_in: result.shop?.accessTokenExpiresAt
      ? Math.max(0, Math.floor((new Date(result.shop.accessTokenExpiresAt).getTime() - Date.now()) / 1000))
      : 0,
    refresh_token_expire_in: result.shop?.refreshTokenExpiresAt
      ? Math.max(0, Math.floor((new Date(result.shop.refreshTokenExpiresAt).getTime() - Date.now()) / 1000))
      : 0,
  };
  if (!data.access_token) throw new Error(result.fullMessage || 'refresh_payload_invalid');
  if (result.shop) return result.shop;

  const shops = readShops();
  const idx = shops.findIndex((s) => String(s.shopId) === String(shop.shopId));
  if (idx >= 0) {
    shops[idx] = {
      ...shops[idx],
      accessToken: data.access_token,
      refreshToken: data.refresh_token || shops[idx].refreshToken,
      accessTokenExpiresAt: dayjs(Date.now() + Number(data.access_token_expire_in || 0) * 1000).toISOString(),
      refreshTokenExpiresAt: dayjs(Date.now() + Number(data.refresh_token_expire_in || 0) * 1000).toISOString(),
    };
    writeShops(shops);
    return shops[idx];
  }

  return {
    ...shop,
    accessToken: data.access_token,
    refreshToken: data.refresh_token || shop.refreshToken,
    accessTokenExpiresAt: dayjs(Date.now() + Number(data.access_token_expire_in || 0) * 1000).toISOString(),
    refreshTokenExpiresAt: dayjs(Date.now() + Number(data.refresh_token_expire_in || 0) * 1000).toISOString(),
  };
}

async function ensureShopToken(shop) {
  const { ensureShopAccessTokenFresh } = require('../lib/tiktokTokenRefresh');
  const { classifyTikTokAuthError } = require('../lib/shopAuthErrorClassifier');
  const fresh = await ensureShopAccessTokenFresh(shop);
  if (fresh.ok) return fresh.shop || shop;
  const c = classifyTikTokAuthError(fresh.fullMessage, {
    httpStatus: fresh.httpStatus,
    tiktokCode: fresh.tiktokCode,
    tiktokMessage: fresh.fullMessage,
  });
  const err = new Error(`${c.userLabel}: ${fresh.fullMessage || c.detail}`);
  err.category = c.category;
  throw err;
}

async function requestShopApi(shop, { method = 'GET', pathname, query = {}, body = null, includeDebug = false }) {
  try {
    const safeShop = await ensureShopToken(shop);
    const methodUpper = String(method).toUpperCase();
    const bodyForSign = body != null && methodUpper !== 'GET' ? JSON.stringify(body) : '';
    const params = mergeOpenApiQueryParams(query);
    const signMeta = signOpenApiRequest(pathname, params, bodyForSign);
    params.sign = signMeta.generatedSign;
    const finalUrl = buildUrlWithQuery(pathname, params);
    const requestMeta = buildOpenApiRequestMeta(pathname, params, finalUrl);
    const debugBase = {
      orderUrl: finalUrl,
      finalUrl,
      requestMeta,
      method: methodUpper,
      query: { ...params, app_key: '[redacted]', sign: params.sign ? '[redacted]' : '' },
      requestBody: body,
      requestBodyStringSent: bodyForSign,
      requestBodyWasSent: methodUpper !== 'GET' ? bodyForSign.length > 0 : false,
      hasXttsAccessTokenHeader: Boolean(safeShop?.accessToken),
      pathForSign: signMeta.pathForSign,
      signKeys: signMeta.signKeys,
      bodyForSign: signMeta.bodyForSign,
      generatedSign: signMeta.generatedSign,
    };
    const headers = {
      'content-type': 'application/json',
      'x-tts-access-token': String(safeShop?.accessToken || ''),
    };
    debugBase.headersSentToTikTok = { ...headers };
    debugBase.axiosConfigMethod = methodUpper;
    debugBase.axiosConfigHasData = methodUpper !== 'GET' ? bodyForSign.length > 0 : false;
    debugBase.axiosConfigDataType = methodUpper !== 'GET' ? 'string' : 'undefined';
    const resp = await fetch(finalUrl, {
      method: methodUpper,
      headers,
      body: methodUpper !== 'GET' ? bodyForSign : undefined,
    });
    const bodyText = await resp.text();
    let payload = {};
    try {
      payload = bodyText ? JSON.parse(bodyText) : {};
    } catch {
      payload = {};
    }
    const bizCodeRaw = payload?.code ?? payload?.error_code;
    const responseMessage = payload?.message || payload?.msg || payload?.error_msg || '';
    const bizOk = bizCodeRaw == null ? resp.ok : Number(bizCodeRaw) === 0;
    const responseMeta = {
      responseHttpStatus: resp.status,
      responseCode: bizCodeRaw ?? null,
      responseMessage,
      responseData: payload?.data ?? null,
      requestId: payload?.request_id || payload?.requestId || '',
      rawBody: bodyText,
    };
    if (!resp.ok || !bizOk) {
      return {
        ok: false,
        error: {
          type: 'api_error',
          httpStatus: resp.status,
          code: payload?.code ?? payload?.error_code,
          message: responseMessage || 'api_error',
        },
        debug: {
          ...debugBase,
          status: resp.status,
          body: bodyText,
          ...responseMeta,
        },
      };
    }
    return {
      ok: true,
      data: payload?.data ?? payload,
      ...(includeDebug
        ? {
            debug: {
              ...debugBase,
              status: resp.status,
              body: bodyText,
              ...responseMeta,
            },
          }
        : {}),
    };
  } catch (e) {
    const errCode = e && e.code ? String(e.code) : '';
    return {
      ok: false,
      error: {
        type: errCode === 'tiktok_app_key_missing' ? 'app_config_error' : 'network_error',
        message: String(e?.message || e),
      },
      debug: {
        orderUrl: '',
        finalUrl: '',
        requestMeta: {
          pathname,
          query_keys: [],
          has_app_key: Boolean(appKey()),
          app_key_length: appKey().length,
          has_timestamp: false,
          has_sign: false,
          safeFinalUrl: '',
          error: String(e?.message || e),
        },
        method: String(method).toUpperCase(),
        query: {},
        requestBody: body,
        requestBodyStringSent: body != null && String(method).toUpperCase() !== 'GET' ? JSON.stringify(body) : '',
        requestBodyWasSent: Boolean(body != null && String(method).toUpperCase() !== 'GET'),
        headersSentToTikTok: {
          'content-type': 'application/json',
          'x-tts-access-token': Boolean(shop?.accessToken) ? '[set]' : '',
        },
        axiosConfigMethod: String(method).toUpperCase(),
        axiosConfigHasData: Boolean(body != null && String(method).toUpperCase() !== 'GET'),
        axiosConfigDataType: body != null && String(method).toUpperCase() !== 'GET' ? 'string' : 'undefined',
        hasXttsAccessTokenHeader: Boolean(shop?.accessToken),
        pathForSign: pathname,
        signKeys: [],
        bodyForSign: body != null && String(method).toUpperCase() !== 'GET' ? JSON.stringify(body) : '',
        generatedSign: '',
        status: 0,
        body: String(e?.message || e),
      },
    };
  }
}

module.exports = {
  requestShopApi,
  signOpenApiRequest,
  mergeOpenApiQueryParams,
  buildUrlWithQuery,
  buildOpenApiRequestMeta,
};

