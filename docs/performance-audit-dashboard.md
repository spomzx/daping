# Dashboard 性能审计

## 当前稳定版本

- **Git tag**：`prod-dashboard-curdate-v1`
- **Commit**：`4e1dba28e70c59f04efc1c2efba2f07f7bb10e50`（分支 `fix/unify-order-data-source`）
- **验收要点**：MySQL 单源、CURDATE 事件日、`orderFilter` 全链路、prod 订单数与库一致

---

## 慢接口列表

| 优先级 | 接口 | 观测耗时 | 入口文件 |
|--------|------|----------|----------|
| P0 | `GET /api/dashboard/gmv-compare` | 约 3s～12s（多轮 SQL + 内存分桶） | `gmvCompareQuery.js` |
| P1 | `GET /api/dashboard/product-ranking` | 常 >800ms（`orders` JOIN `order_items` + 复杂 GROUP BY） | `productRankingQuery.js` |
| P1 | `GET /api/dashboard/ranking` | 常 >800ms（按 shop×currency×market 分组） | `rankingQuery.js` |
| P2 | `GET /api/dashboard/order-volume` | 依赖 `timeRange`；`hour` + `DATE_FORMAT` 分组偏重 | `trendQuery.js` |
| P2 | `GET /api/dashboard/summary` | 双查询并行，一般轻于 gmv-compare | `usdGmv.js` |
| P3 | `GET /api/dashboard/orders` | 有 `LIMIT 50`，通常可控 | `ordersQuery.js` |

统一 WHERE 构建：`modules/dashboard/filterContract.js` → `buildDashboardWhere` / `buildDateRangeWhere`（**本审计不修改**）。

---

## 接口 SQL 分析

### 1. `GET /api/dashboard/summary`

| 项 | 内容 |
|----|------|
| 路由 | `routes.js` → `controller.summary` |
| 服务 | `service.getSummary` → `repository.querySummary` → `orderMetricsService.getTodayOrderSummary` |
| 查询 | `usdGmv.queryDashboardGmvUsd` |

**SQL A（订单数）**

```sql
SELECT COUNT(DISTINCT o.platform_order_id) AS orders,
       COUNT(DISTINCT o.shop_id) AS shop_count
FROM orders o
WHERE 1=1
  AND (o.tenant_id = ?)
  AND (DATE(COALESCE(o.paid_at, o.created_at_platform, o.created_at)) = CURDATE())  -- timeRange=today
  -- + market / shop / orderFilter 片段
```

**SQL B（GMV 按币种）**

```sql
SELECT UPPER(COALESCE(NULLIF(TRIM(o.currency), ''), '')) AS line_currency,
       UPPER(COALESCE(NULLIF(TRIM(o.market), ''), '')) AS market,
       COALESCE(SUM(o.total_amount), 0) AS gmv_native
FROM orders o
WHERE 1=1
  AND (同上 where.sql)
GROUP BY line_currency, market
```

| 检查项 | 结果 |
|--------|------|
| DATE() | 是（今日 `= CURDATE()`） |
| DATE_FORMAT() | 否 |
| GROUP BY | 仅 SQL B |
| COUNT(DISTINCT) | 是（`platform_order_id`） |
| SUM | 是（SQL B） |
| ORDER BY | 否 |
| LIMIT | 否 |
| 全表扫描风险 | 中：`DATE(表达式)` 难走 `idx_orders_created`；`tenant_id` 可缩小范围 |

---

### 2. `GET /api/dashboard/gmv-compare`

| 项 | 内容 |
|----|------|
| 路由 | `controller.gmvCompare` → `orderMetricsService.getGmvCompare` → `queryDashboardGmvCompare` |
| 内存缓存 | `memCache` TTL 15～60s（`DASHBOARD_GMV_COMPARE_TTL_MS`） |

**单次请求内 SQL 次数（`groupBy=hour` + `timeRange=today` 典型）**

| 次序 | sqlTag | 说明 |
|------|--------|------|
| 1 | `gmv_compare_fetch_today_rows` | `fetchOrderRows` 拉今日窗内所有订单行（无 LIMIT） |
| 2 | `gmv_compare_fetch_yesterday_rows` | 同上，昨日对比窗 |
| 3 | `gmv_compare_snap_today` | `queryDashboardGmvUsd`（与 summary 同口径） |
| 4 | `gmv_compare_snap_yesterday` | `queryDashboardGmvUsd` 昨日窗 |

**fetchOrderRows 核心 SQL**

```sql
SELECT COALESCE(o.paid_at, o.created_at_platform, o.created_at) AS ts,
       o.total_amount, o.currency, o.market
FROM orders o
WHERE 1=1
  AND (buildDashboardWhere...)
-- 无 LIMIT；结果在 Node 按小时桶聚合 aggregateMysqlHourWindowUsdSeries
```

| 检查项 | 结果 |
|--------|------|
| DATE() | 是（经 `buildDateRangeWhere`） |
| DATE_FORMAT() | 否（分桶在应用层） |
| GROUP BY | 否（DB 侧） |
| COUNT(DISTINCT) | 否（fetch 行级） |
| SUM | 否（fetch 行级） |
| ORDER BY | 否 |
| LIMIT | 否 |
| 全表扫描风险 | **高**：两次宽结果集 + 两次 summary 类聚合；为主要慢点 |

---

### 3. `GET /api/dashboard/ranking`

| 项 | 内容 |
|----|------|
| 路由 | `controller.ranking` → `orderMetricsService.getShopRanking` → `queryDashboardRanking` |

```sql
SELECT o.shop_id, MAX(shop_name), MAX(market),
       UPPER(currency), COUNT(DISTINCT o.platform_order_id) AS orders,
       COALESCE(SUM(o.total_amount), 0) AS gmv_native
FROM orders o
LEFT JOIN shops s ON ...
WHERE 1=1 AND (buildDashboardWhere...)
GROUP BY o.shop_id, currency, market
-- 无 SQL LIMIT；应用层 merge 后 slice(limit) 默认 30
```

| 检查项 | 结果 |
|--------|------|
| DATE() | 是 |
| DATE_FORMAT() | 否 |
| GROUP BY | 是（shop × currency × market） |
| COUNT(DISTINCT) | 是 |
| SUM | 是 |
| ORDER BY | 否（排序在 JS） |
| LIMIT | 否（SQL 层） |
| 全表扫描风险 | 中高：分组键多，中间结果行数 ≈ 店铺数 × 币种数 |

---

### 4. `GET /api/dashboard/product-ranking`

| 项 | 内容 |
|----|------|
| 路由 | `controller.productRanking` → `queryDashboardProductRanking` |

```sql
SELECT grp_key, MAX(product_name), MAX(sku_name),
       SUM(oi.quantity), SUM(oi.total_amount), COUNT(DISTINCT o.platform_order_id),
       currency, market
FROM order_items oi
INNER JOIN orders o ON tenant/platform/platform_order_id
WHERE oi.tenant_id = ? AND (buildDashboardWhere on o...)
GROUP BY grp_key, currency, market
ORDER BY SUM(oi.quantity) DESC
LIMIT 500
```

| 检查项 | 结果 |
|--------|------|
| DATE() | 是（在 orders 别名 `o` 上） |
| DATE_FORMAT() | 否 |
| GROUP BY | 是（复杂 `IF/CONCAT` 商品键） |
| COUNT(DISTINCT) | 是 |
| SUM | 是 |
| ORDER BY | 是 |
| LIMIT | 500（SQL）→ 再 JS slice 默认 20 |
| 全表扫描风险 | **高**：JOIN + 表达式 GROUP BY，最难索引 |

---

### 5. `GET /api/dashboard/order-volume`

| 项 | 内容 |
|----|------|
| 路由 | `controller.orderVolume` → `getOrderTrend(..., 'order-volume')` → `queryDashboardTrend` |
| 内存缓存 | `memCache` TTL 15～60s |

```sql
SELECT DATE_FORMAT(COALESCE(o.paid_at, o.created_at_platform, o.created_at), '%Y-%m-%d %H:00:00') AS time,
       currency, market,
       COUNT(DISTINCT o.platform_order_id) AS orders,
       COALESCE(SUM(o.total_amount), 0) AS gmv_native
FROM orders o
WHERE 1=1 AND (buildDashboardWhere...)
GROUP BY time, currency, market
ORDER BY time ASC
```

`timeRange=last7/last30` 时 bucket 为 `DATE(事件时间)`。

| 检查项 | 结果 |
|--------|------|
| DATE() | 是（今日/昨日窗） |
| DATE_FORMAT() | 是（`groupBy=hour` 时） |
| GROUP BY | 是 |
| COUNT(DISTINCT) | 是 |
| SUM | 是 |
| ORDER BY | 是 |
| LIMIT | 否 |
| 全表扫描风险 | 高（hour）：`DATE_FORMAT` 导致无法使用 `idx_orders_created` |

---

### 6. `GET /api/dashboard/orders`

| 项 | 内容 |
|----|------|
| 路由 | `controller.orders` → `warRoomOrders` → `queryDashboardRealtimeOrders` |

```sql
SELECT o.platform_order_id, shop_id, shop_name, market, currency, amount, items, ...
FROM orders o
LEFT JOIN shops s ...
LEFT JOIN (order_items 子查询 SUM(quantity) GROUP BY order) oi_sum ...
WHERE 1=1 AND (buildDashboardWhere...)
ORDER BY COALESCE(o.created_at_platform, o.created_at) DESC
LIMIT 50
```

| 检查项 | 结果 |
|--------|------|
| DATE() | 是（WHERE） |
| DATE_FORMAT() | 否 |
| GROUP BY | 仅子查询 `order_items` |
| COUNT(DISTINCT) | 否 |
| SUM | 子查询内 |
| ORDER BY | 是 |
| LIMIT | 50 |
| 全表扫描风险 | 中：有 LIMIT；子查询可能扫当日 order_items |

---

## 现有索引（`orders` / `order_items`）

```text
orders:
  PRIMARY (id)
  uk_orders_platform_order (platform, platform_order_id)
  idx_orders_tenant (tenant_id)
  idx_analytics (tenant_id, analytics_status, created_at_platform, market, shop_id)
  idx_orders_created (created_at_platform)
  idx_orders_shop, idx_orders_market, idx_orders_platform_shop

order_items:
  (见 schema — 通常 tenant + platform_order_id 关联)
```

**与当前 WHERE 的匹配度**

- `tenant_id = ?`：可用 `idx_orders_tenant` / `idx_analytics` 前缀。
- `DATE(COALESCE(paid_at, created_at_platform, created_at)) = CURDATE()`：对三列做函数包裹，**常规 B-Tree 难以直接用于事件日过滤**。
- `orderFilter != all`：`order_status` / `raw_json` 条件进一步降低索引选择性。

---

## 可能慢的原因

1. **gmv-compare 请求扇出**：并行 2 次无 LIMIT 行级拉取 + 2 次 `queryDashboardGmvUsd`，总耗时累加；冷缓存时 3～12s 符合预期。
2. **DATE(表达式)**：今日口径统一后正确，但牺牲 `created_at_platform` 索引直达。
3. **DATE_FORMAT + GROUP BY hour**（order-volume / trend）：典型非 SARGable，易大范围扫描后临时表聚合。
4. **COUNT(DISTINCT platform_order_id)**：多分组维度下内存与 CPU 开销显著。
5. **product-ranking JOIN order_items**：行数放大 + `CONCAT/IF` 分组键无法索引。
6. **ranking 无 SQL LIMIT**：先聚合全部 shop×currency 再在 JS 截断 Top N。
7. **应用层汇率**：`preloadRatesForCurrencyRows` 多次调用，增加尾延迟。
8. **memCache 仅进程内**：多 PM2 实例 / 重启后冷启动仍慢。

---

## 建议优化方案（仅建议，本阶段不执行）

### 数据库

- 增加 **生成列** `event_date DATE` / `event_hour DATETIME`，源于 `COALESCE(paid_at, created_at_platform, created_at)`，并建 `(tenant_id, event_date, shop_id, order_status)` 复合索引。
- 或 **日汇总表** `dashboard_order_daily_agg(tenant_id, shop_id, market, order_filter_bucket, stat_date, orders, gmv_native, …)`，由同步任务写入。
- `product-ranking` 可考虑 `order_items(tenant_id, platform_order_id)` 覆盖索引 + 预聚合 SKU 表。

### API / 服务

- **gmv-compare**：合并今日/昨日行级查询为单次 SQL + `CASE` 分桶；或仅依赖 DB 小时聚合，避免拉全量行。
- **ranking / product-ranking**：SQL 层 `ORDER BY … LIMIT N`，减少 JS merge 前数据量。
- 延长/共享 **Redis 缓存**（按 `tenantId+contract` 键），与现有 `memCache` 对齐。
- **summary + gmv-compare** 同源 KPI 时，前端避免重复打 snap（已有部分契约拆分，可再合并请求）。

### 前端

- gmv-compare / order-volume **独立 skeleton**，不阻塞首屏 KPI。
- 并行请求优先级：`summary` 先，`gmv-compare` / `product-ranking` 延后。

### 观测

- 已增强 `[dashboard-contract] slow` 日志字段：`endpoint`, `durationMs`, `timeRange`, `orderFilter`, `market`, `shopId`, `rows`, `points`, `sqlTag`（见 `backend/lib/dashboardSlowLog.js`）。

---

## 本阶段交付范围

- [x] 分支 `feature/dashboard-performance-audit`
- [x] 文档 `docs/performance-audit-dashboard.md`
- [x] 慢日志增强（不改 SQL 结果与业务口径）
- [ ] 无 migration
- [ ] 无 SQL / API 结构变更
