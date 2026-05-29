'use strict';

/**
 * TikTok Shop OAuth 授权入口：本土店 vs 跨境店分别配置 host + path
 *
 * 探测结论（HEAD）：
 * - seller-{market}.tiktok.com/open/authorize → 404
 * - seller-{market}.tiktok.com/api/v2/oauth/authorize → 200
 * - seller.tiktokglobalshop.com/open/authorize → 404
 * - seller.tiktokglobalshop.com/api/v2/oauth/authorize → 200
 */

const ALLOWED_MARKETS = new Set(['TH', 'MY', 'SG', 'PH', 'VN']);

const LOCAL_SELLER_HOST_BY_MARKET = {
  TH: 'seller-th.tiktok.com',
  MY: 'seller-my.tiktok.com',
  PH: 'seller-ph.tiktok.com',
  VN: 'seller-vn.tiktok.com',
  SG: 'seller-sg.tiktok.com',
};

/** 跨境授权 host（禁止 tiktokshopglobalselling 等错误域名） */
const CROSS_BORDER_SELLER_HOST = 'seller.tiktokglobalshop.com';

const FORBIDDEN_CROSS_BORDER_HOST_PATTERNS = [
  /tiktokshopglobalselling/i,
  /globalselling\.com/i,
];

/** 本土店默认 path（勿用跨境 /open/authorize） */
const DEFAULT_LOCAL_AUTH_PATH = '/api/v2/oauth/authorize';

/** 跨境店默认 path */
const DEFAULT_CROSS_BORDER_AUTH_PATH = '/api/v2/oauth/authorize';

function normalizePath(path) {
  const p = String(path || '').trim();
  if (!p) return '/';
  return p.startsWith('/') ? p : `/${p}`;
}

function stripHost(value) {
  return String(value || '')
    .trim()
    .replace(/^https?:\/\//i, '')
    .split('/')[0]
    .toLowerCase();
}

/**
 * 跨境 host 仅允许 seller.tiktokglobalshop.com（env 误配 globalselling 时强制纠正）
 */
function resolveCrossBorderAuthorizeHost() {
  const override = stripHost(process.env.TIKTOK_CROSS_BORDER_AUTH_AUTHORIZE_HOST);
  if (!override) return CROSS_BORDER_SELLER_HOST;
  if (FORBIDDEN_CROSS_BORDER_HOST_PATTERNS.some((re) => re.test(override))) {
    console.warn(
      '[tiktok-auth-routing] TIKTOK_CROSS_BORDER_AUTH_AUTHORIZE_HOST ignored (forbidden):',
      override,
      '→',
      CROSS_BORDER_SELLER_HOST,
    );
    return CROSS_BORDER_SELLER_HOST;
  }
  if (override !== CROSS_BORDER_SELLER_HOST) {
    console.warn(
      '[tiktok-auth-routing] TIKTOK_CROSS_BORDER_AUTH_AUTHORIZE_HOST ignored (not allowed):',
      override,
      '→',
      CROSS_BORDER_SELLER_HOST,
    );
    return CROSS_BORDER_SELLER_HOST;
  }
  return CROSS_BORDER_SELLER_HOST;
}

function normalizeMarket(value) {
  const m = String(value || '').trim().toUpperCase();
  if (!m) return null;
  return ALLOWED_MARKETS.has(m) ? m : null;
}

/**
 * @param {string} value - local | cross_border | global | cb
 * @returns {'local'|'cross_border'|null}
 */
function normalizeSellerType(value) {
  const s = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/-/g, '_');
  if (!s) return null;
  if (s === 'local' || s === 'domestic' || s === '本土' || s === '本土店') return 'local';
  if (s === 'cross_border' || s === 'crossborder' || s === 'global' || s === 'cb' || s === '跨境' || s === '跨境店') {
    return 'cross_border';
  }
  return null;
}

/**
 * @param {'local'|'cross_border'} sellerType
 * @param {string} market
 */
function resolveAuthorizeHost(sellerType, market) {
  const st = normalizeSellerType(sellerType);
  if (!st) throw new Error('invalid_seller_type');
  if (st === 'cross_border') {
    return resolveCrossBorderAuthorizeHost();
  }
  const m = normalizeMarket(market);
  if (!m) throw new Error('invalid_oauth_market');
  const localOverride = stripHost(process.env.TIKTOK_LOCAL_AUTH_AUTHORIZE_HOST);
  if (localOverride) {
    const expected = LOCAL_SELLER_HOST_BY_MARKET[m];
    if (localOverride !== expected) {
      console.warn(
        '[tiktok-auth-routing] TIKTOK_LOCAL_AUTH_AUTHORIZE_HOST ignored for market',
        m,
        ':',
        localOverride,
        '→',
        expected,
      );
    }
  }
  const host = LOCAL_SELLER_HOST_BY_MARKET[m];
  if (!host) throw new Error('invalid_oauth_market');
  return host;
}

/**
 * @param {'local'|'cross_border'} sellerType
 */
function resolveAuthorizePath(sellerType) {
  const st = normalizeSellerType(sellerType);
  if (!st) throw new Error('invalid_seller_type');
  if (st === 'cross_border') {
    const p = String(
      process.env.TIKTOK_CROSS_BORDER_AUTH_AUTHORIZE_PATH || DEFAULT_CROSS_BORDER_AUTH_PATH,
    ).trim();
    return normalizePath(p);
  }
  const p = String(process.env.TIKTOK_LOCAL_AUTH_AUTHORIZE_PATH || DEFAULT_LOCAL_AUTH_PATH).trim();
  return normalizePath(p);
}

/**
 * @param {{ sellerType: string, market: string }}
 * @returns {{ authorize_host: string, authorize_path: string }}
 */
/**
 * @param {{ sellerType: string, market?: string|null }} opts
 */
function resolveAuthorizeEndpoint(sellerType, market) {
  const st = normalizeSellerType(sellerType);
  if (!st) throw new Error('invalid_seller_type');
  if (st === 'local') {
    const m = normalizeMarket(market);
    if (!m) throw new Error('missing_market');
    return {
      authorize_host: resolveAuthorizeHost(st, m),
      authorize_path: resolveAuthorizePath(st),
      seller_type: st,
      market: m,
    };
  }
  return {
    authorize_host: resolveAuthorizeHost(st, null),
    authorize_path: resolveAuthorizePath(st),
    seller_type: st,
    market: null,
  };
}

function scopeIncludesOrderInfo(scopeValue) {
  const parts = [];
  const push = (v) => {
    if (v == null) return;
    if (Array.isArray(v)) parts.push(...v);
    else parts.push(...String(v).split(/[,\s]+/));
  };
  push(scopeValue);
  return parts.some((s) => String(s).trim() === 'seller.order.info' || String(s).includes('seller.order.info'));
}

module.exports = {
  ALLOWED_MARKETS,
  LOCAL_SELLER_HOST_BY_MARKET,
  CROSS_BORDER_SELLER_HOST,
  DEFAULT_LOCAL_AUTH_PATH,
  DEFAULT_CROSS_BORDER_AUTH_PATH,
  normalizeMarket,
  normalizeSellerType,
  normalizePath,
  resolveAuthorizeHost,
  resolveAuthorizePath,
  resolveAuthorizeEndpoint,
  scopeIncludesOrderInfo,
};
