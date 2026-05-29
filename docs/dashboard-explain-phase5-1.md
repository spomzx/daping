# Phase-5.1 Dashboard EXPLAIN 记录

在 **staging** 只读账号执行；替换 `@tenant_id` / `@shop_id` / `@market`。  
索引执行文件：`backend/db/indexes/dashboard-phase5-1.sql`（**仅 staging**）。

## 执行前准备

```sql
USE daping_staging;  -- 实际库名
SET @tenant_id = 1;
SET @shop_id = 10;   -- 全店 EXPLAIN 可注释 shop 条件
SET @market = 'TH';

SELECT @@hostname, DATABASE(), CURDATE(), NOW();
SHOW INDEX FROM orders;
SHOW INDEX FROM order_items;
```

公共时间谓词（`timeRange=today`）：

```sql
AND o.tenant_id = @tenant_id
AND DATE(COALESCE(o.paid_at, o.created_at_platform, o.created_at)) = CURDATE()
```

`orderFilter=valid` 时叠加 `buildOrderFilterWhere` 对应条件（见 `backend/lib/orderFilter.js`）。

---

## 1. gmv_compare_total_pipeline / summary_orders_count_and_gmv_group

```sql
EXPLAIN
SELECT
  UPPER(COALESCE(NULLIF(TRIM(o.currency), ''), '')) AS line_currency,
  UPPER(COALESCE(NULLIF(TRIM(o.market), ''), '')) AS market,
  COALESCE(SUM(o.total_amount), 0) AS gmv_native
FROM orders o
WHERE o.tenant_id = @tenant_id
  AND DATE(COALESCE(o.paid_at, o.created_at_platform, o.created_at)) = CURDATE()
GROUP BY
  UPPER(COALESCE(NULLIF(TRIM(o.currency), ''), '')),
  UPPER(COALESCE(NULLIF(TRIM(o.market), ''), ''));
```

| 阶段 | rows (估) | type | key | possible_keys | Using temporary | Using filesort | 全表扫描 |
|------|-----------|------|-----|---------------|-----------------|----------------|----------|
| **索引前** | 大（10万+ 量级视数据） | range / ALL | 常为 `idx_orders_tenant_event_time` 或 NULL | 现有 tenant/time 索引 | 可能 Yes | 可能 Yes | 可能 Yes（无合适复合索引） |
| **索引后（目标）** | 明显下降 | range | `idx_orders_p51_tenant_status_market_shop_time` 或 `idx_orders_p51_tenant_event_time` | 含 p51 索引 | No | No | No |

---

## 2. gmv_compare_fetch_today（行级曲线，hour 模式）

```sql
EXPLAIN
SELECT
  COALESCE(o.paid_at, o.created_at_platform, o.created_at) AS ts,
  o.platform_order_id,
  o.total_amount,
  UPPER(COALESCE(NULLIF(TRIM(o.currency), ''), '')) AS currency_key,
  UPPER(COALESCE(NULLIF(TRIM(o.market), ''), '')) AS market
FROM orders o
WHERE o.tenant_id = @tenant_id
  AND COALESCE(o.paid_at, o.created_at_platform, o.created_at) >= CURDATE()
  AND COALESCE(o.paid_at, o.created_at_platform, o.created_at) < NOW();
```

| 阶段 | type | key | Extra |
|------|------|-----|-------|
| **索引前** | range / ALL | 单列 tenant 或 time | `Using where`；rows 高 |
| **索引后（目标）** | range | `idx_orders_p51_tenant_event_time` | rows 降；避免 ALL |

---

## 3. trend_hour_dateformat_group（order-volume）

```sql
EXPLAIN
SELECT
  DATE_FORMAT(COALESCE(o.paid_at, o.created_at_platform, o.created_at), '%Y-%m-%d %H:00:00') AS time,
  COUNT(DISTINCT o.platform_order_id) AS orders,
  COALESCE(SUM(o.total_amount), 0) AS gmv_native
FROM orders o
WHERE o.tenant_id = @tenant_id
  AND DATE(COALESCE(o.paid_at, o.created_at_platform, o.created_at)) = CURDATE()
GROUP BY time;
```

| 阶段 | Using temporary | Using filesort | 说明 |
|------|-----------------|----------------|------|
| **索引前** | 常见 Yes | 常见 Yes | `DATE_FORMAT` 导致无法用纯索引覆盖分组 |
| **索引后（目标）** | 仍可能 Yes（表达式分组） | 可能 Yes | 靠 **缩小扫描行数**（tenant+time 复合索引）降低总耗时 |

---

## 4. product_ranking_items_join_group

```sql
EXPLAIN
SELECT
  oi.product_id,
  SUM(oi.quantity) AS qty,
  COALESCE(SUM(oi.quantity * oi.unit_price), 0) AS gmv_native
FROM order_items oi
INNER JOIN orders o ON o.tenant_id = oi.tenant_id
  AND o.platform = oi.platform
  AND o.platform_order_id = oi.platform_order_id
WHERE o.tenant_id = @tenant_id
  AND DATE(COALESCE(o.paid_at, o.created_at_platform, o.created_at)) = CURDATE()
GROUP BY oi.product_id
ORDER BY qty DESC
LIMIT 20;
```

| 阶段 | o 表 type/key | oi 表 type/key |
|------|---------------|----------------|
| **索引前** | range，rows 高 | ALL 或 ref，JOIN 代价大 |
| **索引后（目标）** | `idx_orders_p51_tenant_event_time` | `idx_order_items_p51_tenant_shop_market_order`；ref/eq_ref |

---

## 5. realtime_orders_limit（orders）

```sql
EXPLAIN
SELECT o.platform_order_id, o.shop_id, o.total_amount, o.created_at_platform
FROM orders o
WHERE o.tenant_id = @tenant_id
  AND DATE(COALESCE(o.paid_at, o.created_at_platform, o.created_at)) = CURDATE()
ORDER BY COALESCE(o.created_at_platform, o.created_at) DESC
LIMIT 50;
```

| 阶段 | type | key | Extra |
|------|------|-----|-------|
| **索引前** | range + filesort | tenant/time | `Using filesort` 常见 |
| **索引后（目标）** | range | `idx_orders_p51_tenant_event_time` | 扫描行数减少；filesort 仍可能存在（ORDER BY 表达式） |

---

## 6. 记录模板（staging 实测后填写）

在服务器执行 EXPLAIN 后，将实际输出填入：

```
sqlTag=________________
rows=______ type=______ key=________________
possible_keys=________________
Extra=________________
Using temporary: Y/N  Using filesort: Y/N  全表扫描: Y/N
```

## 7. 与 Phase-5.1 代码的关系

- **索引**：缩小 `orders` / `order_items` 扫描范围（staging 已执行 SQL 后复测上表）。
- **gmv-compare**：减少同请求重复 SQL（day 模式无行级 fetch；hour 模式总额由 fetch 行推导）。
- **orders**：3s in-flight 合并，不缓存响应体。
- **warmup**：不抢首屏（busy 跳过 + gmv-compare 置后）。
