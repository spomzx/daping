'use strict';

const svc = require('./service');

async function list(req, res, next) {
  try {
    const tenantId = req.effectiveTenantId ?? req.tenantId ?? req.auth?.tenant_id;
    const out = await svc.listJobs(tenantId, req.auth, req.query);
    res.json({ ok: true, ...out });
  } catch (e) {
    next(e);
  }
}

module.exports = { list };
