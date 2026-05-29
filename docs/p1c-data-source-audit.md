# P1-C.1 数据链路审计（统一缓存架构准备）

> **任务**：P1-C.1（只读审计）  
> **审计日期**：2026-05-29  
> **版本点**：`daping-staging-P1C-audit`（须在 git 仓库根目录打 tag；当前工作区未检测到 `.git`）  
> **纪律**：未改业务逻辑 / UI / backend 运行时；仅新增本文档。

---

## 1. 执行摘要

| 维度 | 结论 |
|------|------|
| **SaaS 主读路径** | `/api/dashboard/*`、`/api/analytics/*`、`/api/orders/*`、`/api/realtime/*` 在 `saasMysqlOnlyMiddleware` 下 **禁止** 读取 `orders-cache.json` / `gmv-cache.json` / `shops.json`；聚合事实源为 **MySQL `orders` 及相关表**。 |
| **统一缓存（目标形态）** | Dashboard 聚合已收敛到 `lib/dashboardCache.js`：**memory → `dashboard_*_cache` 表 → `storage/dashboard-snapshot/*.json` → MySQL loader**（`services/orderMetricsService.js`）。 |
| **未统一部分** | Analytics 模块内仍有 **独立 60s 内存 Map**（`modules/analytics/service.js`）用于 `search-sku` / `status-debug`；OpenAPI Worker 仍 **写** `orders-cache.json`（非 SaaS 读路径）；`analytics/service.js` 中 `getTopProducts` 等 **死代码** 与 `metricRepository` 双轨并存。 |
| **Legacy API** | `GET /api/dashboard`（旧聚合）、Ops cache/reconcile 等已由 `routes/removedLegacyGone.js` 返回 **410**。 |

**统一判定（本文「是否统一」列）**

| 值 | 含义 |
|----|------|
| **YES** | 对外 API 以 MySQL 为唯一事实源，且（若存在缓存）走 **`withDashboardCache` 三层栈** 或等价 `orderMetricsService` 编排。 |
| **PARTIAL** | 事实源为 MySQL，但使用 **另一套** 进程内缓存或独立 SQL 模块，未纳入 `dashboardCache`。 |
| **NO** | 响应可能来自 **JSON 文件**、已下线 legacy 路径，或仅为 **写盘副产物**（非 SaaS 读）。 |

---

## 2. Dashboard — `GET /api/dashboard/*`

**挂载**：`backend/routes/registerApiRoutes.js` → `modules/dashboard/routes.js` + `saasMysqlOnlyMiddleware`  
**编排**：`modules/dashboard/controller.js` → `modules/dashboard/service.js` → `modules/analytics/metricService.js` → `modules/analytics/metricRepository.js` → **`services/orderMetricsService.js`**

| 接口 | 实际读取（命中顺序） | 是否统一 |
|------|----------------------|----------|
| `GET /api/dashboard/ping` | 无 DB（健康探针，`source: mysql` 声明） | YES |
| `GET /api/dashboard/summary` | memory → `dashboard_summary_cache` → snapshot `summary/` → **MySQL**（`summaryQuery` / `todayMetricsQuery`） | YES |
| `GET /api/dashboard/trend` | memory → `dashboard_trend_cache` → **MySQL**（`trendQuery`；**无** JSON snapshot） | YES |
| `GET /api/dashboard/order-volume` | 同 `trend`（endpoint `order-volume`） | YES |
| `GET /api/dashboard/order-trend` | 同 `order-volume` | YES |
| `GET /api/dashboard/ranking` | memory → `dashboard_shop_ranking_cache` → snapshot `shop-ranking/` → **MySQL**（`rankingQuery`） | YES |
| `GET /api/dashboard/shop-ranking` | 同 `ranking` | YES |
| `GET /api/dashboard/product-ranking` | memory → `dashboard_product_ranking_cache` → snapshot `product-ranking/` → **MySQL**（`productRankingQuery`） | YES |
| `GET /api/dashboard/gmv-compare` | memory → `dashboard_trend_cache` → snapshot `gmv-compare/` → **MySQL**（`gmvCompareQuery`） | YES |
| `GET /api/dashboard/gmv-trend` | 同 `gmv-compare` | YES |
| `GET /api/dashboard/orders` | **MySQL**（`ordersQuery.js`）；仅 **3s 请求去重**（`dashboardRequestDedupe`），无 snapshot | YES |

**说明**

- 今日 KPI 硬锁：`modules/dashboard/todayMetricsQuery.js`（禁止单独读 snapshot/cache 文件作 GMV/订单数真源）。
- Snapshot 开关：`DASHBOARD_SNAPSHOT_CACHE_ENABLED`；prod 部署标记下默认关（见 `lib/dashboardSnapshotCache.js`）。
- 表缓存开关：`DASHBOARD_TABLE_CACHE_ENABLED`（默认开）。

---

## 3. Analytics — `GET /api/analytics/*`

**挂载**：`modules/analytics/routes.js` + `saasMysqlOnlyMiddleware`  
**主路径**：`controller.js` → `metricService` → **`metricRepository.js`** → `orderMetricsService` / `realtime/service` / `analytics/service`（局部）

| 接口 | 实际读取 | 是否统一 |
|------|----------|----------|
| `GET /api/analytics/summary` | **MySQL**（`metricsAuthority.getUnifiedSummary` → 多次 `getTodayOrderSummary` + `getOrderTrend`） | YES |
| `GET /api/analytics/top-products` | 同 `/api/dashboard/product-ranking`（`orderMetricsService.getProductRanking`） | YES |
| `GET /api/analytics/top-shops` | 同 `/api/dashboard/ranking` | YES |
| `GET /api/analytics/shop-trend` | 同 `/api/dashboard/trend` | YES |
| `GET /api/analytics/gmv-compare` | 同 `/api/dashboard/gmv-compare` | YES |
| `GET /api/analytics/recent-orders` | **MySQL**（`realtime/service` → `dashboard/ordersQuery`） | YES |
| `GET /api/analytics/search-sku` | **MySQL** + **Analytics 独立 memCache 60s**（`analytics/service.js`） | PARTIAL |
| `GET /api/analytics/status-debug` | **MySQL** + **Analytics 独立 memCache 60s** | PARTIAL |

**未挂载但仍存在的代码**

| 模块 | 状态 |
|------|------|
| `modules/analytics/service.js` 内 `getTopProducts` / `getTopShops` / `getShopTrend` / `getRecentOrders` | 已由 `metricRepository` 替代；**HTTP 不再调用**，属死代码，增加维护噪音。 |
| `modules/analytics/analyticsCompareService.js` | **无路由引用**；GMV 对比已走 `gmvCompareQuery`。 |

---

## 4. Orders — `GET /api/orders/*`

**挂载**：`modules/orders/routes.js` + `saasMysqlOnlyMiddleware`

| 接口 | 实际读取 | 是否统一 |
|------|----------|----------|
| `GET /api/orders/list` | **MySQL** `orders`（`ordersListService` → `repository.listOrders`） | YES |
| `GET /api/orders/detail/:id` | **MySQL** | YES |
| `GET /api/orders/stats` | **MySQL**（`getUnifiedSummary` / dashboard 契约） | YES |

**已下线（410）**：`/api/orders/reconcile`、`/api/orders/cache` 等（`removedLegacyGone.js`）。

**副产物（非 API 读）**：`orderReconcileService.js` 仍可读 `orders-cache.json`，仅用于 **Ops 对账逻辑**（对应 HTTP 已 410）。

---

## 5. Realtime — `GET /api/realtime/*`

**挂载**：`modules/realtime/routes.js` + `saasMysqlOnlyMiddleware`

| 接口 | 实际读取 | 是否统一 |
|------|----------|----------|
| `GET /api/realtime/orders` | **MySQL**（`realtime/repository` → `dashboard/ordersQuery`；与 `/api/dashboard/orders` 同源） | YES |

---

## 6. 同步系统 — sync / collector / snapshot / cache

### 6.1 HTTP 入口

| 入口 | 方法 | 数据源 | 是否统一 |
|------|------|--------|----------|
| `GET /api/sync/ping` | 无 DB | YES |
| `GET /api/sync/status` | **MySQL** `shops` + `shop_sync_status` + `sync_shop_logs` | YES |
| `GET /api/sync/logs` | **MySQL** `sync_shop_logs` | YES |
| `POST /api/sync/run/:shopId` | **MySQL** 写订单/日志；触发 OpenAPI | YES（写路径） |
| `POST /api/sync/retry/:shopId` | 同上 | YES |
| `GET /api/sync-jobs/` | **MySQL** `sync_jobs`（`syncJobRepository`） | YES |

### 6.2 Collector / Worker（非 HTTP，影响数据新鲜度）

| 组件 | 文件 | 写入 | 读取（SaaS API） |
|------|------|------|------------------|
| OpenAPI 定时采集 | `tiktok-api/scheduler.js` `collectOnce` | **MySQL** `orders`；**@deprecated 合并写** `storage/orders-cache.json` | SaaS **不读** JSON |
| 单店手动同步 | `modules/sync/shopSyncRunner.js` | OpenAPI → persist → **MySQL** | YES |
| 队列 Worker | `scripts/syncQueueWorker.js` | **MySQL** `sync_jobs` | YES |
| Dashboard 表缓存刷新 | `lib/dashboardRefreshScheduler.js` | 预热 `dashboard_*_cache` | 加速读，事实源仍 MySQL |
| Snapshot 预热 | `lib/dashboardSnapshotWarmScheduler.js` | 写 `storage/dashboard-snapshot/**` | 加速读，事实源仍 MySQL |
| Snapshot 清理 | `server.js` 启动钩子 | 删过期 snapshot 文件 | — |
| Cache 预热 | `lib/dashboardCacheWarmup.js` | memory / table | — |

### 6.3 本地 JSON / SQLite（写盘或 legacy）

| 路径 | 角色 | SaaS API 读取 |
|------|------|---------------|
| `backend/storage/orders-cache.json` | Worker 副产物；历史 legacy | **禁止**（`saasMysqlOnly`） |
| `backend/storage/gmv-cache.json` | 历史汇率/店铺 | **禁止** |
| `backend/storage/shops.json` | OAuth/`OPENAPI_SHOPS_SOURCE=json` 回滚 | **禁止**（SaaS 用 MySQL `shops`） |
| `backend/storage/dashboard-snapshot/**` | Dashboard 只读加速层 | 经 `dashboardCache` 间接读，loader 仍为 MySQL |
| `backend/data/dashboard.db` | SQLite 初始化遗留 | **无业务引用** |

---

## 7. 接口总表（SaaS 读路径）

| 接口 | 数据源（对外事实） | 是否统一 |
|------|-------------------|----------|
| `/api/dashboard/summary` | mysql (+ dashboardCache) | YES |
| `/api/dashboard/trend` | mysql (+ table/mem cache) | YES |
| `/api/dashboard/ranking` | mysql (+ dashboardCache) | YES |
| `/api/dashboard/product-ranking` | mysql (+ dashboardCache) | YES |
| `/api/dashboard/gmv-compare` | mysql (+ dashboardCache) | YES |
| `/api/dashboard/orders` | mysql | YES |
| `/api/analytics/summary` | mysql | YES |
| `/api/analytics/top-products` | mysql (+ dashboardCache) | YES |
| `/api/analytics/top-shops` | mysql (+ dashboardCache) | YES |
| `/api/analytics/shop-trend` | mysql (+ dashboardCache) | YES |
| `/api/analytics/gmv-compare` | mysql (+ dashboardCache) | YES |
| `/api/analytics/recent-orders` | mysql | YES |
| `/api/analytics/search-sku` | mysql + analytics-memCache | PARTIAL |
| `/api/analytics/status-debug` | mysql + analytics-memCache | PARTIAL |
| `/api/orders/list` | mysql | YES |
| `/api/orders/detail/:id` | mysql | YES |
| `/api/orders/stats` | mysql | YES |
| `/api/realtime/orders` | mysql | YES |
| `/api/sync/status` | mysql | YES |
| `/api/sync/logs` | mysql | YES |
| `/api/sync-jobs/` | mysql | YES |
| `/api/legacy-dashboard`（及同类） | — | NO（410 已移除） |
| Worker → `orders-cache.json` | json（写） | NO（非 SaaS 读） |

---

## 8. 统计（项目剩余异构数据源）

| 类型 | 数量 | 说明 |
|------|------|------|
| **JSON 文件（存储级）** | **3** 主文件 | `orders-cache.json`、`gmv-cache.json`、`shops.json`（+ 可选 `tiktokSnapshot.json`） |
| **JSON Snapshot 目录** | **1** 套（多文件） | `storage/dashboard-snapshot/{summary,shop-ranking,product-ranking,gmv-compare,order-volume}/` |
| **Cache 层** | **4** 类 | ① `dashboardCache` 内存；② MySQL `dashboard_*_cache` 表（6 张逻辑表）；③ snapshot JSON；④ Analytics 独立 `memCache`（2 端点） |
| **MySQL 事实表** | **1** 主域 | `orders`（+ `order_items`、`shops`、`exchange_rates`、`sync_shop_logs`、`sync_jobs` 等） |
| **SaaS API 直接读 JSON** | **0** | `saasMysqlOnly` 阻断 |

**Dashboard 缓存表（MySQL）**

- `dashboard_summary_cache`
- `dashboard_shop_ranking_cache`
- `dashboard_product_ranking_cache`
- `dashboard_trend_cache`（含 trend / gmv-compare / order-volume）

---

## 9. 统一路线图（P1-C 后续）

### 第一批：删除（无 SaaS 依赖）

| 项 | 动作 |
|----|------|
| `analytics/service.js` 未使用导出 | 删除或迁入 quarantine：`getTopProducts`、`getTopShops`、`getShopTrend`、`getRecentOrders` |
| `analyticsCompareService.js` | 删除或 quarantine（已由 `gmvCompareQuery` 替代） |
| `server.js` 未调用存储聚合 | 清理 `readOrdersAggregateFromStorage` 等死代码（若仍存在） |
| SQLite `dashboard.db` | 确认零引用后删除初始化 |

### 第二批：迁移（纳入统一 `dashboardCache`）

| 项 | 动作 |
|----|------|
| `GET /api/analytics/search-sku` | 改走 `withDashboardCache` 或共享 `dashboardCache` key 工厂；去掉独立 `memCache` |
| `GET /api/analytics/status-debug` | 同上 |
| `GET /api/dashboard/orders` / `GET /api/realtime/orders` | 评估是否纳入 snapshot（只读加速）；保持 **禁止** 以 cache 替代 MySQL loader |

### 第三批：废弃（写盘与运维副产物）

| 项 | 动作 |
|----|------|
| `orders-cache.json` 写入 | `scheduler.collectOnce` 在 `isDashboardMysqlOnly()` 下停写；仅保留 MySQL |
| `gmv-cache.json` / `shops.json` | 文档化 + 移除 OpenAPI `json` 店铺源（强制 `OPENAPI_SHOPS_SOURCE=mysql`） |
| `orderReconcileService` | 已 410；代码迁入 `legacy-quarantine` |
| Snapshot 文件 | staging 验证后：prod 长期关闭 snapshot 读，仅保留 table+memory；或统一 object store 策略 |

---

## 10. 代码锚点（审计依据）

|  Concern | 文件 |
|----------|------|
| SaaS MySQL-only 门禁 | `backend/middlewares/saasMysqlOnly.js`、`backend/lib/saasMysqlOnly.js` |
| 统一聚合入口 | `backend/services/orderMetricsService.js` |
| 三层缓存编排 | `backend/lib/dashboardCache.js` |
| Snapshot | `backend/lib/dashboardSnapshotCache.js` |
| Table cache | `backend/lib/dashboardTableCache.js` |
| Analytics 路由编排 | `backend/modules/analytics/metricRepository.js` |
| 410 Legacy | `backend/routes/removedLegacyGone.js` |
| 数据源策略 | `docs/data-source-policy.md`、`docs/deprecated-data-sources.md` |

---

## 11. Build

```text
cd frontend && npm run build
✓ tsc -b && vite build（审计日执行通过）
```

本任务 **未修改** frontend/backend 源码；build 验证现有基线可编译。

---

## 12. 版本点

在 git 仓库根目录执行（当前工作区 **无** `.git`，需在有仓库的环境补打）：

```bash
git tag -a daping-staging-P1C-audit -m "P1-C.1 data source audit baseline (docs only)"
```
