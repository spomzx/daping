'use strict';

/**
 * TikTok 授权/刷新错误分类（健康扫描 + 同步共用）
 *
 * category:
 * - access_ok — 令牌有效或刷新已成功
 * - access_expired_refresh_ok — access 过期但 refresh 成功（调用方应已写回 DB）
 * - reauth_required — refresh_token 失效，需重新 OAuth
 * - app_config_error — app_key / app_secret / 签名 / callback 配置问题
 * - refresh_endpoint_error — refresh URL/路径错误（如 open-api 误用导致 404 Invalid path）
 * - auth_unknown — 其它授权类错误
 */

const APP_KEY = String(process.env.TIKTOK_APP_KEY || '').trim();
const APP_SECRET = String(process.env.TIKTOK_APP_SECRET || '').trim();
const REDIRECT_URI = String(process.env.TIKTOK_REDIRECT_URI || '').trim();

/**
 * @param {string} raw
 */
function norm(raw) {
  return String(raw || '')
    .trim()
    .toLowerCase();
}

/**
 * @param {string} [errMsg]
 * @param {{ httpStatus?: number, tiktokCode?: unknown, tiktokMessage?: string }} [meta]
 */
function classifyTikTokAuthError(errMsg, meta = {}) {
  const httpStatus = Number(meta.httpStatus) || 0;
  const tiktokCode = meta.tiktokCode;
  const tiktokMsg = String(meta.tiktokMessage || '').trim();
  const combined = [errMsg, tiktokMsg].filter(Boolean).join(' | ');
  const s = norm(combined);

  if (!APP_KEY || !APP_SECRET) {
    return {
      category: 'app_config_error',
      userLabel: '应用配置异常',
      detail: '缺少 TIKTOK_APP_KEY 或 TIKTOK_APP_SECRET',
      fullMessage: combined || 'missing_app_credentials_env',
    };
  }

  if (
    httpStatus === 404 ||
    String(tiktokCode) === '36009009' ||
    s.includes('invalid path') ||
    s.includes('does not match any available endpoint') ||
    s.includes('refresh_endpoint')
  ) {
    return {
      category: 'refresh_endpoint_error',
      userLabel: 'Token 刷新端点异常',
      detail: combined || 'invalid_refresh_endpoint',
      fullMessage: combined,
    };
  }

  if (
    s.includes('missing tiktok_app_key') ||
    s.includes('missing tiktok_redirect') ||
    s.includes('app_key') && s.includes('invalid') ||
    s.includes('app_secret') ||
    s.includes('sign invalid') ||
    s.includes('invalid sign') ||
    s.includes('signature') && s.includes('invalid') ||
    s.includes('redirect_uri') ||
    s.includes('redirect uri') ||
    s.includes('callback') && (s.includes('mismatch') || s.includes('invalid'))
  ) {
    return {
      category: 'app_config_error',
      userLabel: '应用配置异常',
      detail: combined || 'app_config',
      fullMessage: combined,
    };
  }

  if (
    s.includes('invalid refresh_token') ||
    s.includes('invalid refresh token') ||
    (s.includes('refresh') &&
      (s.includes('invalid credentials') ||
        s.includes('invalid credential') ||
        s.includes('invalid refresh'))) ||
    (s.includes('refresh_token') && (s.includes('invalid') || s.includes('revoked') || s.includes('expired'))) ||
    s.includes('authorization code') && s.includes('invalid') ||
    s.includes('reauth') ||
    ((httpStatus === 401 || httpStatus === 403) &&
      (s.includes('refresh_token') || (s.includes('refresh') && s.includes('credential'))))
  ) {
    return {
      category: 'reauth_required',
      userLabel: '需重新授权',
      detail: combined || 'invalid_credentials',
      fullMessage: combined,
    };
  }

  if (
    s.includes('refresh_http_401') ||
    s.includes('refresh_http_403') ||
    s.includes('token expired') ||
    s.includes('token_expired') ||
    s.includes('access_token') && s.includes('expired') ||
    s === 'expired'
  ) {
    return {
      category: 'reauth_required',
      userLabel: '需重新授权',
      detail: combined || 'token_expired',
      fullMessage: combined,
    };
  }

  if (s.includes('refresh_payload_invalid') || s.includes('refresh_http_')) {
    return {
      category: 'auth_unknown',
      userLabel: '授权异常',
      detail: combined || 'refresh_failed',
      fullMessage: combined,
    };
  }

  return {
    category: 'auth_unknown',
    userLabel: '授权异常',
    detail: combined || 'auth_error',
    fullMessage: combined,
  };
}

/**
 * 基础设施/读库失败 — 只能算同步异常，不能算授权异常
 * @param {string} errMsg
 */
function isInfrastructureSyncError(errMsg) {
  const s = norm(errMsg);
  if (!s) return false;
  return (
    s.includes('[read-sync-shops]') ||
    s.includes('mysql unavailable') ||
    s.includes('mysql_unavailable') ||
    s.includes('econnrefused') ||
    s.includes('econnreset') ||
    s.includes('enotfound') ||
    s.includes('getaddrinfo') ||
    s.includes('database_unavailable') ||
    s.includes('pool is closed')
  );
}

/**
 * 同步 last_error 是否应映射为 health auth_error（仅 token/OAuth/app 配置类）
 * @param {string} errMsg
 */
function mapSyncErrorToHealthAuth(errMsg) {
  if (isInfrastructureSyncError(errMsg)) return null;

  const c = classifyTikTokAuthError(errMsg);
  if (c.category === 'app_config_error' || c.category === 'refresh_endpoint_error') {
    const prefix = c.category === 'refresh_endpoint_error' ? 'Token 刷新端点异常' : '应用配置异常';
    return { health_status: 'auth_error', health_reason: `${prefix}：${c.detail}` };
  }
  if (c.category === 'reauth_required') {
    return { health_status: 'auth_error', health_reason: `需重新授权：${c.detail}` };
  }
  return null;
}

/**
 * @param {string} msg
 */
function isAuthLikeMessage(msg) {
  const s = norm(msg);
  if (!s) return false;
  return (
    s.includes('token') ||
    s.includes('auth') ||
    s.includes('credential') ||
    s.includes('unauthorized') ||
    s.includes('refresh') ||
    s.includes('invalid cr')
  );
}

module.exports = {
  classifyTikTokAuthError,
  mapSyncErrorToHealthAuth,
  isAuthLikeMessage,
  isInfrastructureSyncError,
  hasAppCredentials: () => Boolean(APP_KEY && APP_SECRET),
};
