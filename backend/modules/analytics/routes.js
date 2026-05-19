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

router.get('/top-products', requireRole('viewer', 'admin', 'super_admin'), (req, res) => {
  ctrl.topProducts(req, res);
});

router.get('/shop-trend', requireRole('viewer', 'admin', 'super_admin'), (req, res) => {
  ctrl.shopTrend(req, res);
});

router.get('/top-shops', requireRole('viewer', 'admin', 'super_admin'), (req, res) => {
  ctrl.topShops(req, res);
});

router.get('/recent-orders', requireRole('viewer', 'admin', 'super_admin'), (req, res) => {
  ctrl.recentOrders(req, res);
});

router.get('/search-sku', requireRole('viewer', 'admin', 'super_admin'), (req, res) => {
  ctrl.searchSku(req, res);
});

router.get('/gmv-compare', requireRole('viewer', 'admin', 'super_admin'), (req, res) => {
  ctrl.gmvCompare(req, res);
});

router.get('/status-debug', requireRole('viewer', 'admin', 'super_admin'), (req, res) => {
  ctrl.statusDebug(req, res);
});

module.exports = { router };
