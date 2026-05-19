'use strict';

const { getMysqlPool } = require('../db/mysqlPool');
const { resolveEffectiveTenantId } = require('../lib/effectiveTenant');

/**
 * 在 tenantScope 之后：平台管理员可通过 query.tenant_id 切换查看租户；租户用户禁止越权。
 */
async function effectiveTenantScope(req, res, next) {
  if (!req.auth) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  try {
    const pool = getMysqlPool();
    const out = await resolveEffectiveTenantId(req, pool);
    if (!out.ok) {
      return res.status(out.status || 403).json({
        error: out.error,
        message: out.message,
      });
    }
    req.tenantId = out.tenantId;
    req.effectiveTenantId = out.tenantId;
    req.tenantViewOverride = Boolean(out.override);
    return next();
  } catch (e) {
    return next(e);
  }
}

module.exports = { effectiveTenantScope };
