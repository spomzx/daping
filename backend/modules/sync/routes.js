'use strict';

const express = require('express');
const { authRequired } = require('../../middlewares/authRequired');
const { tenantScope } = require('../../middlewares/tenantScope');
const { effectiveTenantScope } = require('../../middlewares/effectiveTenantScope');
const { requireRole } = require('../../middlewares/requireRole');
const { requireFullAccess } = require('../../middlewares/requireFullAccess');
const { collectNowLimiter } = require('../../middlewares/rateLimit');
const ctrl = require('./controller');

const router = express.Router();

router.get('/ping', (_req, res) => {
  res.json({ ok: true, module: 'sync' });
});

router.use(authRequired, tenantScope, effectiveTenantScope, requireFullAccess);

router.get('/status', requireRole('viewer', 'admin', 'super_admin'), (req, res) => ctrl.status(req, res));

router.get('/logs', requireRole('viewer', 'admin', 'super_admin'), (req, res) => ctrl.logs(req, res));

router.post('/run/:shopId', requireRole('admin', 'super_admin'), collectNowLimiter, (req, res) => {
  ctrl.runShop(req, res);
});

router.post('/retry/:shopId', requireRole('admin', 'super_admin'), collectNowLimiter, (req, res) => {
  ctrl.retryShop(req, res);
});

module.exports = { router };
