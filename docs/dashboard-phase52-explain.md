# Phase-5.2 Dashboard EXPLAIN 记录（paid / today）

索引：`backend/db/indexes/dashboard-phase52.sql`（在 Phase-5.1 索引之后执行）。

> **Hotfix**：脚本使用 `sp_dashboard_p52_ensure_indexes` 存储过程，通过 `INFORMATION_SCHEMA.STATISTICS` 判断索引是否存在后再 `CREATE INDEX`，兼容不支持 `CREATE INDEX IF NOT EXISTS` 的 MySQL/MariaDB。可重复执行，不会报 Duplicate key。

## 执行前准备

```sql
USE daping_staging;
SET @tenant_id = 1;
SET @shop_id = NULL;   -- 全店
SET @market = 'ALL';

SHOW INDEX FROM orders WHERE Key_name LIKE 'idx_orders_p5%';
SHOW INDEX FROM order_items WHERE Key_name LIKE 'idx_order_items_p5%';
```

公共谓词（`timeRange=today`, `orderFilter=paid`）与 `buildDashboardWhere` 一致：

```sql
AND o.tenant_id = @tenant_id
AND DATE(COALESCE(o.paid_at, o.created_at_platform, o.created_at)) = CURDATE()
-- + paid 对应 order_status / NOT sample 条件（见 orderFilter.js）
```

---

## 1. summary_orders_count_and_gmv_group

**索引前（Phase-5.1 后，双查询）**

| 查询 | rows (估) | type | key | Extra |
|------|-----------|------|-----|-------|
| COUNT DISTINCT | 1万+ | range | idx_orders_p51_* | Using where |
| GROUP BY currency | 1万+ | range | 同上 | Using temporary; Using filesort |

**索引后（单查询 WITH ROLLUP + p52 索引）**

| 项 | 目标 |
|----|------|
| type | range（禁止 ALL） |
| key | `idx_orders_p52_tenant_status_event` 或 `idx_orders_p52_tenant_shop_event` |
| rows | 较索引前降 50%+ |
| Extra | `Using where`；避免 `Using temporary` / `Using filesort` |

```sql
EXPLAIN
SELECT
  COUNT(DISTINCT o.platform_order_id) AS orders,
  COUNT(DISTINCT o.shop_id) AS shop_count,
  UPPER(COALESCE(NULLIF(TRIM(o.currency), ''), '')) AS line_currency,
  UPPER(COALESCE(NULLIF(TRIM(o.market), ''), '')) AS market,
  COALESCE(SUM(o.total_amount), 0) AS gmv_native
FROM orders o
WHERE o.tenant_id = @tenant_id
  AND DATE(COALESCE(o.paid_at, o.created_at_platform, o.created_at)) = CURDATE()
GROUP BY line_currency, market WITH ROLLUP;
```

---

## 2. realtime_orders_limit

**索引前**

| 项 | 值 |
|----|-----|
| type | range |
| key | tenant/time 索引 |
| Extra | 全租户 `order_items` 聚合子查询 + `Using filesort` + LIMIT 50 在 JOIN 后 |

**索引后**

| 项 | 目标 |
|----|------|
| 内层 `o0` | range + `idx_orders_p52_tenant_created_sort`；`LIMIT 50` 在 JOIN 前 |
| `order_items` | 50 次 ref 子查询，`idx_order_items_p52_tenant_platform_order` |
| Extra | 无全表 order_items 聚合；外层 filesort 仅 50 行 |

```sql
EXPLAIN
SELECT o.platform_order_id, o.shop_id, o.total_amount
FROM (
  SELECT o0.platform_order_id, o0.shop_id, o0.tenant_id, o0.platform,
         o0.total_amount, o0.created_at_platform, o0.created_at
  FROM orders o0
  WHERE o0.tenant_id = @tenant_id
    AND DATE(COALESCE(o0.paid_at, o0.created_at_platform, o0.created_at)) = CURDATE()
  ORDER BY COALESCE(o0.created_at_platform, o0.created_at) DESC
  LIMIT 50
) o;
```

---

## 3. ranking_shop_currency_group

**索引前**

| 项 | 值 |
|----|-----|
| JOIN | `LEFT JOIN shops` 扩大行集 |
| GROUP | shop + currency + market |
| Extra | temporary / filesort 常见 |

**索引后**

| 项 | 目标 |
|----|------|
| JOIN | 无 shops；仅 `orders` |
| key | `idx_orders_p52_tenant_shop_event` |
| GROUP rows | 店铺×币种组数减少（无 shops 重复行） |

```sql
EXPLAIN
SELECT o.shop_id,
       UPPER(COALESCE(NULLIF(TRIM(o.currency), ''), '')) AS line_currency,
       COUNT(DISTINCT o.platform_order_id) AS orders,
       COALESCE(SUM(o.total_amount), 0) AS gmv_native
FROM orders o
WHERE o.shop_id IS NOT NULL
  AND o.tenant_id = @tenant_id
  AND DATE(COALESCE(o.paid_at, o.created_at_platform, o.created_at)) = CURDATE()
GROUP BY o.shop_id, line_currency;
```

---

## 4. product_ranking_items_join_group

**索引前**

| 项 | 值 |
|----|-----|
| 驱动表 | `order_items` 全租户扫描后 JOIN orders |
| oi type | ALL / range rows 高 |

**索引后**

| 项 | 目标 |
|----|------|
| 驱动 | 先过滤 `orders o_f` 子查询（时间+tenant+paid） |
| oi | ref on `idx_order_items_p52_tenant_product_order` |
| LIMIT | `limit*3` 在 GROUP 后（较 500 收紧） |

```sql
EXPLAIN
SELECT oi.product_id, SUM(oi.quantity) AS qty
FROM order_items oi
INNER JOIN (
  SELECT o_f.tenant_id, o_f.platform, o_f.platform_order_id
  FROM orders o_f
  WHERE o_f.tenant_id = @tenant_id
    AND DATE(COALESCE(o_f.paid_at, o_f.created_at_platform, o_f.created_at)) = CURDATE()
) o ON o.tenant_id = oi.tenant_id
   AND o.platform = oi.platform
   AND o.platform_order_id = oi.platform_order_id
WHERE oi.tenant_id = @tenant_id
GROUP BY oi.product_id
ORDER BY qty DESC
LIMIT 60;
```

---

## 5. Staging 实测模板

```
sqlTag=________________
BEFORE rows=______ type=______ key=______ Extra=______
AFTER  rows=______ type=______ key=______ Extra=______
Using temporary: Y/N → Y/N   Using filesort: Y/N → Y/N   ALL: Y/N → Y/N
```
