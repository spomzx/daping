'use strict';

/**
 * 业务 API 挂载（SaaS + Ops），与 server.js 启动解耦。
 * 模块路径必须相对本文件解析（routes/ → ../modules/），勿用 ./modules/。
 */

const path = require('path');
const { saasMysqlOnlyMiddleware } = require('../middlewares/saasMysqlOnly');

const ROUTES_DIR = __dirname;

/** @param {string} moduleName */
function resolveModuleRoutes(moduleName) {
  return path.join(ROUTES_DIR, '..', 'modules', moduleName, 'routes.js');
}

/** Phase 2-2：SaaS 主链路强制 MySQL Only */
const SAAS_MYSQL_ONLY_ROUTES = [
  ['tenants', '/api/tenants', 'tenants'],
  ['users', '/api/users', 'users'],
  ['shops', '/api/shops', 'shops'],
  ['orders', '/api/orders', 'orders'],
  ['dashboard-saas', '/api/dashboard', 'dashboard'],
  ['analytics', '/api/analytics', 'analytics'],
  ['sync', '/api/sync', 'sync'],
];

const BUSINESS_ROUTES = [
  ['authorizations', '/api/authorizations', 'authorizations'],
  ['settings', '/api/settings', 'settings'],
  ['operation-logs', '/api/operation-logs', 'operation-logs'],
  ['logs', '/api/logs', 'logs'],
  ['billing', '/api/billing', 'billing'],
  ['queue', '/api/queue', 'queue'],
  ['notifications', '/api/notifications', 'notifications'],
  ['ops', '/api/ops', 'ops'],
];

function loadRouter(absModulePath) {
  const mod = require(absModulePath);
  const router = mod.router || mod;
  if (!router) {
    throw new Error(`module has no router export: ${absModulePath}`);
  }
  return router;
}

function mountSaasMysqlOnlyRouter(app, label, mountPath, moduleName) {
  const absPath = resolveModuleRoutes(moduleName);
  const router = loadRouter(absPath);
  app.use(mountPath, saasMysqlOnlyMiddleware, router);
  console.log(`[routes] ${mountPath} mounted (${label}, saas-mysql-only)`);
}

function mountBusinessRouter(app, label, mountPath, moduleName) {
  const absPath = resolveModuleRoutes(moduleName);
  const router = loadRouter(absPath);
  app.use(mountPath, router);
  console.log(`[routes] ${mountPath} mounted (${label})`);
}

function registerApiRoutes(app, _mountApiRouter) {
  try {
    const { isMysqlConfigured } = require('../config/database');
    if (!isMysqlConfigured()) {
      console.warn('[routes] MySQL 未配置 (DB_*) — 业务 API 未挂载');
      return false;
    }

    let mounted = 0;
    let failed = 0;

    for (const [label, mountPath, moduleName] of SAAS_MYSQL_ONLY_ROUTES) {
      try {
        mountSaasMysqlOnlyRouter(app, label, mountPath, moduleName);
        mounted += 1;
      } catch (e) {
        failed += 1;
        console.error(
          `[routes] ${mountPath} mount failed (${label}):`,
          e && e.message ? e.message : e,
        );
      }
    }

    for (const [label, mountPath, moduleName] of BUSINESS_ROUTES) {
      try {
        mountBusinessRouter(app, label, mountPath, moduleName);
        mounted += 1;
      } catch (e) {
        failed += 1;
        console.error(
          `[routes] ${mountPath} mount failed (${label}):`,
          e && e.message ? e.message : e,
        );
      }
    }

    try {
      const { registerDeprecatedOpsAliases } = require('./deprecatedOpsAliases');
      registerDeprecatedOpsAliases(app);
    } catch (e) {
      failed += 1;
      console.error('[routes] deprecated ops aliases failed:', e && e.message ? e.message : e);
    }

    console.log(`[routes] registerApiRoutes done: mounted=${mounted} failed=${failed}`);
    return failed === 0;
  } catch (e) {
    console.error('[routes] business routes mount error:', e && e.message ? e.message : e);
    return false;
  }
}

module.exports = { registerApiRoutes, resolveModuleRoutes, SAAS_MYSQL_ONLY_ROUTES };
