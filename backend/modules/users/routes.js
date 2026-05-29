'use strict';

const express = require('express');
const { authRequired } = require('../../middlewares/authRequired');
const { tenantScope } = require('../../middlewares/tenantScope');
const { requireRole } = require('../../middlewares/requireRole');
const { requireFullAccess } = require('../../middlewares/requireFullAccess');
const { denyViewerManagement } = require('../../middlewares/denyViewerManagement');
const ctrl = require('./controller');

const router = express.Router();

router.get('/ping', (req, res) => {
  res.json({ ok: true, module: 'users' });
});

router.use(authRequired, tenantScope, denyViewerManagement);

/** 店铺分配：仅租户账户管理员（非 super_admin / 非平台 scope） */
router.get('/assignable-shops', requireFullAccess, requireRole('admin'), (req, res, next) => {
  ctrl.assignableShops(req, res).catch(next);
});

router.get('/:id/shop-permissions', requireFullAccess, requireRole('admin'), (req, res, next) => {
  ctrl.getShopPermissions(req, res).catch(next);
});

router.put('/:id/shop-permissions', requireFullAccess, requireRole('admin'), (req, res, next) => {
  ctrl.putShopPermissions(req, res).catch(next);
});

router.post('/:id/approve', requireRole('super_admin'), (req, res, next) => {
  ctrl.approve(req, res).catch(next);
});

router.post('/:id/reject', requireRole('super_admin'), (req, res, next) => {
  ctrl.reject(req, res).catch(next);
});

router.delete('/:id', requireFullAccess, requireRole('super_admin', 'admin'), (req, res, next) => {
  ctrl.removeUser(req, res).catch(next);
});

router.get('/', requireFullAccess, requireRole('super_admin', 'admin'), (req, res, next) => {
  ctrl.list(req, res).catch(next);
});

router.post('/', requireFullAccess, requireRole('super_admin', 'admin'), (req, res, next) => {
  ctrl.create(req, res).catch(next);
});

router.patch('/:id/status', requireFullAccess, requireRole('super_admin', 'admin'), (req, res, next) => {
  ctrl.patchStatus(req, res).catch(next);
});

router.post('/:id/reset-password', requireFullAccess, requireRole('super_admin', 'admin'), (req, res, next) => {
  ctrl.resetPassword(req, res).catch(next);
});

module.exports = { router };
