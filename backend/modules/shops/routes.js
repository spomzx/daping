'use strict';

const express = require('express');
const { authRequired } = require('../../middlewares/authRequired');
const { tenantScope } = require('../../middlewares/tenantScope');
const { effectiveTenantScope } = require('../../middlewares/effectiveTenantScope');
const { requireRole } = require('../../middlewares/requireRole');
const { requireFullAccess } = require('../../middlewares/requireFullAccess');
const { denyViewerManagement } = require('../../middlewares/denyViewerManagement');
const { refreshHealthLimiter } = require('../../middlewares/rateLimit');
const ctrl = require('./controller');
const { attachDataScope } = require('../../middlewares/attachDataScope');

const router = express.Router();

router.use(authRequired, tenantScope, requireFullAccess, attachDataScope);

const viewTenant = [effectiveTenantScope];

/** import-cache 已迁至 /api/ops/import-cache（平台管理员）；见 routes/deprecatedOpsAliases.js */

router.get('/summary', requireRole('viewer', 'admin', 'super_admin'), (req, res, next) => {
  ctrl.summary(req, res, next);
});

router.get('/health', requireRole('viewer', 'admin', 'super_admin'), (req, res, next) => {
  ctrl.healthList(req, res, next);
});

router.post(
  '/health/refresh',
  denyViewerManagement,
  requireRole('admin', 'super_admin'),
  refreshHealthLimiter,
  (req, res, next) => {
    ctrl.healthRefresh(req, res, next);
  },
);

router.get('/', ...viewTenant, requireRole('viewer', 'admin', 'super_admin'), (req, res, next) => {
  ctrl.list(req, res, next);
});

router.post('/', denyViewerManagement, requireRole('admin', 'super_admin'), (req, res, next) => {
  ctrl.create(req, res, next);
});

router.patch('/:id', denyViewerManagement, requireRole('admin', 'super_admin'), (req, res, next) => {
  ctrl.patch(req, res, next);
});

router.patch('/:id/status', denyViewerManagement, requireRole('admin', 'super_admin'), (req, res, next) => {
  ctrl.patchStatus(req, res, next);
});

router.delete('/:id', denyViewerManagement, requireRole('admin', 'super_admin'), (req, res, next) => {
  ctrl.remove(req, res, next);
});

module.exports = { router };
