'use strict';

const express = require('express');
const { authRequired } = require('../../middlewares/authRequired');
const { requireRole } = require('../../middlewares/requireRole');
const ctrl = require('./controller');

const router = express.Router();

router.get('/exchange-rate', (req, res) => {
  ctrl.exchangeRate(req, res);
});

router.get('/admin/exchange-rates/health', authRequired, requireRole('admin', 'super_admin'), (req, res) => {
  ctrl.health(req, res);
});

module.exports = { router };
