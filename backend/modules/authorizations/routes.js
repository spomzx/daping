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
  res.json({ ok: true, module: 'authorizations' });
});

router.use(authRequired, tenantScope, effectiveTenantScope, requireFullAccess);

router.get('/list', requireRole('viewer', 'admin', 'super_admin'), (req, res, next) => {
  ctrl.list(req, res, next);
});

router.get('/', requireRole('viewer', 'admin', 'super_admin'), (req, res, next) => {
  ctrl.listAlias(req, res, next);
});

router.get('/detail/:id', requireRole('viewer', 'admin', 'super_admin'), (req, res, next) => {
  ctrl.detail(req, res, next);
});

module.exports = { router };
