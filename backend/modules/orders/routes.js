'use strict';

const express = require('express');
const { authRequired } = require('../../middlewares/authRequired');
const { tenantScope } = require('../../middlewares/tenantScope');
const { requireRole } = require('../../middlewares/requireRole');
const { requireFullAccess } = require('../../middlewares/requireFullAccess');
const ordersCtrl = require('./ordersListController');
const router = express.Router();

router.use(authRequired, tenantScope, requireFullAccess);

router.get('/list', requireRole('viewer', 'admin', 'super_admin'), (req, res) => {
  ordersCtrl.list(req, res);
});

router.get('/detail/:id', requireRole('viewer', 'admin', 'super_admin'), (req, res) => {
  ordersCtrl.detail(req, res);
});

router.get('/stats', requireRole('viewer', 'admin', 'super_admin'), (req, res) => {
  ordersCtrl.stats(req, res);
});

module.exports = { router };
