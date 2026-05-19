'use strict';

const { normalizeRoleFromDb } = require('../lib/roles');

/**
 * 声明的角色扩展为 JWT/库内可能出现的旧枚举（归一化后比对）。
 * @param {string[]} roles canonical：super_admin | admin | viewer
 * @returns {Set<string>}
 */
function expandRolesForRequire(roles) {
  const s = new Set();
  for (const r of roles) {
    const c = normalizeRoleFromDb(String(r || '').trim());
    if (!c) continue;
    s.add(c);
    if (c === 'admin') {
      s.add('tenant_owner');
      s.add('tenant_admin');
    }
    if (c === 'viewer') s.add('tenant_viewer');
    if (c === 'super_admin') s.add('platform_admin');
  }
  return s;
}

/**
 * @param {...string} roles 允许的角色名（任一匹配即可；历史枚举由 expand 覆盖）
 */
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.auth) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    if (!roles.length) {
      return next();
    }
    const allowed = expandRolesForRequire(roles);
    const mine = normalizeRoleFromDb(req.auth.role);
    if (mine && allowed.has(mine)) {
      return next();
    }
    return res.status(403).json({ error: 'forbidden', role: mine || String(req.auth.role || '') });
  };
}

module.exports = { requireRole, expandRolesForRequire };
