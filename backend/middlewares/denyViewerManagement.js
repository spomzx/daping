'use strict';

const { isReadOnlyRole } = require('../lib/roles');

/** viewer 禁止调用管理类写接口 */
function denyViewerManagement(req, res, next) {
  if (req.auth && isReadOnlyRole(req.auth.role)) {
    return res.status(403).json({ error: 'forbidden', message: '普通用户无管理权限' });
  }
  return next();
}

module.exports = { denyViewerManagement };
