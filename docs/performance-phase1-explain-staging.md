# Phase-1 索引 EXPLAIN 记录（仅 staging）

> 在 **staging** 只读账号执行；**禁止**在未验收前于 prod 执行 DDL。  
> SQL 业务口径不变；仅评估索引是否降低 `rows_examined`。

## 执行前

```sql
USE <staging_db>;
SET @tenant_id = 1;
SHOW INDEX FROM orders;
SHOW INDEX FROM order_items;
```

记录基线：`idx_orders_tenant`、`idx_analytics`、`idx_orders_created` 等。

## DDL（staging 手工执行一次）

见 `backend/db/indexes/dashboard-orders-trend.sql`。

## EXPLAIN 模板

完整语句见 `docs/performance-explain-dashboard.md` §4。

| 接口 | sqlTag | 记录项 |
|------|--------|--------|
| gmv-compare | `gmv_compare_fetch_today_rows` | type, key, rows, Extra |
| gmv-compare | `gmv_compare_snap_today` | 同上 |
| product-ranking | `product_ranking_items_join_group` | 同上 |
| ranking | `ranking_shop_currency_group` | 同上 |
| order-volume | `trend_hour_dateformat_group` | 同上 |
| summary | `summary_orders_count_and_gmv_group` | 同上 |

## 记录表（填写实测）

| sqlTag | 索引前 rows | 索引后 rows | 索引前 key | 索引后 key | 备注 |
|--------|-------------|-------------|------------|------------|------|
| gmv_compare_fetch_today_rows | | | | | |
| ranking_shop_currency_group | | | | | |
| product_ranking_items_join_group | | | | | |
| trend_hour_dateformat_group | | | | | |
| summary_orders_count_and_gmv_group | | | | | |

## 预期

- `tenant_id` 过滤后扫描行数下降。
- `DATE(COALESCE(...))` 仍可能无法完全走时间索引（Phase-2 再评估生成列）。

## 回滚

```sql
DROP INDEX idx_orders_tenant_event_time ON orders;
DROP INDEX idx_orders_tenant_market_shop ON orders;
DROP INDEX idx_order_items_tenant_platform_order ON order_items;
```
