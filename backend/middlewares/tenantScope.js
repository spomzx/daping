'use strict';

function tenantScope(req, res, next) {
  if (!req.auth) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  req.tenantId = req.auth.tenant_id;
  next();
}

module.exports = { tenantScope };
