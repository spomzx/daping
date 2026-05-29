'use strict';

/**
 * Cavera 查询口径核查（不改同步逻辑�? * 用法：cd backend && node scripts/auditCaveraQueryScope.js [platform_order_id]
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../', '.env') });

const fs = require('fs');
const path = require('path');
const { getMysqlPool } = require('../../db/mysqlPool');
const { orderAnalyticsEventTimeExpr } = require('../../lib/analyticsFilter');
const { readShops, shopCipherString } = require('../../tiktok-api/shops');
const { loadOpenApiSyncStateByPlatformShopId } = require('../../modules/shops/shopHealthService');

const PLATFORM_ID = '7496312889470388950';
const EVT = orderAnalyticsEventTimeExpr('o');

async function q(pool, label, sql, params = []) {
  const [rows] = await pool.query(sql, params);
  console.log(`\n=== ${label} ===`);
  console.log(JSON.stringify(rows, null, 2));
  return rows;
}

function classify(ctx) {
  const reasons = [];
  let code = 'unknown';

  if (ctx.wrong_query_used_platform_id_on_orders_shop_id) {
    reasons.push('人工 SQL �?orders.shop_id �?platform_shop_id 比较（orders.shop_id 应为 shops.id�?);
    code = 'query_wrong';
  }

  if (ctx.cavera_all_time > 0 && ctx.cavera_24h_by_correct_join === 0) {
    reasons.push(`Cavera 全量 ${ctx.cavera_all_time} 单，但滚�?24h �?0；最新单 ${ctx.cavera_latest || 'null'}`);
    if (ctx.cavera_today_natural > 0 || ctx.cavera_today_platform_field > 0) {
      code = 'time_window_mismatch';
      reasons.push('自然�?created_at_platform 今日有单，与滚动 24h 不一�?);
    } else if (ctx.th_24h_total > 0 && ctx.cavera_24h_by_correct_join === 0) {
      if (code === 'query_wrong') code = 'query_wrong';
      else code = code === 'unknown' ? 'mysql_no_orders' : code;
      reasons.push('TH 24h 有单但均�?Cavera 正确 JOIN');
    }
  }

  if (ctx.th_24h_total > 0 && ctx.cavera_24h_by_correct_join === 0 && !ctx.wrong_query_hit_cavera) {
    if (ctx.th_24h_only_cq_chic) {
      code = 'shop_mapping_wrong';
      reasons.push('TH 24h 订单仅落�?CQ Chic 相关 shop_name/shop_id');
    }
  }

  if (ctx.cavera_all_time === 0 && ctx.wrong_query_hit_cavera > 0) {
    code = 'query_wrong';
    reasons.push('错误口径 shop_id=platform_shop_id 曾命中行，正�?JOIN 无单');
  }

  if (ctx.cavera_all_time === 0 && ctx.th_24h_total > 0) {
    if (code === 'unknown') code = 'mysql_no_orders';
    reasons.push('MySQL �?Cavera 历史单；TH 今日单在他店');
  }

  const jsonShop = readShops().find((s) => String(s.shopId || '').trim() === PLATFORM_ID);
  const sync = loadOpenApiSyncStateByPlatformShopId().get(PLATFORM_ID.toLowerCase());
  if (!jsonShop) {
    reasons.push('shops.json �?Cavera');
    if (code === 'mysql_no_orders' || code === 'shop_mapping_wrong') code = 'sync_missing_shop';
  } else if (!shopCipherString(jsonShop)) {
    reasons.push('shops.json �?Cavera �?shop_cipher');
  } else if (sync && sync.lastSyncOk === false) {
    reasons.push(`OpenAPI 最近同步失�? ${sync.lastSyncError || '?'}`);
  }

  return { code, reasons };
}

async function main() {
  const pool = getMysqlPool();
  if (!pool) {
    console.error('MySQL unavailable �?请在 staging 执行本脚�?);
    process.exit(1);
  }

  const tiktokOrderId = process.argv[2] ? String(process.argv[2]).trim() : null;

  console.log('=== SCHEMA NOTE ===');
  console.log(
    JSON.stringify(
      {
        shops_has_shop_id_column: false,
        shops_pk: 'shops.id (BIGINT AUTO_INCREMENT)',
        shops_platform_key: 'shops.platform_shop_id (TikTok 店铺 ID)',
        orders_shop_id_fk: 'orders.shop_id -> shops.id (NOT platform_shop_id)',
        analytics_time_expr: EVT,
        server_now: new Date().toISOString(),
      },
      null,
      2,
    ),
  );

  const shopFull = await q(
    pool,
    '1. SHOPS �?Cavera 完整记录',
    `SELECT
       s.id,
       s.tenant_id,
       s.platform,
       s.platform_shop_id,
       s.shop_name,
       s.display_name,
       s.market,
       s.region,
       s.currency,
       s.sync_enabled,
       s.hidden,
       s.status,
       s.auth_status,
       s.last_sync_at,
       s.created_at,
       s.updated_at,
       (SELECT JSON_UNQUOTE(JSON_EXTRACT(t.raw_auth_json, '$.shop_cipher'))
        FROM shop_auth_tokens t
        WHERE t.shop_id = s.id
        ORDER BY t.id DESC LIMIT 1) AS shop_cipher_from_auth
     FROM shops s
     WHERE s.shop_name LIKE '%Cavera%'
        OR LOWER(TRIM(s.platform_shop_id)) = ?
        OR s.id = CAST(? AS UNSIGNED)`,
    [PLATFORM_ID.toLowerCase(), PLATFORM_ID],
  );

  const internalId = shopFull[0] ? Number(shopFull[0].id) : null;

  await q(
    pool,
    '1b. 错误口径演示 �?shop_id = platform_shop_id（勿用于生产�?,
    `SELECT COUNT(*) AS cnt_wrong
     FROM orders
     WHERE shop_id = CAST(? AS UNSIGNED)
        OR shop_name LIKE '%Cavera%'`,
    [PLATFORM_ID],
  );

  await q(
    pool,
    '1c. 正确口径 �?orders.shop_id = shops.id',
    `SELECT COUNT(*) AS cnt_correct
     FROM orders o
     INNER JOIN shops s ON s.id = o.shop_id
     WHERE LOWER(TRIM(s.platform_shop_id)) = ?`,
    [PLATFORM_ID.toLowerCase()],
  );

  await q(
    pool,
    '2. TH 24h JOIN 验证（含错误 OR CAST 分支�?,
    `SELECT
       o.shop_id AS order_shop_id,
       s.id AS shops_id,
       s.platform_shop_id,
       s.shop_name AS shops_name,
       o.shop_name AS order_shop_name,
       o.market,
       COUNT(*) AS cnt,
       SUM(o.total_amount) AS gmv,
       MAX(${EVT}) AS latest_order_at,
       CASE
         WHEN o.shop_id = s.id THEN 'join_by_shops_id'
         WHEN CAST(o.shop_id AS CHAR) = CAST(s.platform_shop_id AS CHAR) THEN 'join_by_platform_id_cast'
         ELSE 'join_other'
       END AS join_type
     FROM orders o
     LEFT JOIN shops s
       ON o.shop_id = s.id
       OR CAST(o.shop_id AS CHAR) = CAST(s.platform_shop_id AS CHAR)
     WHERE o.market = 'TH'
       AND ${EVT} >= DATE_SUB(NOW(3), INTERVAL 24 HOUR)
     GROUP BY
       o.shop_id, s.id, s.platform_shop_id, s.shop_name, o.shop_name, o.market,
       CASE
         WHEN o.shop_id = s.id THEN 'join_by_shops_id'
         WHEN CAST(o.shop_id AS CHAR) = CAST(s.platform_shop_id AS CHAR) THEN 'join_by_platform_id_cast'
         ELSE 'join_other'
       END
     ORDER BY cnt DESC`,
  );

  const thDist = await q(
    pool,
    '3. TH 24h �?orders.shop_id / shop_name 分布',
    `SELECT
       o.shop_id,
       o.shop_name,
       o.market,
       COUNT(*) AS cnt,
       SUM(o.total_amount) AS gmv,
       MIN(${EVT}) AS first_order_at,
       MAX(${EVT}) AS latest_order_at,
       s.id AS matched_shops_id,
       s.platform_shop_id AS matched_platform_shop_id,
       s.shop_name AS matched_shops_name
     FROM orders o
     LEFT JOIN shops s ON s.id = o.shop_id
     WHERE o.market = 'TH'
       AND ${EVT} >= DATE_SUB(NOW(3), INTERVAL 24 HOUR)
     GROUP BY o.shop_id, o.shop_name, o.market, s.id, s.platform_shop_id, s.shop_name
     ORDER BY cnt DESC`,
  );

  const caveraAll = await q(
    pool,
    '4a. Cavera 全量（正�?JOIN�?,
    `SELECT COUNT(*) AS cnt, SUM(o.total_amount) AS gmv, MAX(${EVT}) AS latest_order_at
     FROM orders o
     INNER JOIN shops s ON s.id = o.shop_id
     WHERE LOWER(TRIM(s.platform_shop_id)) = ?`,
    [PLATFORM_ID.toLowerCase()],
  );

  const cavera24 = await q(
    pool,
    '5a. Cavera �?滚动 24h（正�?JOIN�?,
    `SELECT COUNT(*) AS cnt, SUM(o.total_amount) AS gmv, MAX(${EVT}) AS latest_order_at
     FROM orders o
     INNER JOIN shops s ON s.id = o.shop_id
     WHERE LOWER(TRIM(s.platform_shop_id)) = ?
       AND ${EVT} >= DATE_SUB(NOW(3), INTERVAL 24 HOUR)`,
    [PLATFORM_ID.toLowerCase()],
  );

  const caveraNatural = await q(
    pool,
    '5b. Cavera �?自然�?CURDATE()（会话时区）',
    `SELECT COUNT(*) AS cnt, SUM(o.total_amount) AS gmv, MAX(${EVT}) AS latest_order_at
     FROM orders o
     INNER JOIN shops s ON s.id = o.shop_id
     WHERE LOWER(TRIM(s.platform_shop_id)) = ?
       AND DATE(${EVT}) = CURDATE()`,
    [PLATFORM_ID.toLowerCase()],
  );

  const caveraPlatformDay = await q(
    pool,
    '5c. Cavera �?DATE(created_at_platform)=CURDATE()',
    `SELECT COUNT(*) AS cnt, SUM(o.total_amount) AS gmv, MAX(created_at_platform) AS latest_order_at
     FROM orders o
     INNER JOIN shops s ON s.id = o.shop_id
     WHERE LOWER(TRIM(s.platform_shop_id)) = ?
       AND created_at_platform IS NOT NULL
       AND DATE(created_at_platform) = CURDATE()`,
    [PLATFORM_ID.toLowerCase()],
  );

  const caveraBangkokDay = await q(
    pool,
    '5d. Cavera �?曼谷自然日（�?OpenAPI TH 一致）',
    `SELECT COUNT(*) AS cnt, SUM(o.total_amount) AS gmv, MAX(${EVT}) AS latest_order_at
     FROM orders o
     INNER JOIN shops s ON s.id = o.shop_id
     WHERE LOWER(TRIM(s.platform_shop_id)) = ?
       AND DATE(CONVERT_TZ(${EVT}, '+00:00', '+07:00')) = DATE(CONVERT_TZ(NOW(), @@session.time_zone, '+07:00'))`,
    [PLATFORM_ID.toLowerCase()],
  );

  if (tiktokOrderId) {
    await q(
      pool,
      '4. platform_order_id 精确查询',
      `SELECT id, platform_order_id, shop_id, shop_name, market, order_status, analytics_status,
              currency, total_amount, created_at_platform, paid_at, created_at, updated_at
       FROM orders WHERE platform_order_id = ?`,
      [tiktokOrderId],
    );
  } else {
    console.log('\n=== 4. platform_order_id ===');
    console.log('未传入订单号；用�? node scripts/auditCaveraQueryScope.js <TikTok订单�?');
  }

  const wrongDemo = await pool.query(
    `SELECT COUNT(*) AS c FROM orders WHERE shop_id = CAST(? AS UNSIGNED)`,
    [PLATFORM_ID],
  );
  const wrongCnt = Number(wrongDemo[0][0]?.c) || 0;

  const thTotal = thDist.reduce((s, r) => s + Number(r.cnt || 0), 0);
  const onlyCq = thDist.length > 0 && thDist.every((r) => /CQ Chic/i.test(String(r.shop_name || r.matched_shops_name || '')));

  const { code, reasons } = classify({
    wrong_query_used_platform_id_on_orders_shop_id: true,
    wrong_query_hit_cavera: wrongCnt,
    cavera_all_time: Number(caveraAll[0]?.cnt) || 0,
    cavera_24h_by_correct_join: Number(cavera24[0]?.cnt) || 0,
    cavera_latest: caveraAll[0]?.latest_order_at,
    cavera_today_natural: Number(caveraNatural[0]?.cnt) || 0,
    cavera_today_platform_field: Number(caveraPlatformDay[0]?.cnt) || 0,
    th_24h_total: thTotal,
    th_24h_only_cq_chic: onlyCq,
  });

  console.log('\n=== 6. 最终分�?===');
  console.log(
    JSON.stringify(
      {
        classification: code,
        reasons,
        internal_shop_id: internalId,
        platform_shop_id: PLATFORM_ID,
        recommended_cavera_filter: internalId
          ? `o.shop_id = ${internalId}  /* shops.id，非 platform_shop_id */`
          : '先确�?shops 表存�?Cavera 记录',
      },
      null,
      2,
    ),
  );

  console.log('\n=== 7. 推荐 SQL（复制到 MySQL�?==');
  console.log(`
-- Cavera 店铺
SELECT id AS internal_shop_id, platform_shop_id, shop_name, market, sync_enabled, status
FROM shops
WHERE LOWER(TRIM(platform_shop_id)) = '${PLATFORM_ID}'
   OR shop_name LIKE '%Cavera%';

-- Cavera 滚动 24h（与 /analytics、店铺管理一致）
SELECT COUNT(*) AS cnt, SUM(total_amount) AS gmv, MAX(${EVT}) AS latest
FROM orders o
INNER JOIN shops s ON s.id = o.shop_id
WHERE LOWER(TRIM(s.platform_shop_id)) = '${PLATFORM_ID}'
  AND ${EVT} >= DATE_SUB(NOW(3), INTERVAL 24 HOUR);

-- 勿用: shop_id = '${PLATFORM_ID}'  （那�?platform_shop_id，不�?orders.shop_id�?`);

  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
