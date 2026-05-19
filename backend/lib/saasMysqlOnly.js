'use strict';

/**
 * Phase 2-2：SaaS 主链路 MySQL Only（legacy cache/json/sqlite 不得参与 SaaS API）。
 * @see docs/audit/phase2-mysql-only.md
 */

const path = require('path');
const { getMysqlPool } = require('../db/mysqlPool');
const { isMysqlConfigured } = require('../config/database');

/** SaaS 主 API 前缀（不含 /api/ops、/api/auth、legacy war-room） */
const SAAS_API_PREFIXES = [
  '/api/dashboard',
  '/api/analytics',
  '/api/orders',
  '/api/shops',
  '/api/tenants',
  '/api/users',
];

const LEGACY_STORAGE_BASENAMES = new Set([
  'orders-cache.json',
  'gmv-cache.json',
  'shops.json',
  'dashboard.db',
]);

const SAAS_DATA_SOURCE_LABEL = 'mysql-only';

function isSaasApiPath(urlPath) {
  const p = String(urlPath || '').split('?')[0];
  return SAAS_API_PREFIXES.some((prefix) => p === prefix || p.startsWith(`${prefix}/`));
}

function isLegacyStorageBasename(filePath) {
  const base = path.basename(String(filePath || ''));
  return LEGACY_STORAGE_BASENAMES.has(base);
}

function logBlockedLegacyFallback(reason, detail) {
  console.error('[BLOCKED_LEGACY_FALLBACK]', reason, detail && typeof detail === 'object' ? detail : { detail });
}

/**
 * 仅 Ops 路由可经 req.allowLegacyCacheRead 读取 cache/json（写入 MySQL 的运维工具）。
 * @param {{ allowLegacyCacheRead?: boolean }} req
 */
function assertLegacyStorageReadAllowed(req, filePath, context) {
  if (req && req.allowLegacyCacheRead === true) return;
  if (!isLegacyStorageBasename(filePath)) return;
  logBlockedLegacyFallback(context || 'legacy_storage_read', {
    file: String(filePath || ''),
    path: req?.originalUrl || req?.path,
  });
  const err = new Error('legacy_storage_read_blocked');
  err.code = 'MYSQL_REQUIRED';
  throw err;
}

function requireSaasMysqlPool() {
  if (!isMysqlConfigured()) {
    const err = new Error('mysql_not_configured');
    err.code = 'MYSQL_REQUIRED';
    throw err;
  }
  const pool = getMysqlPool();
  if (!pool) {
    const err = new Error('mysql_unavailable');
    err.code = 'MYSQL_REQUIRED';
    throw err;
  }
  return pool;
}

function sendMysqlRequired(res, reason, extra) {
  const req = res.req;
  logBlockedLegacyFallback(reason, {
    method: req?.method,
    path: req?.originalUrl || req?.path,
    ...(extra && typeof extra === 'object' ? extra : {}),
  });
  return res.status(503).json({
    error: 'MYSQL_REQUIRED',
    message: 'SaaS API requires MySQL; legacy cache/json/sqlite fallback is blocked',
    reason: reason || 'mysql_unavailable',
    saasDataSource: SAAS_DATA_SOURCE_LABEL,
  });
}

/** Express：挂载在 SaaS 模块 router 之前 */
function saasMysqlOnlyMiddleware(req, res, next) {
  req.saasMysqlOnly = true;
  if (!isMysqlConfigured()) {
    return sendMysqlRequired(res, 'mysql_not_configured');
  }
  const pool = getMysqlPool();
  if (!pool) {
    return sendMysqlRequired(res, 'mysql_pool_unavailable');
  }
  return next();
}

/**
 * 阻断仍挂在 /api/shops|/api/orders 下的 legacy Ops 别名（须改用 /api/ops/*）。
 * @deprecated legacy only — not for SaaS
 */
function blockSaasLegacyOpsAlias(req, res) {
  return sendMysqlRequired(res, 'saas_legacy_ops_alias_blocked', {
    replacement: req.deprecatedOpsReplacement || '/api/ops',
    hint: 'Use /api/ops/* with platform admin credentials',
  });
}

function mapSaasMysqlError(res, e) {
  const code = e && e.code ? String(e.code) : '';
  if (code === 'MYSQL_REQUIRED' || code === 'mysql_unavailable' || code === 'mysql_not_configured') {
    return sendMysqlRequired(res, code === 'MYSQL_REQUIRED' ? String(e.message || code) : 'mysql_unavailable');
  }
  return null;
}

function saasHealthFlags() {
  return {
    saasDataSource: SAAS_DATA_SOURCE_LABEL,
    legacyFallbackBlocked: true,
  };
}

module.exports = {
  SAAS_API_PREFIXES,
  SAAS_DATA_SOURCE_LABEL,
  isSaasApiPath,
  isLegacyStorageBasename,
  logBlockedLegacyFallback,
  assertLegacyStorageReadAllowed,
  requireSaasMysqlPool,
  sendMysqlRequired,
  saasMysqlOnlyMiddleware,
  blockSaasLegacyOpsAlias,
  mapSaasMysqlError,
  saasHealthFlags,
};
