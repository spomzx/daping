'use strict';

const express = require('express');
const { authRequired } = require('../../middlewares/authRequired');
const { tenantScope } = require('../../middlewares/tenantScope');
const { effectiveTenantScope } = require('../../middlewares/effectiveTenantScope');
const { requireRole } = require('../../middlewares/requireRole');
const { requireFullAccess } = require('../../middlewares/requireFullAccess');
const ctrl = require('./controller');

const router = express.Router();

router.get('/ping', (_req, res) => {
  res.json({ ok: true, module: 'dashboard', source: 'mysql' });
});

/** War-Room 实时订单：须 Bearer；不走 requireFullAccess，避免与 legacy 路由冲突导致 401 */
router.get(
  '/orders',
  authRequired,
  tenantScope,
  effectiveTenantScope,
  requireRole('viewer', 'admin', 'super_admin'),
  (req, res) => {
    ctrl.orders(req, res);
  },
);

router.use(authRequired, tenantScope, effectiveTenantScope, requireFullAccess);

router.get('/summary', requireRole('viewer', 'admin', 'super_admin'), (req, res) => {
  ctrl.summary(req, res);
});

router.get('/trend', requireRole('viewer', 'admin', 'super_admin'), (req, res) => {
  ctrl.trend(req, res);
});

router.get('/ranking', requireRole('viewer', 'admin', 'super_admin'), (req, res) => {
  ctrl.ranking(req, res);
});

router.get('/shop-ranking', requireRole('viewer', 'admin', 'super_admin'), (req, res) => {
  ctrl.ranking(req, res);
});

module.exports = { router };
