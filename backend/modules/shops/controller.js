'use strict';

const path = require('path');
const { getMysqlPool } = require('../../db/mysqlPool');
const { insertOperationLog, getClientIp, getUserAgent } = require('../../lib/operationLog');
const { previewImport, importFromCache } = require('./importCacheShops');
const { refreshTenantShopHealth } = require('./shopHealthService');
const { isPlatformScopeUser } = require('../../lib/userScope');
const shopsSvc = require('./service');
const { getUserScope } = require('../../lib/dataScope');
const { enforceAuthTenantScope, authTenantId } = require('../../lib/resolveTenantShop');
const { getShopsSummary } = require('./summaryService');
const { resolveShopWriteScope, listActiveTenantIds } = require('./platformScope');
const { assertPlatformImportAllowed, assertPlatformRefreshAllowed } = require('../../middlewares/rateLimit');
const { withStorageLock } = require('../../lib/storageFile');
const { planErrorToHttp } = require('../tenants/planService');

const STORAGE_DIR = path.join(__dirname, '../../storage');

function logShop(pool, req, action, targetId, detail, logTenantId) {
  const tid =
    logTenantId != null && Number.isFinite(Number(logTenantId)) ? Number(logTenantId) : Number(req.auth.tenant_id);
  return insertOperationLog(pool, {
    tenant_id: tid,
    user_id: req.auth.user_id,
    action,
    module: 'shops',
    target_type: 'shop',
    target_id: targetId != null ? String(targetId) : null,
    ip: getClientIp(req),
    user_agent: getUserAgent(req),
    detail_json: detail,
  }).catch((e) => {
    if (e && e.code === 'RATE_LIMITED') {
      console.warn('[operation_log] rate limited, skipped:', action);
      return;
    }
    throw e;
  });
}


async function importCachePreview(req, res, next) {
  try {
    const out = previewImport(STORAGE_DIR, req);
    res.json(out);
  } catch (e) {
    next(e);
  }
}

async function importCacheCommit(req, res, next) {
  const pool = getMysqlPool();
  try {
    const scope = resolveShopWriteScope(req);
    if (!scope.ok) {
      return res.status(scope.status).json({ error: scope.error });
    }

    if (scope.mode === 'all') {
      assertPlatformImportAllowed();
    }

    const tenantIds =
      scope.mode === 'all' ? await listActiveTenantIds(pool) : scope.tenantIds;

    const runImport = async () => {
    const tenants = [];
    let inserted = 0;
    let updated = 0;
    let skipped = 0;
    let skipped_max_shops = 0;
    let scanned = 0;

    for (const tid of tenantIds) {
      const stats = await importFromCache(pool, tid, STORAGE_DIR, req);
      tenants.push({ tenant_id: tid, ...stats });
      inserted += Number(stats.inserted) || 0;
      updated += Number(stats.updated) || 0;
      skipped += Number(stats.skipped) || 0;
      skipped_max_shops += Number(stats.skipped_max_shops) || 0;
      scanned += Number(stats.scanned) || 0;
      await logShop(pool, req, 'import_cache', String(tid), stats, tid);
    }

    return { tenants, inserted, updated, skipped, skipped_max_shops, scanned };
    };

    const result =
      scope.mode === 'all'
        ? await withStorageLock('import-cache-platform', runImport)
        : await runImport();

    if (scope.mode === 'all') {
      return res.json({
        scope: 'all',
        tenants: result.tenants,
        inserted: result.inserted,
        updated: result.updated,
        skipped: result.skipped,
        skipped_max_shops: result.skipped_max_shops,
        scanned: result.scanned,
      });
    }

    const single = result.tenants[0] || { inserted: 0, updated: 0, skipped: 0, skipped_max_shops: 0, scanned: 0 };
    res.json({
      scope: 'tenant',
      tenant_id: tenantIds[0],
      inserted: single.inserted,
      updated: single.updated,
      skipped: single.skipped,
      skipped_max_shops: single.skipped_max_shops,
      scanned: single.scanned,
      max_shops: single.max_shops,
    });
  } catch (e) {
    if (e && e.code === 'tenant_not_found') {
      return res.status(400).json({ error: 'tenant_not_found' });
    }
    if (e && e.code === 'RATE_LIMITED') {
      return res.status(429).json({ error: 'rate_limited', message: String(e.message || e) });
    }
    next(e);
  }
}

async function summary(req, res, next) {
  const pool = getMysqlPool();
  if (!pool) {
    return res.status(503).json({ error: 'MYSQL_REQUIRED', message: 'MySQL 不可用' });
  }
  try {
    const scope = enforceAuthTenantScope(
      req.dataScope || (await getUserScope(pool, req.auth)),
      req.auth,
      req.tenantId,
    );
    const out = await getShopsSummary(pool, req.auth, scope);
    res.json(out);
  } catch (e) {
    next(e);
  }
}

async function list(req, res, next) {
  const pool = getMysqlPool();
  try {
    const scope = enforceAuthTenantScope(
      req.dataScope || (await getUserScope(pool, req.auth)),
      req.auth,
      req.tenantId,
    );
    const paged = await shopsSvc.listShopsPaged(pool, scope, req.query || {});
    const { enrichShopRows } = require('./shopLiveStatsService');
    const tenantId = Number(req.tenantId) || authTenantId(req.auth);
    const enriched = await enrichShopRows(pool, tenantId, paged.list);
    res.json({
      list: enriched.shops,
      shops: enriched.shops,
      total: paged.total,
      page: paged.page,
      page_size: paged.page_size,
      meta: {
        statsWindowHours: enriched.windowHours,
        statsSource: enriched.statsSource,
        scope_mode: scope.mode,
        data_source: 'mysql',
      },
    });
  } catch (e) {
    next(e);
  }
}

async function healthList(req, res, next) {
  return list(req, res, next);
}

async function healthRefresh(req, res, next) {
  const pool = getMysqlPool();
  try {
    const scope = resolveShopWriteScope(req);
    if (!scope.ok) {
      return res.status(scope.status).json({ error: scope.error });
    }

    if (scope.mode === 'all') {
      assertPlatformRefreshAllowed();
    }

    const tenantIds =
      scope.mode === 'all' ? await listActiveTenantIds(pool) : scope.tenantIds;

    const runRefresh = async () => {
      const tenants = [];
      let checked = 0;
      let abnormal = 0;

      for (const tid of tenantIds) {
        const result = await refreshTenantShopHealth(pool, tid, STORAGE_DIR);
        tenants.push({ tenant_id: tid, checked: result.checked, abnormal: result.abnormal });
        checked += Number(result.checked) || 0;
        abnormal += Number(result.abnormal) || 0;
        try {
          await insertOperationLog(pool, {
            tenant_id: tid,
            user_id: req.auth.user_id,
            action: 'refresh_health',
            module: 'shops',
            target_type: 'tenant',
            target_id: String(tid),
            ip: getClientIp(req),
            user_agent: getUserAgent(req),
            detail_json: { checked: result.checked, abnormal: result.abnormal, scope: scope.mode },
          });
        } catch (le) {
          if (!le || le.code !== 'RATE_LIMITED') throw le;
          console.warn('[operation_log] rate limited on refresh_health tenant', tid);
        }
      }

      return { tenants, checked, abnormal };
    };

    const result =
      scope.mode === 'all'
        ? await withStorageLock('refresh-health-platform', runRefresh)
        : await runRefresh();

    if (scope.mode === 'all') {
      return res.json({
        ok: true,
        scope: 'all',
        tenants: result.tenants,
        checked: result.checked,
        abnormal: result.abnormal,
      });
    }

    const single = result.tenants[0] || { checked: 0, abnormal: 0 };
    res.json({
      ok: true,
      scope: 'tenant',
      tenant_id: tenantIds[0],
      checked: single.checked,
      abnormal: single.abnormal,
    });
  } catch (e) {
    if (e && e.code === 'RATE_LIMITED') {
      return res.status(429).json({ error: 'rate_limited', message: String(e.message || e) });
    }
    next(e);
  }
}

async function create(req, res, next) {
  const pool = getMysqlPool();
  try {
    const row = await shopsSvc.createShop(pool, req.tenantId, req.body || {});
    await logShop(pool, req, 'shop_create', row.id, { shop: row });
    res.status(201).json({ shop: row });
  } catch (e) {
    const planHttp = planErrorToHttp(e);
    if (planHttp) {
      return res.status(planHttp.status).json(planHttp.body);
    }
    if (e && e.code === 'max_shops_reached') {
      return res.status(403).json({ error: e.code, message: '已达到套餐店铺上限', ...e.details });
    }
    if (e && e.code === 'validation_error') {
      return res.status(400).json({ error: 'validation_error' });
    }
    next(e);
  }
}

function pickLogAction(body) {
  const b = body || {};
  if (Object.prototype.hasOwnProperty.call(b, 'hidden')) {
    const v = b.hidden;
    const on = v === true || v === 1 || v === '1';
    return on ? 'hide_shop' : 'show_shop';
  }
  if (Object.prototype.hasOwnProperty.call(b, 'sync_enabled') || Object.prototype.hasOwnProperty.call(b, 'syncEnabled')) {
    const raw = b.sync_enabled ?? b.syncEnabled;
    const off = raw === false || raw === 0 || raw === '0';
    return off ? 'disable_sync' : 'enable_sync';
  }
  if (Object.prototype.hasOwnProperty.call(b, 'sort_order')) {
    const otherKeys = Object.keys(b).filter((k) => b[k] !== undefined && k !== 'sort_order');
    if (otherKeys.length === 0) return 'update_sort';
  }
  return 'update_shop';
}

async function patch(req, res, next) {
  const pool = getMysqlPool();
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid_id' });
    const existing = isPlatformScopeUser(req.auth)
      ? await shopsSvc.getShopByIdGlobal(pool, id)
      : await shopsSvc.getShopById(pool, req.tenantId, id);
    if (!existing) return res.status(404).json({ error: 'not_found' });
    const tid = Number(existing.tenant_id);
    const action = pickLogAction(req.body || {});
    const row = await shopsSvc.updateShop(pool, tid, id, req.body || {});
    if (!row) return res.status(404).json({ error: 'not_found' });
    await logShop(pool, req, action, id, { body: req.body || {}, shop: row }, tid);
    res.json({ shop: row });
  } catch (e) {
    const planHttp = planErrorToHttp(e);
    if (planHttp) {
      return res.status(planHttp.status).json(planHttp.body);
    }
    if (e && e.code === 'validation_error') {
      return res.status(400).json({ error: 'validation_error', message: String(e.message || e) });
    }
    next(e);
  }
}

async function patchStatus(req, res, next) {
  const pool = getMysqlPool();
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid_id' });
    const existing = isPlatformScopeUser(req.auth)
      ? await shopsSvc.getShopByIdGlobal(pool, id)
      : await shopsSvc.getShopById(pool, req.tenantId, id);
    if (!existing) return res.status(404).json({ error: 'not_found' });
    const tid = Number(existing.tenant_id);
    const status = (req.body && req.body.status) || '';
    const s = String(status || '').trim().toLowerCase();
    const row = await shopsSvc.updateShopStatus(pool, tid, id, status);
    if (!row) return res.status(404).json({ error: 'not_found' });
    const action = s === 'disabled' ? 'disable_shop' : 'enable_shop';
    await logShop(pool, req, action, id, { status: row.status }, tid);
    res.json({ shop: row });
  } catch (e) {
    if (e && e.code === 'invalid_status') {
      return res.status(400).json({ error: 'invalid_status' });
    }
    next(e);
  }
}

async function remove(req, res, next) {
  const pool = getMysqlPool();
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid_id' });
    const existing = isPlatformScopeUser(req.auth)
      ? await shopsSvc.getShopByIdGlobal(pool, id)
      : await shopsSvc.getShopById(pool, req.tenantId, id);
    if (!existing) return res.status(404).json({ error: 'not_found' });
    const tid = Number(existing.tenant_id);
    const row = await shopsSvc.softDeleteShop(pool, tid, id);
    if (!row) return res.status(404).json({ error: 'not_found' });
    await logShop(pool, req, 'shop_delete_soft', id, { status: row.status }, tid);
    if (isPlatformScopeUser(req.auth)) {
      try {
        const { insertNotification } = require('../notifications/service');
        const tidN = Number(row.tenant_id);
        const [owners] = await pool.query(
          `SELECT DISTINCT user_id FROM user_tenants WHERE tenant_id = ? AND role IN ('admin','tenant_owner','tenant_admin') AND status = 'active'`,
          [tidN],
        );
        const label = String(row.shop_name || row.display_name || id);
        for (const o of Array.isArray(owners) ? owners : []) {
          const uid = Number(o.user_id);
          if (!Number.isFinite(uid) || uid <= 0) continue;
          await insertNotification(pool, {
            tenant_id: tidN,
            user_id: uid,
            title: '店铺已删除',
            content: `店铺「${label}」已被平台管理员标记为删除（#${id}）。`,
            type: 'shop_deleted',
          });
        }
      } catch (e) {
        console.warn('[shops/remove notify]', e && e.message ? e.message : e);
      }
    }
    res.json({ ok: true, shop: row });
  } catch (e) {
    next(e);
  }
}

module.exports = {
  summary,
  list,
  healthList,
  healthRefresh,
  create,
  patch,
  patchStatus,
  remove,
  importCachePreview,
  importCacheCommit,
};
