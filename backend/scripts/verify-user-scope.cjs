'use strict';

/**
 * 部署后自检：userScope 不得依赖 roles；关键模块可正常加载。
 * 用法：node scripts/verify-user-scope.cjs
 */

const assert = require('assert');
const path = require('path');

const userScopePath = path.join(__dirname, '../lib/userScope.js');
const src = require('fs')
  .readFileSync(userScopePath, 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\/\/.*$/gm, '');
if (/require\s*\(\s*['"]\.\/roles['"]\s*\)/.test(src) || /\bisSuperAdmin\s*\(/.test(src)) {
  console.error('[FAIL] userScope.js must not require roles.js or call isSuperAdmin()');
  process.exit(1);
}

const u = require('../lib/userScope');
const r = require('../lib/roles');

assert.strictEqual(typeof u.isPlatformScope, 'function');
assert.strictEqual(typeof u.isPlatformScopeUser, 'function');
assert.strictEqual(typeof r.isSuperAdmin, 'function');
assert.strictEqual(u.isPlatformScope({ scope: 'platform', role: 'admin' }), true);
assert.strictEqual(u.isPlatformScope({ scope: 'tenant', role: 'super_admin' }), true);
assert.strictEqual(u.isPlatformScope({ scope: 'tenant', role: 'platform_admin' }), true);
assert.strictEqual(u.isPlatformScope({ scope: 'tenant', role: 'admin' }), false);
assert.strictEqual(u.isPlatformScopeUser({ scope: 'platform', role: 'admin' }), true);
assert.strictEqual(u.isPlatformScopeUser({ scope: 'tenant', role: 'super_admin' }), true);
assert.strictEqual(u.isPlatformScopeUser({ scope: 'tenant', role: 'platform_admin' }), true);
assert.strictEqual(u.isPlatformScopeUser({ scope: 'tenant', role: 'admin' }), false);
assert.strictEqual(u.isTenantScopeUser({ scope: 'tenant', role: 'admin' }), true);

require('../modules/auth/controller');
require('../modules/shops/controller');
require('../modules/shops/summaryService');
require('../middlewares/requireRole');

console.log('[OK] userScope isolated; isPlatformScopeUser works; modules load');
