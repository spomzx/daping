require('../loadEnv');

const dayjs = require('dayjs');
const { upsertShop } = require('./shops');
const { signOpenApiRequest } = require('./client');

const {
  normalizeMarket,
  normalizeSellerType,
  resolveAuthorizeEndpoint,
  scopeIncludesOrderInfo,
} = require('./authRouting');
const {
  normalizeRedirectUri,
  buildTikTokAuthorizeQueryParams,
  auditAuthorizeUrl,
  buildOAuthStateToken,
  parseOAuthStateToken,
  maskAuthorizeUrl,
  parseScopeList,
  getOAuthScopeSource,
  applyStagingAuthorizeHost,
  isStagingOAuthEnvironment,
} = require('../lib/tiktokOAuthUrl');
const { OAUTH_TOKEN_GET_URL } = require('./oauthUrls');
const OAUTH_TOKEN_URL = OAUTH_TOKEN_GET_URL;
const API_BASE = process.env.TIKTOK_API_BASE_URL || 'https://open-api.tiktokglobalshop.com';

const OAUTH_STATE_TTL_MS = 15 * 60 * 1000;
/** @type {Map<string, { region: string, market: string, sellerType: string, source: string, tenantId: number, userId: number, nonce: string, timestamp: number, expiresAt: number }>} */
const oauthPendingByState = new Map();

function pruneOAuthStates() {
  const now = Date.now();
  for (const [k, v] of oauthPendingByState.entries()) {
    if (v.expiresAt <= now) oauthPendingByState.delete(k);
  }
}

/**
 * @param {{ region?: string, market?: string, sellerType: string, source?: string, tenantId: number, userId: number }} ctx
 */
function registerOAuthState(ctx) {
  pruneOAuthStates();
  const tenantId = Number(ctx?.tenantId);
  const userId = Number(ctx?.userId);
  if (!Number.isFinite(tenantId) || tenantId <= 0 || !Number.isFinite(userId) || userId <= 0) {
    throw new Error('oauth_missing_tenant');
  }
  const sellerType = normalizeSellerType(ctx.sellerType);
  if (!sellerType) throw new Error('invalid_seller_type');
  const market = normalizeMarket(ctx.market || ctx.region);
  if (sellerType === 'local' && !market) throw new Error('missing_market');
  const source = String(ctx.source || 'saas').trim() || 'saas';
  const { state, key, payload, nonce, timestamp } = buildOAuthStateToken({
    tenantId,
    userId,
    sellerType,
    source,
    market: market || null,
  });
  oauthPendingByState.set(key, {
    region: market || '',
    market: market || '',
    sellerType,
    source,
    tenantId,
    userId,
    nonce,
    timestamp,
    expiresAt: Date.now() + OAUTH_STATE_TTL_MS,
    state_payload: payload,
  });
  return state;
}

function consumeOAuthState(state) {
  pruneOAuthStates();
  const parsed = parseOAuthStateToken(state);
  const key = parsed.key || String(state || '').trim();
  const row = oauthPendingByState.get(key);
  if (!row || row.expiresAt < Date.now()) {
    if (row) oauthPendingByState.delete(key);
    return null;
  }
  oauthPendingByState.delete(key);
  return {
    region: row.region,
    market: row.market || row.region,
    sellerType: row.sellerType,
    source: row.source,
    tenantId: row.tenantId,
    userId: row.userId,
    nonce: row.nonce,
    timestamp: row.timestamp,
    state_payload: parsed.payload || row.state_payload || null,
  };
}

function normalizeOAuthRegion(value) {
  return normalizeMarket(value);
}

function logAuthRouting(event, payload) {
  console.log(`[tiktok-auth-routing] ${event}`, payload);
}

const DEFAULT_SERVICE_AUTHORIZE_URL =
  'https://services.tiktokshop.com/open/authorize?service_id=7643664278885811989';

function logTiktokAuth(meta) {
  console.log('[tiktok-auth]', meta);
}

function resolveServiceAuthorizeBaseUrl() {
  const raw = String(process.env.TIKTOK_SERVICE_AUTHORIZE_URL || '').trim();
  if (raw) return raw;
  const appId = String(process.env.TIKTOK_APP_ID || '').trim();
  if (appId) return `https://services.tiktokshop.com/open/authorize?service_id=${encodeURIComponent(appId)}`;
  return DEFAULT_SERVICE_AUTHORIZE_URL;
}

/**
 * staging：TikTok Partner「复制授权链接」官方入口（不拼 v2 seller host / scope / redirect_uri）
 * 仅附加 state，供既有 callback 绑定 tenant（不改 callback 落库逻辑）
 */
function buildServiceOpenAuthorizeUrl(authContext) {
  const tenantId = Number(authContext?.tenant_id);
  const userId = Number(authContext?.user_id);
  if (!Number.isFinite(tenantId) || tenantId <= 0 || !Number.isFinite(userId) || userId <= 0) {
    throw new Error('oauth_missing_tenant');
  }
  const base = resolveServiceAuthorizeBaseUrl();
  const u = new URL(base);
  const state = registerOAuthState({
    region: '',
    market: '',
    sellerType: 'cross_border',
    source: 'service_open_authorize',
    tenantId,
    userId,
  });
  u.searchParams.set('state', state);
  const serviceId = String(u.searchParams.get('service_id') || '').trim();
  logTiktokAuth({
    authorize_mode: 'service_open_authorize',
    final_host: u.hostname,
    service_id_present: Boolean(serviceId),
    tenant_id: tenantId,
    user_id: userId,
  });
  return u.toString();
}

function getServiceAuthorizeResponse(authContext) {
  const authorize_url = buildServiceOpenAuthorizeUrl(authContext);
  return { success: true, authorize_url };
}

function edgeSlice(value, n) {
  const v = String(value || '');
  if (!v) return { prefix: '', suffix: '' };
  if (v.length <= n * 2) return { prefix: v, suffix: v };
  return { prefix: v.slice(0, n), suffix: v.slice(-n) };
}

/**
 * @deprecated staging 已改用 service_open_authorize；prod 仍可用
 * 构建 TikTok 授权跳转 URL（本土 host vs 跨境 host）
 */
function buildPartnerAuthorizeUrl(authContext, opts = {}) {
  if (isStagingOAuthEnvironment()) {
    const err = new Error('oauth_v2_authorize_deprecated_on_staging');
    err.code = 'oauth_v2_deprecated_on_staging';
    throw err;
  }
  const requestedSellerType = String(
    opts.requestedSellerType ?? opts.sellerType ?? authContext?.seller_type ?? authContext?.sellerType ?? '',
  ).trim();
  const sellerType = normalizeSellerType(opts.sellerType || requestedSellerType);
  if (!sellerType) {
    const err = new Error('missing_seller_type');
    err.code = 'missing_seller_type';
    throw err;
  }

  const rawMarket = opts.market ?? opts.region ?? null;
  let m = null;
  if (sellerType === 'local') {
    m = normalizeOAuthRegion(rawMarket);
    if (!m) {
      const err = new Error('missing_market');
      err.code = 'missing_market';
      throw err;
    }
  }

  const tenantId = Number(authContext?.tenant_id);
  const userId = Number(authContext?.user_id);
  if (!Number.isFinite(tenantId) || tenantId <= 0 || !Number.isFinite(userId) || userId <= 0) {
    throw new Error('oauth_missing_tenant');
  }
  const appKey = String(process.env.TIKTOK_APP_KEY || '').trim();
  const appId = String(process.env.TIKTOK_APP_ID || '').trim();
  const redirectNorm = normalizeRedirectUri(process.env.TIKTOK_REDIRECT_URI);
  if (!appKey) throw new Error('Missing TIKTOK_APP_KEY');
  if (!appId) throw new Error('Missing TIKTOK_APP_ID');
  if (!redirectNorm.ok) {
    const err = new Error(redirectNorm.error || 'invalid_redirect_uri');
    err.code = redirectNorm.error;
    throw err;
  }
  const redirectUri = redirectNorm.value;
  const endpoint = resolveAuthorizeEndpoint(sellerType, m);
  const routed_authorize_host = endpoint.authorize_host;
  const { host: authorize_host, source: authorize_host_source } = applyStagingAuthorizeHost(
    routed_authorize_host,
    sellerType,
  );
  const authorize_path = endpoint.authorize_path;
  const state = registerOAuthState({
    region: m || '',
    market: m || '',
    sellerType,
    source: opts.source || authContext?.source || 'saas',
    tenantId,
    userId,
  });
  const query = buildTikTokAuthorizeQueryParams({
    appId,
    appKey,
    redirectUri,
    state,
    market: m,
    sellerType,
  });
  const u = new URL(authorize_path, `https://${authorize_host}`);
  for (const [k, v] of query.entries()) {
    u.searchParams.set(k, v);
  }
  const final_authorize_url = u.toString();
  const finalHost = new URL(final_authorize_url).host;
  const audit = auditAuthorizeUrl(final_authorize_url, redirectUri);
  const stateRow = oauthPendingByState.get(parseOAuthStateToken(state).key);
  const state_payload = stateRow?.state_payload || parseOAuthStateToken(state).payload;
  logAuthRouting('authorize_url_built', {
    seller_type: sellerType,
    market: m,
    staging_oauth: isStagingOAuthEnvironment(),
    routed_authorize_host,
    authorize_host,
    authorize_host_source,
    authorize_path,
    service_id_present: audit.checks.service_id_present,
    app_key_present: audit.checks.app_key_present,
    response_type: query.get('response_type') || null,
    redirect_uri: redirectUri,
    redirect_uri_https: audit.checks.redirect_uri_https,
    redirect_query_param: process.env.TIKTOK_OAUTH_REDIRECT_QUERY_NAME || 'redirect_uri',
    state_present: audit.checks.state_present,
    state_payload,
    scope_present: audit.checks.has_scope,
    oauth_scope: query.get('scope') || null,
    oauth_scope_count: parseScopeList(query.get('scope') || '').length,
    oauth_scope_source: getOAuthScopeSource(),
    region_in_query: audit.checks.has_region,
    final_authorize_url_masked: maskAuthorizeUrl(final_authorize_url),
    final_host: finalHost,
    tenant_id: tenantId,
    source: opts.source || authContext?.source || 'saas',
    param_audit_issues: audit.issues,
  });
  if (audit.issues.length > 0) {
    logAuthRouting('authorize_url_param_warnings', {
      seller_type: sellerType,
      issues: audit.issues,
      diagnosis_hint: diagnoseAuthorizeIssues(audit.issues, sellerType),
    });
  }
  return final_authorize_url;
}

function diagnoseAuthorizeIssues(issues, sellerType) {
  const hints = [];
  if (issues.includes('redirect_uri_differs_from_env')) {
    hints.push('callback 与 TIKTOK_REDIRECT_URI 不一致，请在 Partner 后台改为完全相同 HTTPS 地址');
  }
  if (issues.includes('redirect_uri_path_mismatch')) {
    hints.push('redirect_uri 路径必须为 /api/tiktok/auth/callback');
  }
  if (issues.includes('missing_or_invalid_response_type')) {
    hints.push('缺少 response_type=code，TikTok 可能不会进入授权确认页');
  }
  if (issues.includes('missing_scope')) {
    hints.push(
      '缺少 scope 参数；TikTok Shop 授权页通常要求逗号分隔 scope（如 seller.order.info,seller.shop.info），请在 .env 配置 TIKTOK_OAUTH_SCOPE 或使用代码默认值',
    );
  }
  if (issues.includes('missing_service_id') || issues.includes('missing_app_key')) {
    hints.push('service_id/app_key 未配置或与 Partner 应用不一致');
  }
  if (issues.includes('forbidden_host_globalselling')) {
    hints.push(
      '授权 URL host 含 globalselling；staging 应使用 seller.tiktokshopglobalselling.com，prod 跨境应为 seller.tiktokglobalshop.com',
    );
  }
  if (issues.length === 0) {
    hints.push(
      sellerType === 'cross_border'
        ? '参数完整；若仍只进 Seller Center 首页，多为 Partner 应用未开通跨境授权、卖家账号类型与 app 不匹配，或需在 Partner 复制官方授权链接对比 service_id'
        : '参数完整；若仍无授权确认页，请核对本土 app/market 与 service_id 是否匹配',
    );
  }
  return hints;
}

/**
 * @param {string} [region]
 * @param {{ tenant_id: number, user_id: number, seller_type?: string }} [authContext]
 * @param {{ sellerType?: string, source?: string }} [opts]
 */
function getAuthUrl(region, authContext, opts = {}) {
  if (!authContext?.tenant_id) {
    throw new Error('oauth_missing_tenant');
  }
  const requestedSellerType = String(
    opts.requestedSellerType ?? opts.sellerType ?? authContext?.seller_type ?? '',
  ).trim();
  const seller_type = normalizeSellerType(opts.sellerType || requestedSellerType);
  if (!seller_type) {
    const err = new Error('missing_seller_type');
    err.code = 'missing_seller_type';
    throw err;
  }
  const market =
    seller_type === 'local'
      ? normalizeOAuthRegion(region || opts.market)
      : normalizeOAuthRegion(region || opts.market) || null;
  if (seller_type === 'local' && !market) {
    const err = new Error('missing_market');
    err.code = 'missing_market';
    throw err;
  }
  const final_authorize_url = buildPartnerAuthorizeUrl(authContext, {
    ...opts,
    sellerType: seller_type,
    requestedSellerType,
    market,
    region: market,
  });
  const endpoint = resolveAuthorizeEndpoint(seller_type, market);
  const { host: authorize_host } = applyStagingAuthorizeHost(endpoint.authorize_host, seller_type);
  return {
    url: final_authorize_url,
    market: endpoint.market,
    seller_type,
    authorize_host,
    authorize_path: endpoint.authorize_path,
    final_authorize_url,
  };
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
  console.log('[tiktok-auth-routing] token_exchange_request', {
    tokenUrl: tokenUrlStr,
    app_key: appKey,
    has_auth_code: Boolean(code),
  });
  const resp = await fetch(tokenUrlStr, { method: 'GET' });
  const status = resp.status;
  const bodyText = await resp.text();
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
  console.log('[tiktok-auth-routing] token_exchange_response', {
    status,
    has_access: Boolean(access),
    has_refresh: Boolean(refresh),
  });
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
 * @param {{ oauthRegion?: string, oauthMarket?: string, sellerType?: string, source?: string, tenantId?: number, userId?: number }} [opts]
 */
async function handleCallbackByCode(code, opts = {}) {
  const tenantId = Number(opts.tenantId);
  if (!Number.isFinite(tenantId) || tenantId <= 0) {
    const err = new Error('oauth_missing_tenant');
    err.code = 'oauth_missing_tenant';
    throw err;
  }

  const oauthMarket = normalizeOAuthRegion(opts.oauthMarket || opts.oauthRegion) || '';
  const oauthSellerType = normalizeSellerType(opts.sellerType) || null;
  const tokenData = await exchangeCodeForToken(code);
  const savedScopes = tokenData.scope || tokenData.granted_scopes || '';
  const hasOrderScope = scopeIncludesOrderInfo(savedScopes);
  logAuthRouting('token_exchange_scopes', {
    tenant_id: tenantId,
    market: oauthMarket,
    seller_type: oauthSellerType,
    has_order_info_scope: hasOrderScope,
    scopes: savedScopes,
  });
  if (!hasOrderScope) {
    console.warn('[tiktok-auth-routing] missing_seller.order.info_scope in token response — re-authorize with correct seller portal');
  }
  const shopsResult = await fetchAuthorizedShops(tokenData.access_token);
  const shopsRaw = Array.isArray(shopsResult?.list) ? shopsResult.list : [];
  const normalizedList = [];
  const authorizedAt = dayjs().toISOString();
  if (Array.isArray(shopsRaw) && shopsRaw.length > 0) {
    for (const raw of shopsRaw) {
      let normalized = normalizeAuthorizedShop(raw, tokenData);
      if (!normalized.shopId || !normalized.shopCipher) continue;
      if (oauthMarket && !String(normalized.region || '').trim()) {
        normalized = { ...normalized, region: oauthMarket };
      }
      if (oauthSellerType) {
        normalized = { ...normalized, sellerType: oauthSellerType };
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
  if (!pool) {
    const err = new Error('mysql_unavailable');
    err.code = 'mysql_unavailable';
    throw err;
  }
  if (normalizedList.length === 0) {
    const err = new Error('authorized_shops_empty');
    err.code = 'authorized_shops_empty';
    throw err;
  }

  const { persistOAuthShopsToMysql } = require('../modules/shops/oauthMysqlPersist');
  const { isPlatformScopeUser } = require('../lib/userScope');
  let unlimitedShops = false;
  const userId = Number(opts.userId);
  if (Number.isFinite(userId) && userId > 0) {
    const [[urow]] = await pool.query('SELECT scope FROM users WHERE id = ? LIMIT 1', [userId]);
    unlimitedShops = isPlatformScopeUser({ scope: urow?.scope });
  }
  mysqlResult = await persistOAuthShopsToMysql(pool, tenantId, normalizedList, { unlimitedShops });

  if (!mysqlResult.ok) {
    const err = new Error('mysql_oauth_persist_failed');
    err.code = 'mysql_oauth_persist_failed';
    err.mysql = mysqlResult;
    throw err;
  }

  const writeShopsJson = String(process.env.TIKTOK_OAUTH_WRITE_SHOPS_JSON || '0').trim() === '1';
  const allowedSet = new Set(
    (mysqlResult.allowedShopIds || []).map((id) => String(id || '').trim().toLowerCase()).filter(Boolean),
  );
  const savedList = [];
  if (writeShopsJson) {
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
  }

  for (const s of mysqlResult.shops || []) {
    logAuthRouting('oauth_shop_persisted', {
      tenant_id: tenantId,
      shop_id: s.id,
      platform_shop_id: s.platform_shop_id,
      market: oauthMarket,
      seller_type: oauthSellerType,
      has_order_info_scope: hasOrderScope,
    });
  }

  return {
    ok: mysqlResult.ok,
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
  getServiceAuthorizeResponse,
  buildServiceOpenAuthorizeUrl,
  normalizeOAuthRegion,
  normalizeSellerType,
  consumeOAuthState,
  handleCallbackByCode,
  debugShopList,
  runAuthorizedShopsSignTest,
  fetchAuthorizedShops,
  normalizeAuthorizedShop,
  logAuthRouting,
  logTiktokAuth,
};

