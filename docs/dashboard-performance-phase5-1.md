# Phase-5.1 Dashboard 慢接口优化（第一阶段）

| 项 | 值 |
|----|-----|
| 分支 | `feature/dashboard-performance-phase5-1` |
| 前置 | `staging-sync-stability-phase2-validated-v1`（Phase-4.2 queue-only 已通过） |
| 约束 | 不改 paid filter 口径、不改 sync worker、**SYNC_WORKER_CONCURRENCY=1** |

## 1. 慢接口定位（sqlTag）

| 接口 | 路由 | 主 sqlTag | 辅助 sqlTag |
|------|------|-----------|-------------|
| gmv-compare | `GET /api/dashboard/gmv-compare` | `gmv_compare_total_pipeline` | `gmv_compare_fetch_today` / `gmv_compare_fetch_yesterday` / `gmv_compare_snap_today` / `gmv_compare_snap_yesterday` |
| summary | `GET /api/dashboard/summary` | `summary_orders_count_and_gmv_group` | — |
| order-volume | `GET /api/dashboard/order-volume` | `trend_hour_dateformat_group` | `trend_date_group`（按 day） |
| product-ranking | `GET /api/dashboard/product-ranking` | `product_ranking_items_join_group` | — |
| orders | `GET /api/dashboard/orders` | `realtime_orders_limit` | — |
| ranking | `GET /api/dashboard/ranking` | `ranking_shop_currency_group` | — |

日志关键字：

```bash
pm2 logs daping-staging --lines 300 | grep -E '\[dashboard-contract\]|\[dashboard-cache-warmup\]'
```

字段：`endpoint=`、`sqlTag=`、`durationMs=`、`cache=hit|miss`。

## 2. Staging 验收结论（优化前基线 → 本阶段目标）

### 优化前（Phase-4.2 期间观测）

| 接口 | 典型耗时 | 说明 |
|------|----------|------|
| gmv-compare | **18s ~ 24s**（冷启动） | 最严重；同请求内 fetch 行级 + snap 聚合重复扫表 |
| summary | 1.5s ~ 4s | 与 gmv snap 同 SQL 族 |
| order-volume | 1s ~ 3s | `DATE_FORMAT` 分组 |
| product-ranking | 1s ~ 3s | `order_items` JOIN |
| orders | 0.5s ~ 2s | 实时 LIMIT 50 |
| worker 并发 3 | dashboard 明显变慢 | 已固定 **concurrency=1** |

### 本阶段代码优化（不改口径）

| 项 | 做法 |
|----|------|
| gmv-compare | `groupBy=day` 跳过行级 fetch；`hour` 模式从已 fetch 行推导 today/yesterday 总额（窗一致时免 2 次 snap SQL） |
| gmv-compare | 保持 `withDashboardCache` TTL；日志 `cache=hit` 目标 0~50ms |
| orders | 同参数 3s in-flight 去重；LIMIT 仍 50 |
| warmup | 并发固定 1；`gmv-compare` 最后；`reason=busy` 跳过 |

### 优化后目标（staging 验收）

| 接口 | 目标 |
|------|------|
| orders | 常规 **< 1s** |
| summary | 常规 **< 1.5s** |
| ranking / product-ranking | 常规 **< 1.5s** |
| order-volume | 常规 **< 1.5s** |
| gmv-compare 冷启动 | 尽量 **< 5s**（索引 + 去重后） |
| gmv-compare cache hit | **0 ~ 50ms** |

### 验收命令

```bash
cd /home/admin/daping-staging/backend
# 仅 staging 执行索引（prod 本阶段不执行）
mysql -u"$DB_USER" -p"$DB_PASSWORD" "$DB_NAME" < db/indexes/dashboard-phase5-1.sql

cd /home/admin/daping-staging/frontend && npm run build

pm2 logs daping-staging --lines 200 | grep -E 'dashboard-contract|Unknown column|schema_invalid|SQL syntax'
```

检查项：

- [ ] `npm run build` 通过
- [ ] 索引 SQL 无报错
- [ ] 首屏 summary 先出，页面不卡死
- [ ] 无 Unknown column / schema_invalid / SQL syntax / tenant 串数据
- [ ] paid 口径与 `npm run check:dashboard-contract` 一致（可选）

## 3. 索引（仅 staging 执行）

文件：`backend/db/indexes/dashboard-phase5-1.sql`

**prod 本阶段不执行**；上线前单独评审 + EXPLAIN 复测。

## 4. 环境与并发

```env
SYNC_WORKER_CONCURRENCY=1
```

Dashboard warmup：`DASHBOARD_CACHE_WARMUP_CONCURRENCY` 环境变量 **不再生效**（代码固定 1）。

## 5. Rollback

见 [dashboard-performance-phase5-1-rollback.md](./dashboard-performance-phase5-1-rollback.md)。
