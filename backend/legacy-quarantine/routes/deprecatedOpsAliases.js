'use strict';

/**
 * @deprecated SaaS 璺緞鍒悕 鈥?宸查樆鏂?cache/json 璇诲彇锛圥hase 2-2锛夈€? * 璇蜂娇鐢?/api/ops/*锛堝钩鍙扮鐞嗗憳锛夛紱legacy only锛宯ot for SaaS銆? */

const express = require('express');
const { authRequired } = require('../middlewares/authRequired');
const { tenantScope } = require('../middlewares/tenantScope');
const { requireFullAccess } = require('../middlewares/requireFullAccess');
const { requirePlatformOps, withDeprecatedReplacement } = require('../middlewares/opsAccess');
const { blockSaasLegacyOpsAlias } = require('../middlewares/saasMysqlOnly');

const shopsRouter = express.Router();
shopsRouter.use(
  authRequired,
  tenantScope,
  requireFullAccess,
  requirePlatformOps,
  withDeprecatedReplacement('/api/ops/import-cache'),
  blockSaasLegacyOpsAlias,
);

shopsRouter.get('/import-cache-preview', blockSaasLegacyOpsAlias);
shopsRouter.post('/import-cache', blockSaasLegacyOpsAlias);

const ordersRouter = express.Router();
ordersRouter.use(authRequired, tenantScope, requireFullAccess, requirePlatformOps);

ordersRouter.get(
  '/reconcile',
  withDeprecatedReplacement('/api/ops/orders/reconcile'),
  blockSaasLegacyOpsAlias,
);

ordersRouter.get(
  '/cache/paths',
  withDeprecatedReplacement('/api/ops/orders/cache-paths'),
  blockSaasLegacyOpsAlias,
);

ordersRouter.post(
  '/cache/rebuild-from-mysql',
  withDeprecatedReplacement('/api/ops/orders/rebuild-cache'),
  blockSaasLegacyOpsAlias,
);

function registerDeprecatedOpsAliases(app) {
  app.use('/api/shops', shopsRouter);
  app.use('/api/orders', ordersRouter);
  console.log(
    '[routes] deprecated ops aliases BLOCKED on SaaS paths (use /api/ops/*): import-cache, reconcile, cache/*',
  );
}

module.exports = { registerDeprecatedOpsAliases, shopsRouter, ordersRouter };
