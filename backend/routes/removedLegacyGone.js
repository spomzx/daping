'use strict';

/**
 * P2-C：已移除的 legacy / cache 接口统一返回 410。
 */

function gone(_req, res) {
  res.status(410).json({
    ok: false,
    error: 'legacy_removed',
    message: '接口已下线（P2-C MySQL-only）；请使用 SaaS /api/*',
  });
}

const GONE_PREFIXES = [
  '/api/legacy-dashboard',
  '/api/import-cache',
  '/api/reconcile',
  '/api/cache',
  '/api/ops/import-cache',
  '/api/ops/reconcile',
  '/api/ops/rebuild-cache',
  '/api/ops/orders/reconcile',
  '/api/ops/orders/rebuild-cache',
  '/api/ops/orders/cache',
  '/api/shops/import-cache',
  '/api/orders/reconcile',
  '/api/orders/cache',
];

function isRemovedLegacyPath(pathname) {
  const p = String(pathname || '');
  return GONE_PREFIXES.some((prefix) => p === prefix || p.startsWith(`${prefix}/`));
}

function registerRemovedLegacyGone(app) {
  app.use((req, res, next) => {
    if (!isRemovedLegacyPath(req.path)) return next();
    return gone(req, res);
  });
  console.log('[routes] legacy/cache endpoints return 410 (P2-C removed)');
}

module.exports = { registerRemovedLegacyGone, gone };
