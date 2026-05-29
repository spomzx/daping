'use strict';

const express = require('express');
const { authRequired } = require('../../middlewares/authRequired');
const { tenantScope } = require('../../middlewares/tenantScope');
const { requireRole } = require('../../middlewares/requireRole');
const { requireFullAccess } = require('../../middlewares/requireFullAccess');
const ctrl = require('./controller');

const router = express.Router();

router.use(authRequired, tenantScope, requireFullAccess, requireRole('admin', 'super_admin'));

router.get('/status', ctrl.status);

module.exports = { router };
