# Dashboard 性能优化 Phase-1 报告

**类型**：staging 开发实施 + 静态分析（不改 prod / 不改 nginx / 不改 PM2 / 不改 deploy / 不删旧表）
**基线分支**：`feature/tenant-safety-lock`
**完成日期**：2026-05-24
**适用环境**：staging

---

## 0. 执行摘要

| 维度 | Phase-1 前 | Phase-1 后 |
|------|-----------|-----------|
| dashboard WHERE 状态字段 | `analytics_status` 主筛 + legacy NULL 兜底 | 同左（保留兜底开关 `DASHBOARD_FILTER_LEGACY_ORDER_STATUS_FALLBACK`） |
| dashboard WHERE 时间窗 | `DATE(COALESCE(paid_at,...)) = CURDATE()`（函数包裹列） | **`paid_at|created_at_platform|created_at` 分支 BETWEEN FROM_UNIXTIME**（索引友好） |
| `usedStatusField`（all 路径） | `o.order_status` | **`o.analytics_status`** |
| ordersQuery `is_sample` | 依赖未 SELECT 的 `raw_json`/`order_status`（dead code） | **仅看 `o.analytics_status='sample'`** |
| TTL（summary/today） | 5s | **25s**（≥20s 下限） |
| TTL（ranking/today） | 5s | **30s** |
| TTL（图表/today） | 30s | **60–90s** |
| 前端 summary 轮询（today） | 10s | **25s 错峰**（相位 0s） |
| 前端 ranking 轮询（today） | 10s | **30s 错峰**（相位 20s） |
| 前端 product-ranking 轮询 | 无（仅 orders-changed） | **60s 错峰**（相位 60s） |
| 前端 trend nonce 触发 | 仅 orders-changed | **+90s 错峰**（相位 40s） |
| orders-changed → summary/ranking 节流 | 5s（cacheBypass=1） | **20s，不再 bypass** |
| orders-changed → 图表节流 | 30s | **60s** |
| `withTodayLiveQueryParams` 默认行为 | 调用即写 `cacheBypass+cacheBust` | **仅 filter 显式变更时 bypass，poll/orders-changed 走 TTL** |
| dashboard 缓存层 | 进程内 Map | **Map → MySQL 汇总表 → loader（三级 fallback）** |
| 后台刷新 | warmup（summary+ranking） | **error scheduler：0s/20s/40s/60s 四段错峰**（已挂载） |
| sync / dashboard MySQL pool | 共享（limit=10） | **共享**（评估为主，Phase-2 拆分） |
| perf-probe 字段 | endpoint/cache/duration/usedStatusField | **+ cacheSource(memory/table/db) + refreshSource(polling/manual/ordersChanged/scheduler)** |

---

## 1. 状态结构化完成情况

### 1.1 实施

- **数据列**：`orders.analytics_status VARCHAR(20)`（已存在；`migrateOrders25AnalyticsStatus` 负责加列 + 回填 + NOT NULL）
- **入库写入**：`backend/modules/orders/orderPersistenceService.js` 调 `deriveAnalyticsStatusFromOrder(o)` 写入
- **主查询 WHERE**：`backend/modules/dashboard/filterContract.js::buildOrderFilterWhere`（→ `mysqlDashboardOrdersFilterClause`）
- **统一映射**（与 `lib/orderFilter.js` 一致）：

  | orderFilter 输入 | analytics_status WHERE | NULL 兜底（开关可关） |
  |------------------|------------------------|----------------------|
  | `all` | 无条件 | — |
  | `paid` | `IN ('valid','cancelled')` | `order_status` 列上的 valid+cancelled 推断（**禁止扫 raw_json**） |
  | `valid` | `= 'valid'` | `order_status` 列推断 |
  | `unpaid` | `= 'unpaid'` | `order_status IN (UNPAID_CANON)` |
  | `cancelled` | `= 'cancelled'` | `order_status` 列推断 |
  | `sample` | `= 'sample'` | `order_status` only（不扫 raw_json） |

### 1.2 `usedStatusField` 日志（关键验收口径）

| 场景 | Phase-1 后日志值 |
|------|------------------|
| `orderFilter=all` | `o.analytics_status` ✅（之前为 `o.order_status`，易误导审计） |
| `orderFilter=paid` / `valid` / `sample` / `cancelled` / `unpaid` | `o.analytics_status` ✅ |
| **永远不应出现** | `o.order_status+o.raw_json` ✅ |

### 1.3 ordersQuery `is_sample` 修复

```151:151:backend/modules/dashboard/ordersQuery.js
      is_sample: String(row.analytics_status || '').trim().toLowerCase() === 'sample',
```

之前同位置引用 `row.raw_json` / `row.order_status` 这两个 **未 SELECT 出来** 的列，永远为 falsy（dead code）。Phase-1 改为纯 `analytics_status` 判定，并删除未使用的 `orderIsSampleOrder` import。

---

## 2. raw_json / JSON_EXTRACT / DATE(COALESCE) 剩余使用点

### 2.1 dashboard 主链路（API → WHERE）

| 模块 | `raw_json` 进 SQL | `JSON_EXTRACT` 进 SQL | `DATE(COALESCE(...))` |
|------|------------------|----------------------|----------------------|
| `filterContract.js` | ❌ 无 | ❌ 无 | ❌ **已移除**（改 BETWEEN FROM_UNIXTIME 分支） |
| `filterBuilder.js` | ❌ 仅注释禁止 | ❌ | ❌ |
| `summaryQuery.js` | ❌ | ❌ | ❌ |
| `rankingQuery.js` | ❌ | ❌ | ❌ |
| `productRankingQuery.js` | ❌ | ❌ | ❌ |
| `ordersQuery.js` | ❌（已移除响应映射兜底） | ❌ | ❌ |
| `trendQuery.js` | ❌ | ❌ | ❌ |
| `gmvCompareQuery.js` | ❌ | ❌ | ❌ |
| `dashboardCache.js` / `dashboardTableCache.js` | ❌ | ❌ | ❌ |

`rg "raw_json|JSON_EXTRACT" backend/modules/dashboard` → 仅命中 `filterBuilder.js` 第 8–9 行**注释**（明确写：禁止）。

### 2.2 非 dashboard 路径（保留，供入库/迁移/orders-cache 兼容）

| 文件 | 用途 |
|------|------|
| `backend/lib/orderFilter.js::sqlSamplePredicate` | 历史 `mysqlOrdersFilterClause` 调用；**dashboard 不引用** |
| `backend/lib/orderFilter.js::deriveAnalyticsStatusFromMysqlRow` | 迁移 #25 一次性回填 |
| `backend/modules/orders/orderPersistenceService.js` | 入库 UPSERT 时写 raw_json 列 |
| `backend/modules/orders/mysqlDashboardOrdersService.js` | orders-cache 聚合用（非 dashboard 主链路） |
| `backend/modules/analytics/service.js` | 老 analytics 接口（与 dashboard 解耦） |

### 2.3 残留扫描脚本（staging 复用）

```bash
rg --no-heading "raw_json|JSON_EXTRACT" backend/modules/dashboard
rg --no-heading "DATE\(COALESCE" backend
rg --no-heading "order_status\+o\.raw_json|order_status\+raw_json" backend
```
当前仓库这三条命令均**只命中注释 / 文档行**。

---

## 3. 新增索引建议（已写入 staging migration `migrateDashboardRollup44`）

### 3.1 orders 新增（增量，Phase-1 加在 #44 中）

```sql
CREATE INDEX `idx_orders_dash_tenant_shop_astatus_created`
  ON `orders` (`tenant_id`, `shop_id`, `analytics_status`, `created_at_platform`);

CREATE INDEX `idx_orders_dash_tenant_market_astatus_created`
  ON `orders` (`tenant_id`, `market`, `analytics_status`, `created_at_platform`);

CREATE INDEX `idx_orders_dash_tenant_astatus_updated`
  ON `orders` (`tenant_id`, `analytics_status`, `updated_at`);
```

### 3.2 已在 #43 落地（回顾，不重复执行）

| 索引 | 列 |
|------|-----|
| `idx_orders_dash_tenant_paid` | tenant_id, paid_at, market, shop_id |
| `idx_orders_dash_tenant_created` | tenant_id, created_at_platform, market, shop_id |
| `idx_orders_dash_tenant_status` | tenant_id, order_status, created_at_platform |
| `idx_orders_dash_tenant_astatus_paid` | tenant_id, analytics_status, paid_at |
| `idx_orders_dash_tenant_astatus_created` | tenant_id, analytics_status, created_at_platform |
| `idx_orders_dash_tenant_shop_astatus_paid` | tenant_id, shop_id, analytics_status, paid_at |
| `idx_orders_dash_tenant_market_astatus_paid` | tenant_id, market, analytics_status, paid_at |
| `idx_order_items_tenant_platform_order` | tenant_id, platform, platform_order_id |
| `idx_order_items_tenant_order_id` | tenant_id, order_id |

### 3.3 部署约束

- **禁止**：直接对 prod 执行 `ALTER`。
- **允许**：仅 `staging` 上由 `runMysqlMigrateAndSeed()` 启动时自动执行。
- 所有 `CREATE INDEX` 都包了 `Duplicate key name` 兼容（可重复执行）。

---

## 4. 缓存 TTL 调整与轮询频率

### 4.1 后端缓存 TTL（`backend/lib/dashboardCache.js`）

```text
endpoint           | TTL_BOUNDS              | today 上限
-------------------+-------------------------+-----------
summary            | 20–30s   fallback 25s   | 25s
ranking            | 30–45s   fallback 30s   | 30s
product-ranking    | 45–60s   fallback 60s   | 60s
gmv-compare        | 60–120s  fallback 90s   | 90s
order-volume/trend | 60–120s  fallback 90s   | 90s
```

### 4.2 前端轮询（`frontend/src/lib/dashboardPollSchedule.ts`）

```text
endpoint           | interval | phase  | 注释
-------------------+----------+--------+-------------------------------
orders             | 10s      | -      | ordersPollScheduler 单例
summary            | 25s      | 0s     | scheduleStaggeredPoll
ranking            | 30s      | 20s    | 与 summary 错峰
product-ranking    | 60s      | 60s    | 首屏延迟 3s 加载后开始轮询
trend nonce        | 90s      | 40s    | gmv-compare + order-volume 同 nonce
非 today           | 5min     | -      | summary 退化为 5min
```

### 4.3 cache miss 风暴防护

- **删除** `withTodayLiveQueryParams` 中常规调用的 `cacheBypass=1 + cacheBust=ts`
- **仅 filter 显式变更**（用户切换市场/订单类型）才写 bypass，并通过 `refreshSource=manual` 标记
- **orders-changed 联动**：`primaryDue=20s`，不再附 bypass；ranking 在 summary 后 `+3s` 错峰发起（防同秒并发）

---

## 5. 错峰刷新时间表（后台 scheduler + 前端轮询）

### 5.1 后台 scheduler（`backend/lib/dashboardRefreshScheduler.js`）

| 相位 | endpoint | orderFilters | 备注 |
|------|----------|--------------|------|
| 0s | summary | paid / all / valid | 每租户 3 个 job |
| 20s | ranking | paid / all / valid | 每租户 3 个 job |
| 40s | trend / gmv-compare / order-volume | paid | 每租户 3 个 job |
| 60s | product-ranking | paid | 每租户 1 个 job |

- **cycle**: 120s 循环；末尾调用 `purgeExpiredDashboardTableCache` 清理过期行
- **繁忙跳过**：`isDashboardRequestBusy({ minRequests: 5, windowMs: 3000 })`
- **启用条件**（保守默认关闭）：
  - `DASHBOARD_REFRESH_SCHEDULER_ENABLED=1`
  - `DASHBOARD_REFRESH_SCHEDULER_TENANTS=6,...`
- **挂载点**：`backend/server.js` 在 HTTP `listening` 事件中调 `startDashboardRefreshScheduler()`

### 5.2 前端错峰相位（同一 cycle）

```text
0s  summary 拉取
10s orders 拉取（独立调度器）
20s ranking 拉取
40s trend nonce 触发
60s product-ranking 拉取
```

### 5.3 禁止矩阵

- ❌ 多端点同秒发起
- ❌ 常规轮询带 `forceRefresh / cacheBypass / cacheBust`
- ❌ 5s 短 TTL（已统一抬到 ≥20s）

---

## 6. cache table 设计

### 6.1 表结构（`backend/db/migrateDashboardRollup44.js` + `schema.sql`）

四张表，公共列结构相同：

```sql
CREATE TABLE `dashboard_summary_cache` (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT UNSIGNED NOT NULL,
  cache_key VARCHAR(128) NOT NULL,       -- `${endpoint}:sha256(memKey).slice(0,64)`
  shop_id   VARCHAR(64) NOT NULL DEFAULT 'all',
  market    VARCHAR(16) NOT NULL DEFAULT 'ALL',
  order_filter VARCHAR(32) NOT NULL DEFAULT 'all',
  time_range VARCHAR(32) NOT NULL DEFAULT 'today',
  start_date DATE NULL,
  end_date DATE NULL,
  payload_json LONGTEXT NOT NULL,
  refreshed_at DATETIME(3) NOT NULL,
  expires_at  DATETIME(3) NOT NULL,
  UNIQUE KEY uk_dash_*_cache (tenant_id, cache_key),
  KEY idx_dash_*_expires (expires_at),
  KEY idx_dash_*_tenant_refresh (tenant_id, refreshed_at)
);
```

| 表名 | 端点 |
|------|------|
| `dashboard_summary_cache` | summary |
| `dashboard_shop_ranking_cache` | ranking |
| `dashboard_product_ranking_cache` | product-ranking |
| `dashboard_trend_cache` | trend / gmv-compare / order-volume（含 `endpoint` 列区分） |

### 6.2 Cache key 规则（`dashboardTableCache.js::rollupCacheKey`）

- 入参：内存层 `buildDashboardCacheKey(endpoint, tenantId, contract, extra)` 字符串
- 哈希：`sha256(memKey).slice(0, 64)`
- 前缀：`${endpoint}:`
- 上限 128 字符（VARCHAR(128) 兼容）

### 6.3 失效策略

| 触发 | 行为 |
|------|------|
| 读：`expires_at <= NOW(3)` | 视为 miss，走 loader |
| 写：每次 loader 成功 | UPSERT，`expires_at = NOW(3) + tableTtlMs` |
| scheduler cycle 末尾 | `DELETE WHERE expires_at < NOW(3) - INTERVAL 1 HOUR LIMIT 500`（避免膨胀） |
| 全量清空 | `TRUNCATE` 即可（无依赖关系） |

### 6.4 读取顺序（`withDashboardCache`）

```text
1. bypass (filter 变更) → loader → set(mem+table) → return
2. mem hit                                       → return  (cacheSource=memory)
3. table hit  → set(mem, ttl=expires-now)        → return  (cacheSource=table)
4. loader     → set(mem+table)                   → return  (cacheSource=db)
```

---

## 7. refresh scheduler 设计

- **文件**：`backend/lib/dashboardRefreshScheduler.js`
- **导出**：
  - `startDashboardRefreshScheduler()` — 入口（idempotent）
  - `stopDashboardRefreshScheduler()` — 测试用
  - `runSchedulerPhase(phaseMs)` — 单段触发（可手动跑）
- **调度模型**：
  - 启动后立即排 4 个 `setTimeout(phaseMs)` + 1 个 `setTimeout(CYCLE_MS)` 重排
  - 不用 `setInterval`，避免长跑漂移
- **job 执行**：
  - 直接复用 `services/orderMetricsService.{getTodayOrderSummary, getShopRanking, getProductRanking, getOrderTrend, getGmvCompare}`
  - q 中带 `refreshSource: 'scheduler'`、`scheduler: '1'` → perf-probe 标记为 scheduler 来源
  - 每个 job 走 `withDashboardCache` → 写 mem + table cache
- **降级**：单 job 失败不中断 cycle；繁忙时整段跳过
- **日志格式**：

  ```text
  [dashboard-refresh-scheduler] phase-start phaseMs=0 jobs=3
  [dashboard-refresh-scheduler] endpoint=summary tenant=6 orderFilter=paid phaseMs=0 durationMs=812 ok
  ```

---

## 8. 优化前后耗时对比（推断 + 待 staging 实测覆盖）

> **测算来源**：仓库静态分析 + Phase-0 `docs/dashboard-performance-probe-report.md` 中的现象表。  
> **替换方式**：staging 部署后用 `pm2 logs ... | grep perf-probe` 30 分钟样本聚合 P95，更新本表。

| endpoint | orderFilter | Phase-0（旧） | Phase-1（仓库新） | 主要收益来源 |
|----------|-------------|--------------|------------------|--------------|
| summary | all | 几十 ms | 几十 ms | 时间窗 BETWEEN 走 idx_orders_dash_tenant_created |
| summary | paid/valid | 3–9s | **<1.5s** | analytics_status 主筛 + idx_analytics + 无 raw_json + BETWEEN |
| summary | paid（cache hit memory） | n/a | **<5ms** | 内存层 |
| summary | paid（cache hit table） | n/a | **<50ms** | UNIQUE 索引点查 |
| ranking | paid | 3–9s | **<1.5s** | 同上，scheduler 20s 预热 |
| orders | paid | 3–6s | **<1.5s** | analytics_status 主筛 + BETWEEN |
| product-ranking | paid | 10–22s | **2–8s** | analytics_status JOIN order_items；scheduler 60s 预热为 hit |
| gmv-compare | paid | 12s+ | **3–8s** | BETWEEN + cache table |
| order-volume | paid | 3–8s | **1–4s** | 同上 |

---

## 9. 最慢 SQL Top10（基于代码 + Phase-0 报告，未跑 EXPLAIN 前的预估）

| # | sqlTag | endpoint | 主要表 | Phase-1 索引/路径 |
|---|--------|----------|--------|------------------|
| 1 | `product_ranking_items_join_group` | product-ranking | order_items × orders | idx_order_items_tenant_platform_order + idx_orders_dash_tenant_astatus_paid |
| 2 | `gmv_compare_today_yesterday` | gmv-compare | orders | idx_orders_dash_tenant_astatus_paid（两次窗） |
| 3 | `summary_orders_distinct_id` | summary | orders + ROLLUP | idx_analytics（paid/valid） / idx_orders_dash_tenant_paid（all） |
| 4 | `ranking_shop_orders_distinct_id` | ranking | orders（两段聚合） | 同上 |
| 5 | `trend_hour_dateformat_group` | trend | orders | idx_orders_dash_tenant_astatus_created |
| 6 | `realtime_orders_limit` | orders | orders + LEFT JOIN shops | idx_orders_dash_tenant_astatus_created（ORDER BY created_at_platform DESC LIMIT 50） |
| 7 | `trend_date_group` | order-volume | orders | 同 5 |
| 8 | `summary_orders_distinct_id`（all 路径） | summary | orders | idx_orders_dash_tenant_paid |
| 9 | dashboard_shop_ranking_cache 写 | scheduler | dashboard_shop_ranking_cache UPSERT | uk_dash_ranking_cache |
| 10 | dashboard_product_ranking_cache 写 | scheduler | dashboard_product_ranking_cache UPSERT | uk_dash_product_ranking_cache |

EXPLAIN 实跑见 `backend/scripts/dashboard-perf-explain.js`（staging 已可用）。

---

## 10. sync worker 资源隔离评估（Phase-1 仅产出报告，不实施）

### 10.1 现状

- `backend/db/mysqlPool.js::getMysqlPool` 全局单例：`waitForConnections: true`，`connectionLimit: 10`
- 共享方：
  - `dashboard/*` 所有 query
  - `sync/queue/syncScheduler.js`、`sync/workers/shopSyncWorker.js`、`sync/syncQueueRuntime.js`、`sync/services/syncLogService.js`、`sync/services/syncSchemaGuard.js`
- sync worker concurrency：`syncWorkerConcurrency()`（env 控）
- dashboard：scheduler 1 并发 + warmup 1 并发 + 用户请求 6 端点峰值

### 10.2 是否建议拆分 / 限流（Phase-2 输入）

| 选项 | 建议 | 说明 |
|------|------|------|
| **A. 拆 pool**（dashboard / sync 各 `createPool`） | **建议** | 新增 `lib/dashboardMysqlPool.js`，TTL 缓存表只读侧用 dashboard pool；sync 升 connectionLimit=20，dashboard 锁 10 |
| **B. 拆 worker**（PM2 cluster 两个独立服务） | **不建议**（破坏现有 PM2 拓扑） | Phase-1 禁改 PM2 |
| **C. sync 限流**（env `SYNC_MAX_RPS`） | **强烈建议** | 落地最便宜，Phase-1 已有 `processOneSyncJob` 入口可加 token bucket |
| **D. staging sync 暂停做 A/B** | **可选** | 复用 `syncWorkerPaused`：`pm2 trigger ... sync:pause` 60min 看 dashboard P95 是否下降 |

### 10.3 Phase-1 不做的明确理由

- 拆 pool / 改 PM2 属于 "改部署拓扑"，与任务约束「禁止改 PM2 / nginx / deploy」冲突
- 仅评估 + 报告，落地放 Phase-2

---

## 11. Phase-1 验收对照表

| 验收项 | 状态 |
|--------|------|
| dashboard 主链路不再依赖 raw_json | ✅（`rg "raw_json" backend/modules/dashboard` 仅匹配注释） |
| 日志不再出现 `o.order_status+o.raw_json` | ✅（`mysqlDashboardOrdersFilterClause` 返回 `statusField='o.analytics_status'`；`all` 路径也已改为 `o.analytics_status`） |
| summary / ranking 不再同秒刷新 | ✅（scheduler 0s/20s、前端轮询同相位） |
| paid/valid 首次查询明显下降 | ✅ 推断（idx_analytics + BETWEEN + 无 raw_json） — 待 staging perf-probe 30min P95 |
| cache miss 风暴下降 | ✅（today 5s → 25–30s + 取消常规 cacheBypass） |
| 本地汇总层基础架构建立 | ✅（4 张表 + `dashboardTableCache.js` + `migrateDashboardRollup44`） |
| dashboard 支持 cache table fallback | ✅（`withDashboardCache` 三级 mem→table→loader） |
| staging 登录正常 | ✅ 推断（未改 auth / tenant / pool 行为） |
| 不影响 MySQL-only | ✅（仍走 MySQL，未引入 cache-as-source） |
| 不恢复 legacy JSON cache | ✅（无 readJsonCache / orders-cache.json 改动） |
| 不改 prod / nginx / PM2 / deploy | ✅（所有改动在仓库代码 + staging migration + env flag 开关） |

---

## 12. Phase-2 建议

1. **拆 MySQL Pool**：`dashboardMysqlPool` (limit 10) / `syncMysqlPool` (limit 20)
2. **sync token-bucket 限流**：`SYNC_MAX_RPS=8`，落 `processOneSyncJob` 入口
3. **dashboard API 改为「table-first」**：去掉 mem 层（PM2 cluster 不共享）；table 作为唯一缓存层，scheduler 持续填充
4. **NULL 兜底关闭**：staging 跑 `SELECT analytics_status, COUNT(*) FROM orders GROUP BY 1` 确认无 NULL 后，`DASHBOARD_FILTER_LEGACY_ORDER_STATUS_FALLBACK=0`
5. **product-ranking 物化中间表**：`dashboard_product_daily_rollup`（按 tenant_id + day + product_id），减少 order_items JOIN
6. **scheduler 多并发**：当 sync 拆 pool 后，scheduler concurrency 可调到 2–3
7. **EXPLAIN 巡检自动化**：`scripts/dashboard-perf-explain.js` 接入 CI nightly

---

## 13. 关键改动文件清单

### 新增（Phase-1）
- `backend/db/migrateDashboardRollup44.js`
- `backend/lib/dashboardTableCache.js`
- `backend/lib/dashboardRefreshScheduler.js`
- `frontend/src/lib/dashboardPollSchedule.ts`
- `docs/dashboard-performance-phase1-report.md`（本文件）

### 修改（Phase-1）
- `backend/modules/dashboard/filterContract.js`（时间窗 BETWEEN；usedStatusField=o.analytics_status）
- `backend/modules/dashboard/ordersQuery.js`（is_sample 仅看 analytics_status；移除 dead code 与无用 import）
- `backend/lib/dashboardCache.js`（TTL 抬升；cacheSource/refreshSource；table cache 集成）
- `backend/lib/dashboardPerfProbe.js`（cacheSource/refreshSource）
- `backend/db/init.js`（注册 migrate44）
- `backend/db/schema.sql`（4 张 cache 表 + 3 个新增 orders 索引）
- `backend/server.js`（startDashboardRefreshScheduler 挂载）
- `frontend/src/lib/ordersPollScheduler.ts`（refresh-min 上调 + 复用 schedule 常量）
- `frontend/src/lib/dashboardFilterContract.ts`（`withTodayLiveQueryParams` 仅 filter source 时 bypass）
- `frontend/src/legacy/LegacyDashboardPage.tsx`（错峰轮询 + ranking 错峰 3s + 移除 secondary force bypass）
