'use strict';

const { normalizePlanType } = require('./planService');

function parsePositiveInt(v, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

function parseListQuery(query = {}) {
  return {
    page: parsePositiveInt(query.page, 1),
    page_size: Math.min(100, parsePositiveInt(query.page_size || query.pageSize, 20)),
    keyword: String(query.keyword || query.q || '').trim(),
    plan_type: String(query.plan_type || query.planType || '').trim().toLowerCase(),
    is_active:
      query.is_active !== undefined && query.is_active !== ''
        ? query.is_active === true || query.is_active === 1 || query.is_active === '1'
          ? 1
          : 0
        : null,
    plan_status: String(query.plan_status || query.status || '').trim().toLowerCase(),
    include_system:
      query.include_system === true ||
      query.include_system === 1 ||
      query.include_system === '1' ||
      String(query.include_system || '').toLowerCase() === 'true',
  };
}

function validatePatchBody(body = {}) {
  const patch = {};
  const b = body || {};

  if (b.plan_type !== undefined) {
    patch.plan_type = normalizePlanType(b.plan_type);
  }
  if (b.shop_limit !== undefined) {
    const n = Number(b.shop_limit);
    if (!Number.isFinite(n) || n < 1) {
      return { ok: false, error: 'invalid_shop_limit' };
    }
    patch.shop_limit = Math.floor(n);
  }
  if (b.max_users !== undefined) {
    const n = Number(b.max_users);
    if (!Number.isFinite(n) || n < 1) {
      return { ok: false, error: 'invalid_max_users' };
    }
    patch.max_users = Math.floor(n);
  }
  if (Object.prototype.hasOwnProperty.call(b, 'expires_at')) {
    patch.expires_at = b.expires_at;
  }
  if (b.is_active !== undefined) {
    patch.is_active = b.is_active === true || b.is_active === 1 || b.is_active === '1' ? 1 : 0;
  }
  if (Object.prototype.hasOwnProperty.call(b, 'plan_remark')) {
    patch.plan_remark = b.plan_remark;
  }

  if (Object.keys(patch).length === 0) {
    return { ok: false, error: 'empty_patch' };
  }

  return { ok: true, patch };
}

module.exports = { parseListQuery, validatePatchBody, parsePositiveInt };
