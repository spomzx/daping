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
  res.json({ ok: true, module: 'operation-logs', source: 'mysql' });
});

router.use(authRequired, tenantScope, effectiveTenantScope, requireFullAccess);

router.get('/stats', requireRole('admin', 'super_admin'), (req, res) => ctrl.stats(req, res));

router.get('/:id', requireRole('admin', 'super_admin'), (req, res) => ctrl.detail(req, res));

router.get('/', requireRole('admin', 'super_admin'), (req, res) => ctrl.list(req, res));

module.exports = { router };
