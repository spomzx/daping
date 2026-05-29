'use strict';

const express = require('express');
const { authRequired } = require('../../middlewares/authRequired');
const { tenantScope } = require('../../middlewares/tenantScope');
const { requireFullAccess } = require('../../middlewares/requireFullAccess');
const { requirePlatformOps, markOpsApi } = require('../../middlewares/opsAccess');

const router = express.Router();

router.use(authRequired, tenantScope, requireFullAccess, requirePlatformOps, markOpsApi);

/** P2-C：import-cache / reconcile / rebuild-cache 已移除，由 routes/removedLegacyGone.js 返回 410 */

router.get('/ping', (_req, res) => {
  res.json({ ok: true, module: 'ops', legacy_cache_removed: true });
});

module.exports = { router };
