'use strict';

const express = require('express');
const { authRequired } = require('../../middlewares/authRequired');
const { tenantScope } = require('../../middlewares/tenantScope');
const { requireRole } = require('../../middlewares/requireRole');
const { requireFullAccess } = require('../../middlewares/requireFullAccess');
const ordersCtrl = require('./ordersListController');
const { blockSaasLegacyOpsAlias } = require('../../middlewares/saasMysqlOnly');
const { withDeprecatedReplacement } = require('../../middlewares/opsAccess');

const router = express.Router();

router.use(authRequired, tenantScope, requireFullAccess);

router.get('/list', requireRole('viewer', 'admin', 'super_admin'), (req, res) => {
  ordersCtrl.list(req, res);
});

router.get('/detail/:id', requireRole('viewer', 'admin', 'super_admin'), (req, res) => {
  ordersCtrl.detail(req, res);
});

router.get('/stats', requireRole('viewer', 'admin', 'super_admin'), (req, res) => {
  ordersCtrl.stats(req, res);
});

/**
 * @deprecated legacy only — 对账读 orders-cache，已阻断于 SaaS 路径。
 * 请用 GET /api/ops/orders/reconcile（平台管理员）。
 */
router.get('/reconcile', withDeprecatedReplacement('/api/ops/orders/reconcile'), blockSaasLegacyOpsAlias);

module.exports = { router };
