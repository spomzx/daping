'use strict';

const express = require('express');
const { authRequired } = require('../../middlewares/authRequired');
const { tenantScope } = require('../../middlewares/tenantScope');
const ctrl = require('./controller');

const router = express.Router();

router.post('/login', (req, res, next) => {
  ctrl.login(req, res).catch(next);
});

router.post('/register', (req, res, next) => {
  ctrl.register(req, res).catch(next);
});

router.post('/logout', ctrl.logout);

router.get('/me', authRequired, tenantScope, (req, res, next) => {
  ctrl.me(req, res).catch(next);
});

module.exports = { router };
