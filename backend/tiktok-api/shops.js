const fs = require('fs');
const path = require('path');
const dayjs = require('dayjs');
const {
  atomicWriteJsonSync,
  readJsonWithRecovery,
  withStorageLockSync,
} = require('../lib/storageFile');

/**
 * @deprecated legacy worker / 紧急回滚 only — SaaS API 禁止直接读取 shops.json
 * 生产环境固定路径；本地可通过 SHOPS_JSON_PATH 覆盖
 */
const SHOPS_PATH =
  process.env.SHOPS_JSON_PATH || path.join(__dirname, '..', 'storage', 'shops.json');

const SHOPS_LOCK_KEY = 'shops.json';

const PREFERRED_SHOP_NAME = 'CQ Chic Jewelry';

function ensureShopsDir() {
  fs.mkdirSync(path.dirname(SHOPS_PATH), { recursive: true });
}

/**
 * 从文件原始 JSON 解析出店铺数组；兼容 [] 与 { shops: [] }
 */
function parseShopsPayload(raw) {
  if (raw == null) return { shops: [], rawType: 'null', rawCount: 0 };
  if (Array.isArray(raw)) {
    return { shops: raw, rawType: 'array', rawCount: raw.length };
  }
  if (typeof raw === 'object' && Array.isArray(raw.shops)) {
    return { shops: raw.shops, rawType: 'object_shops', rawCount: raw.shops.length };
  }
  if (typeof raw === 'object') {
    return { shops: [], rawType: 'object_no_shops', rawCount: 0 };
  }
  return { shops: [], rawType: 'non_object', rawCount: 0 };
}

function readShopsFileInfo() {
  const shopsFileExists = fs.existsSync(SHOPS_PATH);
  if (!shopsFileExists) {
    return {
      shopsFilePath: SHOPS_PATH,
      shopsFileExists: false,
      shopsRawType: 'missing',
      shopsRawCount: 0,
      shops: [],
    };
  }
  const recovered = readJsonWithRecovery(SHOPS_PATH, { restore: true });
  if (recovered.data == null) {
    return {
      shopsFilePath: SHOPS_PATH,
      shopsFileExists: true,
      shopsRawType: 'invalid_json',
      shopsRawCount: 0,
      shops: [],
      recoveredFrom: recovered.source,
    };
  }
  const { shops, rawType, rawCount } = parseShopsPayload(recovered.data);
  return {
    shopsFilePath: SHOPS_PATH,
    shopsFileExists: true,
    shopsRawType: recovered.recovered ? 'recovered_backup' : rawType,
    shopsRawCount: rawCount,
    shops,
    recoveredFrom: recovered.recovered ? recovered.source : undefined,
  };
}

function grantedScopesString(shop) {
  const raw = shop?.grantedScopes ?? shop?.scope ?? '';
  return Array.isArray(raw) ? raw.join(',') : String(raw || '');
}

function shopCipherString(shop) {
  const raw = shop?.rawTokenPayload || {};
  return String(shop?.shopCipher || shop?.shop_cipher || raw.shop_cipher || '').trim();
}

/** enabled !== false、有 token、有 cipher（scope 由订单 API 实测，不预判） */
function isEligibleDashboardShop(shop) {
  if (!shop || shop.enabled === false) return false;
  const token = String(shop.accessToken || '').trim();
  const cipher = shopCipherString(shop);
  if (!token || !cipher) return false;
  return true;
}

function listEligibleDashboardShops(shops) {
  return (Array.isArray(shops) ? shops : []).filter(isEligibleDashboardShop);
}

/** 优先 CQ Chic Jewelry，否则第一个符合条件的店铺 */
function pickDashboardShop(shops) {
  const eligible = listEligibleDashboardShops(shops);
  const preferred = eligible.find((s) => String(s.shopName || '').trim() === PREFERRED_SHOP_NAME);
  return preferred || eligible[0] || null;
}

/** 仅返回数组，供各模块使用；不写入文件 */
function readShops() {
  const list = readShopsFileInfo().shops;
  return (Array.isArray(list) ? list : []).map((s) => normalizeShopRecord(s));
}

function writeShopsUnlocked(shops) {
  ensureShopsDir();
  atomicWriteJsonSync(SHOPS_PATH, shops, { lockHeld: true, pretty: true });
}

function writeShops(shops) {
  withStorageLockSync(SHOPS_LOCK_KEY, () => writeShopsUnlocked(shops));
}

function isIsoExpired(iso) {
  if (!iso) return true;
  const ts = dayjs(String(iso)).valueOf();
  if (!Number.isFinite(ts) || ts <= 0) return true;
  return ts <= Date.now() + 60_000;
}

function computeShopStatus(shop) {
  if (!shop) return 'disabled';
  if (shop.enabled === false) return 'disabled';
  const hasToken = String(shop.accessToken || '').trim().length > 0;
  const hasCipher = shopCipherString(shop).length > 0;
  if (!hasToken || !hasCipher) return 'expired';
  if (isIsoExpired(shop.accessTokenExpiresAt)) return 'expired';
  return 'active';
}

function normalizeShopRecord(shop) {
  if (!shop || typeof shop !== 'object') return shop;
  const next = { ...shop };
  if (next.enabled == null) next.enabled = true;
  if (next.grantedScopes == null && next.granted_scopes != null) next.grantedScopes = next.granted_scopes;
  if (next.granted_scopes == null && next.grantedScopes != null) next.granted_scopes = next.grantedScopes;
  next.status = String(next.status || computeShopStatus(next));
  next.tokenStatus = next.status === 'disabled' ? 'disabled' : next.status === 'expired' ? 'expired' : 'active';
  return next;
}

function upsertShop(shop) {
  return withStorageLockSync(SHOPS_LOCK_KEY, () => {
    const shops = readShops();
    const idx = shops.findIndex((s) => String(s.shopId) === String(shop.shopId));
    const next = {
      enabled: true,
      ...shop,
      updatedAt: dayjs().format('YYYY-MM-DD HH:mm:ss'),
    };
    next.status = computeShopStatus(next);
    next.tokenStatus = next.status === 'disabled' ? 'disabled' : next.status === 'expired' ? 'expired' : 'active';
    if (idx >= 0) shops[idx] = { ...shops[idx], ...next };
    else shops.push(next);
    writeShopsUnlocked(shops);
    return next;
  });
}

function patchShopEnabled(shopId, enabled) {
  return withStorageLockSync(SHOPS_LOCK_KEY, () => {
    const shops = readShops();
    const idx = shops.findIndex((s) => String(s.shopId) === String(shopId));
    if (idx < 0) return null;
    const patched = { ...shops[idx], enabled: Boolean(enabled), updatedAt: dayjs().format('YYYY-MM-DD HH:mm:ss') };
    patched.status = computeShopStatus(patched);
    patched.tokenStatus =
      patched.status === 'disabled' ? 'disabled' : patched.status === 'expired' ? 'expired' : 'active';
    shops[idx] = patched;
    writeShopsUnlocked(shops);
    return shops[idx];
  });
}

function patchShopSyncState(shopId, patch = {}) {
  return withStorageLockSync(SHOPS_LOCK_KEY, () => {
    const shops = readShops();
    const idx = shops.findIndex((s) => String(s.shopId) === String(shopId));
    if (idx < 0) return null;
    const next = {
      ...shops[idx],
      ...patch,
      updatedAt: dayjs().format('YYYY-MM-DD HH:mm:ss'),
    };
    next.status = computeShopStatus(next);
    next.tokenStatus = next.status === 'disabled' ? 'disabled' : next.status === 'expired' ? 'expired' : 'active';
    shops[idx] = next;
    writeShopsUnlocked(shops);
    return shops[idx];
  });
}

function sanitizeShop(shop) {
  if (!shop) return null;
  const {
    accessToken,
    refreshToken,
    accessTokenExpiresAt,
    refreshTokenExpiresAt,
    rawTokenPayload,
    appSecret,
    appKey,
    ...rest
  } = shop;
  return normalizeShopRecord(rest);
}

module.exports = {
  SHOPS_PATH,
  readShops,
  readShopsFileInfo,
  listEligibleDashboardShops,
  pickDashboardShop,
  grantedScopesString,
  shopCipherString,
  writeShops,
  upsertShop,
  patchShopEnabled,
  patchShopSyncState,
  computeShopStatus,
  normalizeShopRecord,
  sanitizeShop,
};
