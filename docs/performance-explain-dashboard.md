# Dashboard EXPLAIN 分析与索引方案设计

## 基线

| 项 | 值 |
|----|-----|
| 稳定版本 | `prod-dashboard-curdate-v1` |
| 审计分支 | `feature/dashboard-performance-audit` |
| 本阶段分支 | `feature/dashboard-performance-explain` |
| 关联审计 | [performance-audit-dashboard.md](./performance-audit-dashboard.md) |

**说明**：本文档仅生成可在服务器执行的 `EXPLAIN` SQL，**不在 Cursor 环境连接数据库执行**。执行前请替换占位变量。

---

## 1. 当前慢接口优先级

| 优先级 | 接口 | 后端入口 | sqlTag（慢日志） |
|--------|------|----------|------------------|
| **P0** | `GET /api/dashboard/gmv-compare` | `gmvCompareQuery.queryDashboardGmvCompare` | `gmv_compare_total_pipeline` / `gmv_compare_fetch_*` / `gmv_compare_snap_*` |
| **P1** | `GET /api/dashboard/product-ranking` | `productRankingQuery.queryDashboardProductRanking` | `product_ranking_items_join_group` |
| **P1** | `GET /api/dashboard/ranking` | `rankingQuery.queryDashboardRanking` | `ranking_shop_currency_group` |
| **P2** | `GET /api/dashboard/order-volume` | `trendQuery.queryDashboardTrend`（`logEndpoint=order-volume`） | `trend_hour_dateformat_group` / `trend_date_group` |
| **P2** | `GET /api/dashboard/summary` | `usdGmv.queryDashboardGmvUsd` | `summary_orders_count_and_gmv_group` |
| **P3** | `GET /api/dashboard/orders` | `ordersQuery.queryDashboardRealtimeOrders` | `realtime_orders_limit` |

统一 WHERE：`filterContract.buildDashboardWhere`（**禁止在本阶段修改**）。

---

## 2. 公共 WHERE 片段（与线上一致）

### 2.1 事件时间表达式（固定）

```sql
COALESCE(o.paid_at, o.created_at_platform, o.created_at)
```

### 2.2 时间窗（`timeRange=today`，prod 验收口径）

```sql
AND DATE(COALESCE(o.paid_at, o.created_at_platform, o.created_at)) = CURDATE()
```

`timeRange=yesterday`：

```sql
AND DATE(COALESCE(o.paid_at, o.created_at_platform, o.created_at)) = DATE_SUB(CURDATE(), INTERVAL 1 DAY)
```

`timeRange=last7`：

```sql
AND DATE(COALESCE(o.paid_at, o.created_at_platform, o.created_at)) >= DATE_SUB(CURDATE(), INTERVAL 6 DAY)
AND DATE(COALESCE(o.paid_at, o.created_at_platform, o.created_at)) <= CURDATE()
```

### 2.3 租户 / 市场 / 店铺（按需叠加）

```sql
-- 必选（SaaS dashboard，skipTenant=false）
AND o.tenant_id = @tenant_id

-- market=TH（market=ALL 时省略）
AND UPPER(COALESCE(NULLIF(TRIM(o.market), ''), '')) = 'TH'

-- shopId=具体店铺（shopId=all 时省略）
AND o.shop_id = @shop_id
```

### 2.4 orderFilter（与 `orderFilter.js` 一致）

| orderFilter | SQL 行为 |
|-------------|----------|
| `all` | 无额外状态条件 |
| `valid` | `NOT cancelled` + `NOT sample` + `TRIM(order_status) IN (...)` |
| `unpaid` | `TRIM(order_status) IN (...)` 未付款枚举 |
| `sample` | `sqlSamplePredicate(o)` |
| `cancelled` | `sqlCancelledPredicate(o)` |

**valid 示例 IN 列表**（应用层由 `VALID_CANON` 展开，EXPLAIN 可用下列代表值）：

```sql
AND TRIM(o.order_status) IN (
  'awaiting_shipment','awaiting_collection','partially_shipping','in_transit',
  'delivered','completed','paid','shipped','ready_to_ship','partially_shipped',
  'awaiting_package','to_ship'
)
-- 且 NOT (cancelled_predicate) AND NOT (sample_predicate)
-- 完整谓词见 backend/lib/orderFilter.js mysqlOrdersFilterClause('valid')
```

---

## 3. 服务器执行前准备

```sql
-- 在 staging / prod 只读账号下执行
USE daping_staging;   -- 或实际库名

SET @tenant_id = 1;           -- 替换为验收租户
SET @shop_id = 10;            -- 单店 EXPLAIN 时使用；全店可注释 shop 条件
SET @market = 'TH';           -- 全市场时去掉 market 条件

-- 建议记录
SELECT @@hostname, DATABASE(), CURDATE(), NOW();
SHOW INDEX FROM orders;
SHOW INDEX FROM order_items;
```

**建议每条 EXPLAIN 后记录**：

- `query_cost`
- `rows_examined` / `rows`（版本差异）
- `type`（`ALL` / `range` / `ref`）
- `key` / `possible_keys`
- `Extra`（`Using temporary` / `Using filesort`）

---

## 4. 每个接口的 EXPLAIN SQL

以下默认：**`timeRange=today`**、**`orderFilter=all`**、**`market=ALL`**、**`shopId=all`**、**`tenant_id=@tenant_id`**。  
筛选变体在每节末尾用 `-- VARIANT` 标注。

---

### P0 — `GET /api/dashboard/gmv-compare`

一次请求含 **4 条** 主 SQL（`groupBy=hour` + `timeRange=today`）。应用层另做内存分桶，EXPLAIN 仅覆盖 DB 部分。

#### 4.1 今日行级拉取（`fetchOrderRows` / `gmv_compare_fetch_today_rows`）

```sql
EXPLAIN FORMAT=JSON
SELECT
  COALESCE(o.paid_at, o.created_at_platform, o.created_at) AS ts,
  o.total_amount AS total_amount,
  UPPER(COALESCE(NULLIF(TRIM(o.currency), ''), '')) AS currency_key,
  UPPER(COALESCE(NULLIF(TRIM(o.market), ''), '')) AS market
FROM orders o
WHERE 1=1
  AND (o.tenant_id = @tenant_id)
  AND (DATE(COALESCE(o.paid_at, o.created_at_platform, o.created_at)) = CURDATE());
```

#### 4.2 昨日对比行级拉取（`gmv_compare_fetch_yesterday_rows`）

```sql
EXPLAIN FORMAT=JSON
SELECT
  COALESCE(o.paid_at, o.created_at_platform, o.created_at) AS ts,
  o.total_amount AS total_amount,
  UPPER(COALESCE(NULLIF(TRIM(o.currency), ''), '')) AS currency_key,
  UPPER(COALESCE(NULLIF(TRIM(o.market), ''), '')) AS market
FROM orders o
WHERE 1=1
  AND (o.tenant_id = @tenant_id)
  AND (DATE(COALESCE(o.paid_at, o.created_at_platform, o.created_at)) = DATE_SUB(CURDATE(), INTERVAL 1 DAY));
```

#### 4.3 今日 GMV 快照（`gmv_compare_snap_today` — 同 summary）

```sql
EXPLAIN FORMAT=JSON
SELECT COUNT(DISTINCT o.platform_order_id) AS orders,
       COUNT(DISTINCT o.shop_id) AS shop_count
FROM orders o
WHERE 1=1
  AND (o.tenant_id = @tenant_id)
  AND (DATE(COALESCE(o.paid_at, o.created_at_platform, o.created_at)) = CURDATE());
```

```sql
EXPLAIN FORMAT=JSON
SELECT
  UPPER(COALESCE(NULLIF(TRIM(o.currency), ''), '')) AS line_currency,
  UPPER(COALESCE(NULLIF(TRIM(o.market), ''), '')) AS market,
  COALESCE(SUM(o.total_amount), 0) AS gmv_native
FROM orders o
WHERE 1=1
  AND (o.tenant_id = @tenant_id)
  AND (DATE(COALESCE(o.paid_at, o.created_at_platform, o.created_at)) = CURDATE())
GROUP BY
  UPPER(COALESCE(NULLIF(TRIM(o.currency), ''), '')),
  UPPER(COALESCE(NULLIF(TRIM(o.market), ''), ''));
```

#### 4.4 昨日 GMV 快照（`gmv_compare_snap_yesterday`）

与 4.3 相同，将 `= CURDATE()` 改为 `= DATE_SUB(CURDATE(), INTERVAL 1 DAY)`。

#### P0 VARIANT — `orderFilter=valid`（叠加到 4.1）

在 WHERE 末尾追加（完整谓词以线上 `mysqlOrdersFilterClause` 为准）：

```sql
-- AND NOT (cancelled...) AND NOT (sample...) AND TRIM(o.order_status) IN (...)
```

---

### P1 — `GET /api/dashboard/product-ranking`

```sql
EXPLAIN FORMAT=JSON
SELECT
  IF(
    TRIM(COALESCE(oi.product_id, '')) <> '' AND TRIM(COALESCE(oi.sku_id, '')) <> '',
    CONCAT('id:', oi.product_id, CHAR(31), oi.sku_id),
    CONCAT('nm:', LEFT(COALESCE(oi.product_name, ''), 64), CHAR(31), LEFT(COALESCE(oi.sku_name, ''), 64))
  ) AS grp_key,
  MAX(COALESCE(oi.product_name, '')) AS product_name,
  MAX(COALESCE(oi.sku_name, '')) AS sku_name,
  SUM(oi.quantity) AS qty,
  SUM(oi.total_amount) AS gmv_native,
  COUNT(DISTINCT o.platform_order_id) AS orders,
  UPPER(MAX(COALESCE(NULLIF(TRIM(oi.currency), ''), NULLIF(TRIM(o.currency), ''), ''))) AS line_currency,
  UPPER(MAX(COALESCE(NULLIF(TRIM(o.market), ''), ''))) AS market
FROM order_items oi
INNER JOIN orders o
  ON o.tenant_id = oi.tenant_id
 AND o.platform = oi.platform
 AND o.platform_order_id = oi.platform_order_id
WHERE oi.tenant_id = @tenant_id
  AND (o.tenant_id = @tenant_id)
  AND (DATE(COALESCE(o.paid_at, o.created_at_platform, o.created_at)) = CURDATE())
GROUP BY
  IF(
    TRIM(COALESCE(oi.product_id, '')) <> '' AND TRIM(COALESCE(oi.sku_id, '')) <> '',
    CONCAT('id:', oi.product_id, CHAR(31), oi.sku_id),
    CONCAT('nm:', LEFT(COALESCE(oi.product_name, ''), 64), CHAR(31), LEFT(COALESCE(oi.sku_name, ''), 64))
  ),
  UPPER(COALESCE(NULLIF(TRIM(oi.currency), ''), NULLIF(TRIM(o.currency), ''), '')),
  UPPER(COALESCE(NULLIF(TRIM(o.market), ''), ''))
ORDER BY SUM(oi.quantity) DESC
LIMIT 500;
```

**VARIANT `orderFilter=valid`**：在 `o` 表条件上叠加 valid 谓词（见 §2.4）。

---

### P1 — `GET /api/dashboard/ranking`

```sql
EXPLAIN FORMAT=JSON
SELECT
  o.shop_id AS shop_id,
  MAX(COALESCE(s.shop_name, o.shop_name, '')) AS shop_name,
  UPPER(MAX(COALESCE(s.market, o.market, ''))) AS market,
  UPPER(COALESCE(NULLIF(TRIM(o.currency), ''), '')) AS line_currency,
  COUNT(DISTINCT o.platform_order_id) AS orders,
  COALESCE(SUM(o.total_amount), 0) AS gmv_native
FROM orders o
LEFT JOIN shops s ON s.id = o.shop_id AND s.tenant_id = o.tenant_id
WHERE 1=1
  AND (o.tenant_id = @tenant_id)
  AND (DATE(COALESCE(o.paid_at, o.created_at_platform, o.created_at)) = CURDATE())
GROUP BY o.shop_id,
  UPPER(COALESCE(NULLIF(TRIM(o.currency), ''), '')),
  UPPER(COALESCE(NULLIF(TRIM(o.market), ''), ''));
```

应用层再按 GMV/orders 排序后 `slice(limit)`（默认 30），**SQL 无 LIMIT**。

---

### P2 — `GET /api/dashboard/order-volume`

`timeRange=today` 时 `groupBy=hour`（默认）：

```sql
EXPLAIN FORMAT=JSON
SELECT
  DATE_FORMAT(COALESCE(o.paid_at, o.created_at_platform, o.created_at), '%Y-%m-%d %H:00:00') AS time,
  UPPER(COALESCE(NULLIF(TRIM(o.currency), ''), '')) AS line_currency,
  UPPER(COALESCE(NULLIF(TRIM(o.market), ''), '')) AS market,
  COUNT(DISTINCT o.platform_order_id) AS orders,
  COALESCE(SUM(o.total_amount), 0) AS gmv_native
FROM orders o
WHERE 1=1
  AND (o.tenant_id = @tenant_id)
  AND (DATE(COALESCE(o.paid_at, o.created_at_platform, o.created_at)) = CURDATE())
GROUP BY DATE_FORMAT(COALESCE(o.paid_at, o.created_at_platform, o.created_at), '%Y-%m-%d %H:00:00'),
  UPPER(COALESCE(NULLIF(TRIM(o.currency), ''), '')),
  UPPER(COALESCE(NULLIF(TRIM(o.market), ''), ''))
ORDER BY time ASC;
```

**VARIANT `timeRange=last7`**（`groupBy=day`）：

```sql
-- 时间条件改为 last7；bucket 改为 DATE(COALESCE(...))
EXPLAIN FORMAT=JSON
SELECT
  DATE(COALESCE(o.paid_at, o.created_at_platform, o.created_at)) AS time,
  UPPER(COALESCE(NULLIF(TRIM(o.currency), ''), '')) AS line_currency,
  UPPER(COALESCE(NULLIF(TRIM(o.market), ''), '')) AS market,
  COUNT(DISTINCT o.platform_order_id) AS orders,
  COALESCE(SUM(o.total_amount), 0) AS gmv_native
FROM orders o
WHERE 1=1
  AND (o.tenant_id = @tenant_id)
  AND (DATE(COALESCE(o.paid_at, o.created_at_platform, o.created_at)) >= DATE_SUB(CURDATE(), INTERVAL 6 DAY))
  AND (DATE(COALESCE(o.paid_at, o.created_at_platform, o.created_at)) <= CURDATE())
GROUP BY DATE(COALESCE(o.paid_at, o.created_at_platform, o.created_at)),
  UPPER(COALESCE(NULLIF(TRIM(o.currency), ''), '')),
  UPPER(COALESCE(NULLIF(TRIM(o.market), ''), ''))
ORDER BY time ASC;
```

---

### P2 — `GET /api/dashboard/summary`

与 gmv-compare snap 相同（两条 SQL）：

```sql
EXPLAIN FORMAT=JSON
SELECT COUNT(DISTINCT o.platform_order_id) AS orders,
       COUNT(DISTINCT o.shop_id) AS shop_count
FROM orders o
WHERE 1=1
  AND (o.tenant_id = @tenant_id)
  AND (DATE(COALESCE(o.paid_at, o.created_at_platform, o.created_at)) = CURDATE());

EXPLAIN FORMAT=JSON
SELECT
  UPPER(COALESCE(NULLIF(TRIM(o.currency), ''), '')) AS line_currency,
  UPPER(COALESCE(NULLIF(TRIM(o.market), ''), '')) AS market,
  COALESCE(SUM(o.total_amount), 0) AS gmv_native
FROM orders o
WHERE 1=1
  AND (o.tenant_id = @tenant_id)
  AND (DATE(COALESCE(o.paid_at, o.created_at_platform, o.created_at)) = CURDATE())
GROUP BY
  UPPER(COALESCE(NULLIF(TRIM(o.currency), ''), '')),
  UPPER(COALESCE(NULLIF(TRIM(o.market), ''), ''));
```

---

### P3 — `GET /api/dashboard/orders`

```sql
EXPLAIN FORMAT=JSON
SELECT
  o.platform_order_id,
  o.shop_id AS shop_id,
  COALESCE(NULLIF(TRIM(o.shop_name), ''), NULLIF(TRIM(s.shop_name), ''), '') AS shop_name,
  UPPER(COALESCE(NULLIF(TRIM(o.market), ''), NULLIF(TRIM(s.market), ''), '')) AS market,
  UPPER(COALESCE(NULLIF(TRIM(o.currency), ''), '')) AS currency,
  o.total_amount AS amount,
  COALESCE(oi_sum.line_qty, 0) AS items,
  o.created_at_platform AS created_at_platform,
  o.analytics_status AS analytics_status
FROM orders o
LEFT JOIN shops s ON s.id = o.shop_id AND s.tenant_id = o.tenant_id
LEFT JOIN (
  SELECT tenant_id, platform, platform_order_id, SUM(quantity) AS line_qty
  FROM order_items
  WHERE tenant_id = @tenant_id
  GROUP BY tenant_id, platform, platform_order_id
) oi_sum
  ON oi_sum.tenant_id = o.tenant_id
 AND oi_sum.platform = o.platform
 AND oi_sum.platform_order_id = o.platform_order_id
WHERE 1=1
  AND (o.tenant_id = @tenant_id)
  AND (DATE(COALESCE(o.paid_at, o.created_at_platform, o.created_at)) = CURDATE())
ORDER BY COALESCE(o.created_at_platform, o.created_at) DESC
LIMIT 50;
```

---

## 5. EXPLAIN 结果判读要点（预期）

| 现象 | 可能原因 | 关联接口 |
|------|----------|----------|
| `type=ALL` on `orders` | `DATE(COALESCE(...))` 无法利用 `idx_orders_created` | 全部 |
| `rows_examined` 接近租户全表 | 缺少 `(tenant_id, event_date)` 类索引 | P0/P1/P2 |
| `Using temporary` + `Using filesort` | 多列 GROUP BY / ORDER BY | ranking, product-ranking, order-volume |
| `DATE_FORMAT` 分组 | 表达式非索引列 | order-volume (hour) |
| JOIN `order_items` 驱动表错误 | 缺 `(tenant_id, platform, platform_order_id)` | product-ranking |
| 子查询 `oi_sum` 全表扫 | `order_items` 仅 `tenant_id` 过滤 | orders |

---

## 6. 索引方案设计（仅方案，本阶段不执行 migration）

> 仓库已有草案：`backend/db/indexes/dashboard-orders-trend.sql`（**未纳入本阶段自动执行**）。

### 6.1 方案 A — 复合索引（低风险，优先 staging 验证）

```sql
-- orders：租户 + 事件时间列（仍无法消除 DATE() 包裹，但可缩小 tenant 范围后 filter）
CREATE INDEX idx_orders_tenant_event_time
  ON orders (tenant_id, paid_at, created_at_platform, created_at);

CREATE INDEX idx_orders_tenant_market_shop
  ON orders (tenant_id, market, shop_id);

-- order_items：JOIN 与排行
CREATE INDEX idx_order_items_tenant_platform_order
  ON order_items (tenant_id, platform, platform_order_id);
```

**适用**：P1 ranking、P3 orders、P0 行级拉取（tenant 过滤后 rows 下降）。

**局限**：`DATE(COALESCE(...))` 仍可能对三列做函数计算，优化器未必走时间索引。

### 6.2 方案 B — 生成列 + 索引（推荐，需 migration）

```sql
-- 示例 DDL（需在维护窗评估锁表与回填）
ALTER TABLE orders
  ADD COLUMN event_at DATETIME(3) AS (
    COALESCE(paid_at, created_at_platform, created_at)
  ) STORED,
  ADD COLUMN event_date DATE AS (DATE(COALESCE(paid_at, created_at_platform, created_at))) STORED;

CREATE INDEX idx_orders_tenant_event_date_shop
  ON orders (tenant_id, event_date, shop_id);

CREATE INDEX idx_orders_tenant_event_date_market
  ON orders (tenant_id, event_date, market);
```

**WHERE 可改写为（未来阶段，非本阶段）**：

```sql
AND o.event_date = CURDATE()
```

**适用**：P0/P1/P2 所有 `DATE(COALESCE(...))` 查询；与 prod 验收口径一致。

### 6.3 方案 C — 小时聚合表（中长期）

```text
dashboard_order_hourly_agg (
  tenant_id, shop_id, market, stat_date, hour,
  order_filter_bucket,  -- 或拆多列 valid_cnt / all_cnt
  orders, gmv_native, ...
)
```

**适用**：P0 gmv-compare、P2 order-volume；写入由同步任务完成，读路径 O(桶数)。

### 6.4 方案与接口映射

| 接口 | 方案 A | 方案 B | 方案 C |
|------|--------|--------|--------|
| gmv-compare | 部分 | **高** | **最高** |
| product-ranking | JOIN 改善 | **高** | 中 |
| ranking | 部分 | **高** | 中 |
| order-volume | 弱 | **高**（避免 DATE_FORMAT） | **最高** |
| summary | 部分 | **高** | 中 |
| orders | 部分 | **高** | 低 |

---

## 7. staging 验证清单（人工）

1. 执行 §3 `SHOW INDEX`，记录执行前索引。
2. 对 §4 每条 SQL 跑 `EXPLAIN FORMAT=JSON`，保存 JSON 到工单。
3. 在 **staging** 仅执行方案 A（若 DBA 批准），重复 EXPLAIN 对比。
4. 对比慢日志 `[dashboard-contract] slow` 的 `durationMs`（同 tenant、同 `orderFilter`）。
5. 确认业务数字仍与 prod 验收一致（今日/昨日订单数）。

---

## 8. 本阶段交付

| 项 | 状态 |
|----|------|
| 分支 `feature/dashboard-performance-explain` | 已创建 |
| `docs/performance-explain-dashboard.md` | 本文档 |
| 修改业务 SQL / API | **否** |
| 执行 migration | **否** |
| 服务器 EXPLAIN 结果 | **待运维回填** |

---

## 9. 附录：代码索引

| 接口 | 文件 | 函数 |
|------|------|------|
| summary | `modules/dashboard/usdGmv.js` | `queryDashboardGmvUsd` |
| gmv-compare | `modules/dashboard/gmvCompareQuery.js` | `queryDashboardGmvCompare`, `fetchOrderRows` |
| ranking | `modules/dashboard/rankingQuery.js` | `queryDashboardRanking` |
| product-ranking | `modules/dashboard/productRankingQuery.js` | `queryDashboardProductRanking` |
| order-volume | `modules/dashboard/trendQuery.js` | `queryDashboardTrend` |
| orders | `modules/dashboard/ordersQuery.js` | `queryDashboardRealtimeOrders` |
| WHERE 契约 | `modules/dashboard/filterContract.js` | `buildDashboardWhere`, `buildDateRangeWhere` |
| orderFilter | `lib/orderFilter.js` | `mysqlOrdersFilterClause` |
