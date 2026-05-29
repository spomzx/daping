'use strict';

const crypto = require('crypto');

const EXPECTED_CALLBACK_PATH = '/api/tiktok/auth/callback';

/** staging 跨境授权 host（prod 不触发，见 isStagingOAuthEnvironment） */
const STAGING_CROSS_BORDER_AUTHORIZE_HOST = 'seller.tiktokshopglobalselling.com';

/**
 * TikTok Shop Partner 授权 scope（逗号分隔，须与 Partner 后台已开通权限一致）
 * @see token 响应 granted_scopes 示例含 seller.authorization.info / seller.order.info / seller.shop.info 等
 */
const DEFAULT_TIKTOK_OAUTH_SCOPES = [
  'seller.authorization.info',
  'seller.order.info',
  'seller.shop.info',
].join(',');

function normalizeOAuthScopeList(scopeStr) {
  const parts = String(scopeStr || '')
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return [...new Set(parts)].join(',');
}

/**
 * 授权 URL scope：env 优先，否则默认三件套；TIKTOK_OAUTH_SCOPE_DISABLED=1 可显式关闭
 */
function getOAuthScopeSource() {
  if (String(process.env.TIKTOK_OAUTH_SCOPE_DISABLED || '').trim() === '1') return 'disabled';
  if (String(process.env.TIKTOK_OAUTH_SCOPE || '').trim()) return 'env';
  return 'default';
}

function resolveOAuthAuthorizeScope() {
  if (String(process.env.TIKTOK_OAUTH_SCOPE_DISABLED || '').trim() === '1') {
    return '';
  }
  const env = String(process.env.TIKTOK_OAUTH_SCOPE || '').trim();
  if (env) return normalizeOAuthScopeList(env);
  return DEFAULT_TIKTOK_OAUTH_SCOPES;
}

/**
 * 仅 staging：由 redirect_uri / DB_NAME / APP_ENV 判定，prod 不受影响
 */
function isStagingOAuthEnvironment() {
  const redirect = String(process.env.TIKTOK_REDIRECT_URI || '').toLowerCase();
  if (redirect.includes('stag.') || redirect.includes('staging')) return true;
  const db = String(process.env.DB_NAME || '').toLowerCase();
  if (db.includes('staging')) return true;
  const appEnv = String(process.env.APP_ENV || process.env.DAPING_ENV || process.env.NODE_ENV || '')
    .trim()
    .toLowerCase();
  return appEnv === 'staging';
}

/**
 * staging 跨境强制 globalselling host，避免与 routing 域名不一致导致空白页
 * @param {string} routedHost
 * @param {'local'|'cross_border'|string} sellerType
 */
function applyStagingAuthorizeHost(routedHost, sellerType) {
  if (!isStagingOAuthEnvironment()) {
    return { host: routedHost, source: 'routing' };
  }
  const st = String(sellerType || '')
    .trim()
    .toLowerCase()
    .replace(/-/g, '_');
  if (st === 'cross_border' || st === 'crossborder' || st === 'global' || st === 'cb') {
    return { host: STAGING_CROSS_BORDER_AUTHORIZE_HOST, source: 'staging_override' };
  }
  return { host: routedHost, source: 'routing' };
}

function parseScopeList(scopeStr) {
  return String(scopeStr || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * 规范化 redirect_uri（与 Partner 后台完全一致）
 * @param {string} raw
 */
function normalizeRedirectUri(raw) {
  const s = String(raw || '').trim();
  if (!s) return { ok: false, error: 'missing_redirect_uri', value: '' };
  let u;
  try {
    u = new URL(s);
  } catch {
    return { ok: false, error: 'invalid_redirect_uri', value: s };
  }
  if (u.protocol !== 'https:') {
    return { ok: false, error: 'redirect_uri_must_be_https', value: s };
  }
  if (u.username || u.password) {
    return { ok: false, error: 'redirect_uri_no_credentials', value: s };
  }
  u.hash = '';
  let path = u.pathname || '/';
  if (path.length > 1 && path.endsWith('/')) path = path.replace(/\/+$/, '');
  u.pathname = path;
  u.search = '';
  const value = u.toString();
  if (!value.includes(EXPECTED_CALLBACK_PATH)) {
    return { ok: false, error: 'redirect_uri_path_mismatch', value, expected_path: EXPECTED_CALLBACK_PATH };
  }
  return { ok: true, value, https: true };
}

function maskSecret(value, head = 4, tail = 4) {
  const s = String(value || '');
  if (!s) return '';
  if (s.length <= head + tail) return '***';
  return `${s.slice(0, head)}…${s.slice(-tail)}`;
}

function maskAuthorizeUrl(url) {
  try {
    const u = new URL(url);
    for (const key of ['app_key', 'service_id', 'state']) {
      if (u.searchParams.has(key)) {
        u.searchParams.set(key, maskSecret(u.searchParams.get(key), 6, 6));
      }
    }
    for (const key of ['redirect_uri', 'redirect_url']) {
      if (u.searchParams.has(key)) {
        const v = u.searchParams.get(key) || '';
        u.searchParams.set(key, v.replace(/:\/\/[^/]+/, '://***'));
      }
    }
    return u.toString();
  } catch {
    return String(url || '');
  }
}

/**
 * TikTok Shop OAuth authorize query（/api/v2/oauth/authorize）
 * @param {{ appId: string, appKey: string, redirectUri: string, state: string, market?: string|null, sellerType: string }}
 */
function buildTikTokAuthorizeQueryParams({ appId, appKey, redirectUri, state, market, sellerType }) {
  const params = new URLSearchParams();
  params.set('service_id', String(appId));
  params.set('app_key', String(appKey));
  params.set('response_type', 'code');
  const redirectParamName = String(process.env.TIKTOK_OAUTH_REDIRECT_QUERY_NAME || 'redirect_uri').trim() || 'redirect_uri';
  params.set(redirectParamName, redirectUri);
  if (redirectParamName !== 'redirect_url' && process.env.TIKTOK_OAUTH_INCLUDE_REDIRECT_URL === '1') {
    params.set('redirect_url', redirectUri);
  }
  params.set('state', state);
  const scope = resolveOAuthAuthorizeScope();
  if (scope) params.set('scope', scope);
  if (sellerType === 'local' && market) {
    params.set('region', String(market).toUpperCase());
  }
  return params;
}

function auditAuthorizeUrl(url, redirectUri) {
  const u = new URL(url);
  const sp = u.searchParams;
  const issues = [];
  const checks = {
    service_id_present: sp.has('service_id') && Boolean(String(sp.get('service_id') || '').trim()),
    app_key_present: sp.has('app_key') && Boolean(String(sp.get('app_key') || '').trim()),
    response_type_present: sp.has('response_type'),
    response_type_code: sp.get('response_type') === 'code',
    redirect_uri_present: sp.has('redirect_uri') || sp.has('redirect_url'),
    state_present: sp.has('state') && Boolean(String(sp.get('state') || '').trim()),
    redirect_uri_https: redirectUri.startsWith('https://'),
    redirect_uri_no_http: !/^http:\/\//i.test(redirectUri),
    has_region: sp.has('region'),
    has_scope: sp.has('scope'),
  };
  if (!checks.service_id_present) issues.push('missing_service_id');
  if (!checks.app_key_present) issues.push('missing_app_key');
  if (!checks.response_type_code) issues.push('missing_or_invalid_response_type');
  if (!checks.redirect_uri_present) issues.push('missing_redirect_uri_or_redirect_url');
  if (!checks.state_present) issues.push('missing_state');
  if (!checks.redirect_uri_https) issues.push('redirect_uri_not_https');
  if (!checks.has_scope && String(process.env.TIKTOK_OAUTH_SCOPE_DISABLED || '').trim() !== '1') {
    issues.push('missing_scope');
  }
  const envUri = String(process.env.TIKTOK_REDIRECT_URI || '').trim();
  const normEnv = normalizeRedirectUri(envUri);
  if (normEnv.ok && normEnv.value !== redirectUri) {
    issues.push('redirect_uri_differs_from_env');
  }
  if (/tiktokshopglobalselling/i.test(u.host) && !isStagingOAuthEnvironment()) {
    issues.push('forbidden_host_globalselling');
  }
  return { checks, issues };
}

/**
 * 生成可解析 state：{key}.{base64url(payload)}，Map 仍以 key 校验 CSRF
 */
function buildOAuthStateToken(ctx) {
  const nonce = crypto.randomBytes(8).toString('hex');
  const timestamp = Date.now();
  const payload = {
    v: 1,
    tenant_id: Number(ctx.tenantId),
    user_id: Number(ctx.userId),
    seller_type: ctx.sellerType,
    source: String(ctx.source || 'saas'),
    nonce,
    timestamp,
  };
  if (ctx.market) payload.market = ctx.market;
  const key = crypto.randomBytes(12).toString('hex');
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return { state: `${key}.${encoded}`, key, payload, nonce, timestamp };
}

function parseOAuthStateToken(stateRaw) {
  const raw = String(stateRaw || '').trim();
  if (!raw) return { key: '', payload: null };
  const dot = raw.indexOf('.');
  if (dot <= 0) return { key: raw, payload: null };
  const key = raw.slice(0, dot);
  const encoded = raw.slice(dot + 1);
  try {
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    return { key, payload };
  } catch {
    return { key: raw, payload: null };
  }
}

module.exports = {
  EXPECTED_CALLBACK_PATH,
  STAGING_CROSS_BORDER_AUTHORIZE_HOST,
  DEFAULT_TIKTOK_OAUTH_SCOPES,
  normalizeRedirectUri,
  normalizeOAuthScopeList,
  getOAuthScopeSource,
  resolveOAuthAuthorizeScope,
  isStagingOAuthEnvironment,
  applyStagingAuthorizeHost,
  parseScopeList,
  buildTikTokAuthorizeQueryParams,
  auditAuthorizeUrl,
  buildOAuthStateToken,
  parseOAuthStateToken,
  maskAuthorizeUrl,
  maskSecret,
};
