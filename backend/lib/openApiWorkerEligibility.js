'use strict';

/**
 * OpenAPI 订单同步 worker 准入（与 readSyncShops / shopSyncRunner / shopSyncWorker 一致）
 * 禁止因 DB 中 scope 字段缺失而预判跳过；scope 问题须由订单 API 实测后标记 scope_error。
 */

function parseJsonField(v) {
  if (v == null) return {};
  if (typeof v === 'object') return v;
  try {
    return JSON.parse(String(v));
  } catch {
    return {};
  }
}

/**
 * 仅用于诊断展示：声明的 scope 是否含 seller.order.info（不作为 worker 跳过条件）
 */
function scopeIncludesOrderInfoDeclared(scopeJson, rawAuth) {
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

/**
 * @param {Record<string, unknown>} shop
 * @returns {string|null} worker 会跳过的原因；null 表示会尝试订单 API
 */
function computeWorkerWouldSkip(shop) {
  if (!shop) return 'shop_not_found';
  if (shop.sync_enabled === 0 || shop.sync_enabled === false) {
    return 'sync_enabled=0 — OpenAPI worker 不拉单';
  }
  const status = String(shop.status || '').toLowerCase();
  if (status && status !== 'active') return `status=${status}`;
  if (shop.hidden === 1 || shop.hidden === true) return 'shop_hidden';
  const cipher = String(shop.shop_cipher || shop.shopCipher || '').trim();
  if (!cipher) return 'missing_shop_cipher';
  const token = String(shop.access_token || shop.accessToken || '').trim();
  if (!token) return 'missing_access_token';
  const market = String(shop.market || shop.region || '').trim().toUpperCase();
  if (!market) return 'missing_market';
  return null;
}

/**
 * @param {unknown} errMsg
 * @param {number} [httpStatus]
 */
function isOrderApiScopeError(errMsg, httpStatus) {
  const s = String(errMsg || '').toLowerCase();
  const st = Number(httpStatus);
  if (st === 403 && (s.includes('scope') || s.includes('permission') || s.includes('forbidden'))) {
    return true;
  }
  return (
    s.includes('insufficient_scope') ||
    s.includes('scope_not_authorized') ||
    s.includes('seller.order.info') ||
    (s.includes('scope') &&
      (s.includes('permission') ||
        s.includes('denied') ||
        s.includes('missing') ||
        s.includes('invalid') ||
        s.includes('unauthorized'))) ||
    s.includes('permission denied') ||
    s.includes('no permission') ||
    (s.includes('access denied') && (s.includes('scope') || s.includes('permission'))) ||
    (s.includes('forbidden') && (s.includes('scope') || s.includes('permission')))
  );
}

/**
 * @param {unknown} errMsg
 * @param {number} [httpStatus]
 * @returns {{ kind: 'token'|'scope'|'sync', code: string }}
 */
function classifyOrderSyncApiFailure(errMsg, httpStatus) {
  const { isTokenError } = require('../sync/services/tokenErrorDetector');
  if (isTokenError(errMsg, httpStatus)) {
    return { kind: 'token', code: 'token_error' };
  }
  if (isOrderApiScopeError(errMsg, httpStatus)) {
    return { kind: 'scope', code: 'scope_error' };
  }
  return { kind: 'sync', code: 'sync_failed' };
}

module.exports = {
  scopeIncludesOrderInfoDeclared,
  computeWorkerWouldSkip,
  isOrderApiScopeError,
  classifyOrderSyncApiFailure,
};
