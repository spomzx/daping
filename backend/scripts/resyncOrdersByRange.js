#!/usr/bin/env node
'use strict';

/**
 * 补同步：按店铺 + 市场 + 日期区间重新拉取 TikTok 订单，并 UPSERT 到 MySQL orders 表。
 *
 * 用法：
 *   node backend/scripts/resyncOrdersByRange.js --shopName="CQ Chic Jewelry" --market=TH --from=2026-05-26 --to=2026-05-27
 *
 * 输出统计：
 *   fetched / inserted / updated / skipped / errors
 *
 * 说明：
 * - 禁止 truncate / delete，本脚本只做 INSERT ... ON DUPLICATE KEY UPDATE（复用现有入库服务）。
 * - created_at_platform 区间按市场本地自然日换算为 TikTok OpenAPI create_time_ge/create_time_lt（UTC epoch 秒）。
 * - 为降低单次分页上限影响（orders.js 内 maxPages=20），脚本按“天”切分请求。
 */

require('../loadEnv');

const dayjs = require('dayjs');
const { getMysqlPool } = require('../db/mysqlPool');
const { fetchOrdersInTimeRange, getMarketOffsetHours } = require('../tiktok-api/orders');
const { persistOrdersFromCache } = require('../modules/orders/orderPersistenceService');

function parseArgs(argv) {
  const out = {};
  for (const raw of argv.slice(2)) {
    if (!raw.startsWith('--')) continue;
    const body = raw.slice(2);
    const eq = body.indexOf('=');
    if (eq >= 0) {
      const k = body.slice(0, eq).trim();
      let v = body.slice(eq + 1);
      if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
      if (v.startsWith("'") && v.endsWith("'")) v = v.slice(1, -1);
      out[k] = v;
    } else {
      out[body.trim()] = true;
    }
  }
  return out;
}

function requireYmd(s, label) {
  const v = String(s || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    throw new Error(`${label}_must_be_yyyy_mm_dd`);
  }
  return v;
}

function normMarket(m) {
  return String(m || '').trim().toUpperCase();
}

function extractShopCipher(rawAuthJson) {
  if (!rawAuthJson) return '';
  if (typeof rawAuthJson === 'object') {
    return String(rawAuthJson.shop_cipher || rawAuthJson.shopCipher || '').trim();
  }
  try {
    const o = JSON.parse(String(rawAuthJson));
    return String(o?.shop_cipher || o?.shopCipher || '').trim();
  } catch {
    return '';
  }
}

async function findShop(pool, shopName, market) {
  const name = String(shopName || '').trim();
  const mk = normMarket(market);
  if (!name) throw new Error('missing_shopName');
  if (!mk) throw new Error('missing_market');

  const baseSql = `
    SELECT
      s.id AS internal_shop_id,
      s.tenant_id,
      s.platform,
      s.platform_shop_id,
      s.shop_name,
      s.display_name,
      COALESCE(s.market, s.region, '') AS market,
      t.access_token,
      t.refresh_token,
      t.token_expire_at,
      t.refresh_token_expire_at,
      t.scope_json,
      t.raw_auth_json
    FROM shops s
    INNER JOIN shop_auth_tokens t ON t.id = (
      SELECT t2.id FROM shop_auth_tokens t2 WHERE t2.shop_id = s.id ORDER BY t2.id DESC LIMIT 1
    )
    WHERE s.platform = 'tiktok'
      AND s.status = 'active'
      AND UPPER(TRIM(COALESCE(s.market, s.region, ''))) = ?
  `;

  // 先尝试精确匹配（display_name / shop_name）
  {
    const [rows] = await pool.query(
      `${baseSql}
       AND (TRIM(s.display_name) = ? OR TRIM(s.shop_name) = ?)
       ORDER BY s.id DESC
       LIMIT 5`,
      [mk, name, name],
    );
    if (Array.isArray(rows) && rows.length > 0) return { hit: rows[0], candidates: rows };
  }

  // 再尝试模糊匹配
  {
    const like = `%${name}%`;
    const [rows] = await pool.query(
      `${baseSql}
       AND (s.display_name LIKE ? OR s.shop_name LIKE ?)
       ORDER BY s.id DESC
       LIMIT 10`,
      [mk, like, like],
    );
    if (Array.isArray(rows) && rows.length > 0) return { hit: rows[0], candidates: rows };
  }

  return { hit: null, candidates: [] };
}

async function countOrdersInRange(pool, internalShopId, startMs, endMs) {
  const start = dayjs(startMs).format('YYYY-MM-DD HH:mm:ss.SSS');
  const end = dayjs(endMs).format('YYYY-MM-DD HH:mm:ss.SSS');
  const [rows] = await pool.query(
    `SELECT COUNT(*) AS c
     FROM orders
     WHERE platform = 'tiktok'
       AND shop_id = ?
       AND created_at_platform >= ?
       AND created_at_platform < ?`,
    [Number(internalShopId), start, end],
  );
  return Number(rows?.[0]?.c) || 0;
}

function eachDayInclusive(fromYmd, toYmd) {
  const start = dayjs(fromYmd, 'YYYY-MM-DD', true);
  const end = dayjs(toYmd, 'YYYY-MM-DD', true);
  if (!start.isValid() || !end.isValid()) throw new Error('invalid_date_range');
  if (end.isBefore(start)) throw new Error('to_must_be_gte_from');
  const out = [];
  let cur = start;
  while (cur.isSame(end) || cur.isBefore(end)) {
    out.push(cur.format('YYYY-MM-DD'));
    cur = cur.add(1, 'day');
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help || args.h) {
    console.log(
      [
        'Usage:',
        '  node backend/scripts/resyncOrdersByRange.js --shopName="CQ Chic Jewelry" --market=TH --from=2026-05-26 --to=2026-05-27',
        '',
        'Notes:',
        '  - market: TH|MY|PH|VN|SG ...（以 shops.market 为准）',
        '  - from/to: YYYY-MM-DD（按市场本地自然日换算为 created_at_platform 区间）',
      ].join('\n'),
    );
    return;
  }
  const shopName = String(args.shopName || args.shop_name || '').trim();
  const market = normMarket(args.market || args.region);
  const from = requireYmd(args.from, 'from');
  const to = requireYmd(args.to, 'to');

  const pool = getMysqlPool();
  if (!pool) throw new Error('mysql_pool_missing');

  const { hit, candidates } = await findShop(pool, shopName, market);
  if (!hit) {
    console.error('[resync-orders] shop not found', { shopName, market });
    process.exitCode = 2;
    return;
  }

  if (Array.isArray(candidates) && candidates.length > 1) {
    console.warn(
      '[resync-orders] multiple shop candidates, choose latest id',
      candidates.map((c) => ({
        id: Number(c.internal_shop_id),
        tenant_id: Number(c.tenant_id),
        platform_shop_id: String(c.platform_shop_id || ''),
        display_name: String(c.display_name || ''),
        shop_name: String(c.shop_name || ''),
        market: String(c.market || ''),
      })),
    );
  }

  const internalShopId = Number(hit.internal_shop_id);
  const tenantId = Number(hit.tenant_id);
  const platformShopId = String(hit.platform_shop_id || '').trim();
  const shopDisplayName = String(hit.display_name || hit.shop_name || platformShopId).trim();
  const shopMarket = normMarket(hit.market);
  const accessToken = String(hit.access_token || '').trim();
  const refreshToken = String(hit.refresh_token || '').trim();
  const shopCipher = extractShopCipher(hit.raw_auth_json);

  if (!Number.isFinite(internalShopId) || internalShopId <= 0) throw new Error('shop_internal_id_invalid');
  if (!Number.isFinite(tenantId) || tenantId <= 0) throw new Error('shop_tenant_id_invalid');
  if (!platformShopId) throw new Error('shop_platform_shop_id_missing');
  if (!shopMarket) throw new Error('shop_market_missing');
  if (!shopCipher) throw new Error('shop_cipher_missing');
  if (!accessToken) throw new Error('access_token_missing');

  const offsetHours = getMarketOffsetHours(shopMarket);
  const startRangeUtcMs = Date.UTC(Number(from.slice(0, 4)), Number(from.slice(5, 7)) - 1, Number(from.slice(8, 10)), 0, 0, 0) - offsetHours * 3600 * 1000;
  const endPlusOneUtcMs = Date.UTC(Number(to.slice(0, 4)), Number(to.slice(5, 7)) - 1, Number(to.slice(8, 10)) + 1, 0, 0, 0) - offsetHours * 3600 * 1000;
  const countBefore = await countOrdersInRange(pool, internalShopId, startRangeUtcMs, endPlusOneUtcMs);

  const shop = {
    internal_shop_id: internalShopId,
    shop_id: internalShopId,
    tenant_id: tenantId,
    platform_shop_id: platformShopId,
    shopId: platformShopId,
    shop_name: shopDisplayName,
    shopName: shopDisplayName,
    market: shopMarket,
    region: shopMarket,
    shop_cipher: shopCipher,
    shopCipher,
    access_token: accessToken,
    refresh_token: refreshToken,
    accessToken,
    refreshToken,
    rawTokenPayload: typeof hit.raw_auth_json === 'object' ? hit.raw_auth_json : null,
  };

  const totals = {
    fetched: 0,
    inserted: 0,
    updated: 0,
    skipped: 0,
    errors: 0,
  };

  console.log('[resync-orders] start', {
    shopName: shopDisplayName,
    market: shopMarket,
    platform_shop_id: platformShopId,
    internal_shop_id: internalShopId,
    tenant_id: tenantId,
    from,
    to,
    offset_hours: offsetHours,
    created_at_platform_range_utc: {
      start: dayjs(startRangeUtcMs).toISOString(),
      end_exclusive: dayjs(endPlusOneUtcMs).toISOString(),
    },
    orders_count_before: countBefore,
  });

  const days = eachDayInclusive(from, to);
  for (const ymd of days) {
    try {
      console.log('[resync-orders] fetch day', { ymd });
      const ret = await fetchOrdersInTimeRange(shop, {
        dateYmd: ymd,
        offsetHours,
        logPrefix: `[resync-orders][${ymd}]`,
        // 防止单次请求无限拖延；可按需要在执行时调大
        deadlineMs: Date.now() + 10 * 60 * 1000,
      });
      if (!ret?.ok) {
        totals.errors += 1;
        console.error('[resync-orders] fetch failed', {
          ymd,
          error: ret?.error || null,
          debug: ret?.debug || null,
        });
        continue;
      }

      const rawOrders = Array.isArray(ret.data) ? ret.data : [];
      totals.fetched += rawOrders.length;

      const persist = await persistOrdersFromCache(rawOrders, {
        shopContext: {
          internal_shop_id: internalShopId,
          platform_shop_id: platformShopId,
          shop_name: shopDisplayName,
          market: shopMarket,
          tenant_id: tenantId,
        },
        preview: false,
        persistDebug: false,
        verifyAfterInsert: false,
      });
      totals.inserted += Number(persist?.inserted || 0);
      // “updated” 合并 updated + updated_unchanged，符合“已存在就更新”的语义
      totals.updated += Number(persist?.updated || 0) + Number(persist?.updated_unchanged || 0);
      totals.skipped += Number(persist?.skipped || 0);

      console.log('[resync-orders] day done', {
        ymd,
        pagesFetched: ret.pagesFetched ?? null,
        uniqueOrders: ret.uniqueOrders ?? null,
        fetched: rawOrders.length,
        inserted: persist?.inserted ?? 0,
        updated: (persist?.updated ?? 0) + (persist?.updated_unchanged ?? 0),
        skipped: persist?.skipped ?? 0,
      });
    } catch (e) {
      totals.errors += 1;
      console.error('[resync-orders] day fatal', { ymd, error: String(e?.message || e) });
    }
  }

  const countAfter = await countOrdersInRange(pool, internalShopId, startRangeUtcMs, endPlusOneUtcMs);
  console.log('[resync-orders] done', {
    fetched: totals.fetched,
    inserted: totals.inserted,
    updated: totals.updated,
    skipped: totals.skipped,
    errors: totals.errors,
    orders_count_before: countBefore,
    orders_count_after: countAfter,
    orders_count_delta: countAfter - countBefore,
  });
}

main().catch((e) => {
  console.error('[resync-orders] fatal', e?.stack || e?.message || e);
  process.exit(1);
});

