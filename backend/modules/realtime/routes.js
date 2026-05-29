'use strict';

const express = require('express');
const { authRequired } = require('../../middlewares/authRequired');
const { tenantScope } = require('../../middlewares/tenantScope');
const { effectiveTenantScope } = require('../../middlewares/effectiveTenantScope');
const { attachDataScope } = require('../../middlewares/attachDataScope');
const { requireRole } = require('../../middlewares/requireRole');
const ctrl = require('./controller');

const router = express.Router();

router.use(authRequired, tenantScope, effectiveTenantScope, attachDataScope);

router.get('/orders', requireRole('viewer', 'admin', 'super_admin'), (req, res) => {
  ctrl.orders(req, res);
});

module.exports = { router };
