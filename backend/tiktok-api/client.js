const crypto = require('crypto');
const dayjs = require('dayjs');
const { getMysqlPool } = require('../db/mysqlPool');
const { readShops, writeShops } = require('./shops');
const { getOpenApiShopsSource } = require('../lib/readSyncShops');

const API_BASE = process.env.TIKTOK_API_BASE_URL || 'https://open-api.tiktokglobalshop.com';
const APP_KEY = process.env.TIKTOK_APP_KEY || '';
const APP_SECRET = process.env.TIKTOK_APP_SECRET || '';

function signOpenApiRequest(pathname, params, bodyForSign = '') {
  const signKeys = Object.keys(params)
    .filter((k) => k !== 'sign' && k !== 'access_token' && params[k] != null && params[k] !== '')
    .sort();
  let sortedKeyValueString = '';
  for (const k of signKeys) {
    sortedKeyValueString += `${k}${params[k]}`;
  }
  const signSource = `${pathname}${sortedKeyValueString}${bodyForSign}`;
  const wrapped = `${APP_SECRET}${signSource}${APP_SECRET}`;
  const generatedSign = crypto.createHmac('sha256', APP_SECRET).update(wrapped).digest('hex');
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
  const u = new URL('/api/token/refresh', API_BASE);
  const resp = await fetch(u.toString(), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      app_key: APP_KEY,
      app_secret: APP_SECRET,
      refresh_token: shop.refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  if (!resp.ok) throw new Error(`refresh_http_${resp.status}`);
  const payload = await resp.json();
  const data = payload?.data || payload;
  if (!data?.access_token) throw new Error('refresh_payload_invalid');

  if (getOpenApiShopsSource() === 'mysql' && shop.internal_shop_id) {
    const updated = await persistRefreshedTokenToMysql(shop, data);
    if (updated) return updated;
  }

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
  if (!isExpired(shop.accessTokenExpiresAt)) return shop;
  return refreshAccessToken(shop);
}

async function requestShopApi(shop, { method = 'GET', pathname, query = {}, body = null, includeDebug = false }) {
  try {
    const safeShop = await ensureShopToken(shop);
    const methodUpper = String(method).toUpperCase();
    const bodyForSign = body != null && methodUpper !== 'GET' ? JSON.stringify(body) : '';
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const params = {
      app_key: APP_KEY,
      timestamp,
      ...query,
    };
    const signMeta = signOpenApiRequest(pathname, params, bodyForSign);
    params.sign = signMeta.generatedSign;
    const u = new URL(pathname, API_BASE);
    for (const [k, v] of Object.entries(params)) {
      if (v == null || v === '') continue;
      u.searchParams.set(k, String(v));
    }
    const finalUrl = u.toString();
    const debugBase = {
      orderUrl: finalUrl,
      finalUrl,
      method: methodUpper,
      query: { ...params },
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
    return {
      ok: false,
      error: {
        type: 'network_error',
        message: String(e?.message || e),
      },
      debug: {
        orderUrl: '',
        finalUrl: '',
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
};

