# Phase-5.2 Dashboard 慢接口结果

| 项 | 值 |
|----|-----|
| 分支 | `feature/dashboard-performance-phase52` |
| 范围 | 仅 `backend/modules/dashboard/*` + 索引 + 文档 |
| 场景 | paid + today（staging 主验收口径） |

## 1. 慢接口 before / after（目标）

| endpoint | sqlTag | before (staging) | 目标 | after (staging 部署后填写) |
|----------|--------|------------------|------|---------------------------|
| orders | `realtime_orders_limit` | 1.3 ~ 4.7s | < 800ms | _待测_ |
| summary | `summary_orders_count_and_gmv_group` | 1.5 ~ 2.3s | < 1200ms | _待测_ |
| ranking | `ranking_shop_currency_group` | 1.3 ~ 1.6s | < 900ms | _待测_ |
| product-ranking | `product_ranking_items_join_group` | 1.4 ~ 1.5s | < 1200ms | _待测_ |

## 2. 代码变更摘要

| 文件 | 变更 |
|------|------|
| `ordersQuery.js` | 内层 `LIMIT 50` + 按单 correlated `order_items` 件数 |
| `summaryQuery.js` | 单次 `GROUP BY ... WITH ROLLUP` 替代双查询 |
| `usdGmv.js` | summary 委托 `summaryQuery` |
| `rankingQuery.js` | 移除 `shops` JOIN，仅用 `orders.shop_name` |
| `productRankingQuery.js` | `orders` 子查询前置过滤 + `oi.tenant_id` 优先 |
| `dashboard-phase52.sql` | 5 条复合索引 |

## 3. Staging 验收命令

```bash
cd /home/admin/daping-staging
source .env
mysql -u"$DB_USER" -p"$DB_PASSWORD" "$DB_NAME" < backend/db/indexes/dashboard-phase52.sql
pm2 restart daping-staging --update-env
sleep 15
pm2 logs daping-staging --lines 120 | grep -E "slow endpoint|summary|ranking|product-ranking|orders"
```

检查：

- [ ] 无 Unknown column / schema_invalid / crash / deadlock
- [ ] ranking / product-ranking 有数据，首屏不闪「暂无数据」
- [ ] `slow endpoint` 行 `durationMs` 达目标区间
- [ ] EXPLAIN 无核心 SQL `type=ALL`

## 4. Rollback

1. **代码**：`git checkout <pre-phase52-tag> -- backend/modules/dashboard/` 或回滚部署包。
2. **索引**（可选，索引只增不删，一般可保留）：若需回滚查询计划，删除 p52 索引名（需 DBA 评审，本阶段 SQL 文件禁止 DROP）。
3. **进程**：`pm2 restart daping-staging --update-env`

预部署 tag：`dashboard-phase52-pre`（本 commit 父节点）  
发布 tag：`dashboard-phase52`

---

## 5. Hotfix（索引兼容 + product-ranking rows=0）

| 项 | 值 |
|----|-----|
| 分支 | `feature/dashboard-phase52-hotfix-index-and-product-ranking` |
| tag | `dashboard-phase52-hotfix` |

### 问题与修复

| 问题 | 根因 | 修复 |
|------|------|------|
| 索引 SQL ERROR 1064 | MySQL/MariaDB 不支持 `CREATE INDEX IF NOT EXISTS` | 改为存储过程 + `INFORMATION_SCHEMA.STATISTICS` 检查后创建（p52 / p51 均已更新） |
| product-ranking `rows=0` | Phase-5.2 将 `where` 移入 `orders` 子查询后，仍用 `[tenantId, ...where.params]`，占位符与 SQL 顺序错位 | 回退 Phase-5.1 直接 JOIN 写法；保留 `orderBySql`；增加 `[dashboard-product-ranking-debug]` 日志 |

### Hotfix 验收命令

```bash
cd /home/admin/daping-staging
mysql -u root -p daping_staging < backend/db/indexes/dashboard-phase52.sql
pm2 restart daping-staging --update-env
sleep 15
pm2 logs daping-staging --lines 150 | grep -E "product-ranking|dashboard-product-ranking-debug|Unknown column|SQL syntax|Duplicate key"
```

### Hotfix 验收标准

- [ ] 索引 SQL 无 ERROR 1064 / Duplicate key
- [ ] `orderFilter=paid` 时 `product-ranking` `rows > 0`
- [ ] debug 行 `candidateOrders > 0` 且 `joinedItems > 0`

### Hotfix Rollback

`git checkout dashboard-phase52 -- backend/modules/dashboard/productRankingQuery.js backend/db/indexes/`
