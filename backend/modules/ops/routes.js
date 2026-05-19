'use strict';

const express = require('express');
const { authRequired } = require('../../middlewares/authRequired');
const { tenantScope } = require('../../middlewares/tenantScope');
const { requireFullAccess } = require('../../middlewares/requireFullAccess');
const { requirePlatformOps, markOpsApi } = require('../../middlewares/opsAccess');
const { importCacheLimiter } = require('../../middlewares/rateLimit');
const ctrl = require('./controller');

const router = express.Router();

router.use(authRequired, tenantScope, requireFullAccess, requirePlatformOps, markOpsApi);

/**
 * @ops-only legacy import：从 shops.json / cache 导入 MySQL。
 * @deprecated legacy only — not for SaaS（SaaS `/api/shops/import-cache` 已阻断）。
 */
router.get('/import-cache/preview', (req, res, next) => {
  ctrl.importCachePreview(req, res, next);
});

router.post('/import-cache', importCacheLimiter, (req, res, next) => {
  ctrl.importCacheCommit(req, res, next);
});

/**
 * @ops-only orders-cache vs MySQL 对账（平台 debug/运维）。
 * SaaS 页面禁止调用；/reconcile 前端已废弃。
 */
router.get('/orders/reconcile', (req, res) => {
  ctrl.ordersReconcile(req, res);
});

/** @ops-only 从 MySQL 重建 orders-cache.json（不写回 MySQL 主数据） */
router.post('/orders/rebuild-cache', (req, res) => {
  ctrl.ordersRebuildCache(req, res);
});

router.get('/orders/cache-paths', (req, res) => {
  ctrl.ordersCachePaths(req, res);
});

module.exports = { router };
