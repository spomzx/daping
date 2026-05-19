'use strict';

const express = require('express');
const { authRequired } = require('../../middlewares/authRequired');
const { tenantScope } = require('../../middlewares/tenantScope');
const { requireRole } = require('../../middlewares/requireRole');
const { requireFullAccess } = require('../../middlewares/requireFullAccess');
const ctrl = require('./controller');

const router = express.Router();

router.get('/ping', (_req, res) => {
  res.json({ ok: true, module: 'operation-logs' });
});

router.use(authRequired, tenantScope, requireFullAccess, requireRole('super_admin'));

router.get('/', (req, res, next) => {
  ctrl.list(req, res, next);
});

module.exports = { router };
