'use strict';

const express = require('express');
const { authRequired } = require('../../middlewares/authRequired');
const { tenantScope } = require('../../middlewares/tenantScope');
const { requireRole } = require('../../middlewares/requireRole');
const { requireFullAccess } = require('../../middlewares/requireFullAccess');
const { requirePlatformOps } = require('../../middlewares/opsAccess');
const ctrl = require('./controller');

const router = express.Router();

router.get('/ping', (_req, res) => {
  res.json({ ok: true, module: 'tenants' });
});

router.get(
  '/plan/me',
  authRequired,
  tenantScope,
  requireFullAccess,
  requireRole('admin', 'super_admin'),
  (req, res, next) => ctrl.getMyPlan(req, res, next),
);

router.get(
  '/:id/plan',
  authRequired,
  tenantScope,
  requireFullAccess,
  requireRole('admin', 'super_admin'),
  (req, res, next) => ctrl.getPlan(req, res, next),
);

router.use(authRequired, tenantScope, requireFullAccess, requirePlatformOps);

router.get('/', (req, res, next) => ctrl.list(req, res, next));

router.patch('/:id', (req, res, next) => ctrl.patchTenant(req, res, next));

router.patch('/:id/plan', (req, res, next) => ctrl.patchPlan(req, res, next));

module.exports = { router };
