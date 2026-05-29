'use strict';

const express = require('express');
const { authRequired } = require('../../middlewares/authRequired');
const { tenantScope } = require('../../middlewares/tenantScope');
const { requireRole } = require('../../middlewares/requireRole');
const { requireFullAccess } = require('../../middlewares/requireFullAccess');
const ctrl = require('./controller');

const router = express.Router();

router.use(authRequired, tenantScope, requireFullAccess, requireRole('super_admin'));

router.get('/', (req, res, next) => {
  ctrl.list(req, res).catch(next);
});

router.patch('/:id/read', (req, res, next) => {
  ctrl.patchRead(req, res).catch(next);
});

module.exports = { router };
