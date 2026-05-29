'use strict';

const express = require('express');
const { authRequired } = require('../../middlewares/authRequired');
const { tenantScope } = require('../../middlewares/tenantScope');
const { effectiveTenantScope } = require('../../middlewares/effectiveTenantScope');
const { requireRole } = require('../../middlewares/requireRole');
const { requireFullAccess } = require('../../middlewares/requireFullAccess');
const ctrl = require('./controller');

const router = express.Router();

router.use(authRequired, tenantScope, effectiveTenantScope, requireFullAccess);

router.get('/', requireRole('viewer', 'admin', 'super_admin'), (req, res) => ctrl.list(req, res));

module.exports = { router };
