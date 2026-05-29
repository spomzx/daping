# MySQL Only Dashboard 清场审计（Phase 1）

分支：`hotfix/mysql-only-dashboard-cleanup`  
日期：2026-05-22

## 根因（staging 2026-05：orders 有数 / summary 为 0）

`buildDashboardWhere` 已在 `where.params` 首项写入 `tenant_id`；**summary / ranking / trend / gmv-compare** 又执行 `[tenantId, ...where.params]`，导致占位符错位：`market=TH` 被绑定为 `tenantId=6`，统计全空。

**orders** 因子查询 `oi.tenant_id = ?` 出现在 SQL 最前，多出的 prepend `tenantId` 恰好对齐占位符，故仅 orders 有数据。

**修复：** 统一使用 `dashboardWhereParams(where)`；order_items 子查询改为 `oi.tenant_id = o.tenant_id` 关联，不再额外 `?`。

**验收：** 同一 `filterHash` 下 orders / summary / ranking / product-ranking 均 `rows>0`。

---

## 结论（根因 — 历史 UI 键）

| 模块 | 修复前 shopId 来源 | 修复后 |
|------|-------------------|--------|
| 实时订单 | `resolvedShopId`（MySQL id / platform id） | 不变 |
| summary/ranking/product-ranking | `legacyUiShopKey` 覆盖为 UI 原始键 | `buildDashboardApiQuery(..., resolvedShopId)` |
| GMV趋势 / 订单走势 | `resolvedShopId` | 不变 |

当 UI 键无法被后端 `resolveShopClause` 解析时 → `invalidShop=true` → summary 返回 0，但 orders 仍用正确 id 有数据。

---

## 一、旧数据源搜索命中清单

### A. 必须重写为 MySQL（Dashboard 主链路 — 已完成）

| 文件 | 说明 | 状态 |
|------|------|------|
| `backend/modules/dashboard/ordersQuery.js` | `orders` 表 + `buildDashboardWhere` | ✅ MySQL |
| `backend/modules/dashboard/summaryQuery.js` | `orders` 聚合 WITH ROLLUP | ✅ MySQL |
| `backend/modules/dashboard/rankingQuery.js` | `orders` GROUP BY shop | ✅ MySQL |
| `backend/modules/dashboard/productRankingQuery.js` | `order_items` JOIN `orders` | ✅ MySQL |
| `backend/modules/dashboard/trendQuery.js` | `orders` 时间桶 | ✅ MySQL |
| `backend/modules/dashboard/gmvCompareQuery.js` | `orders` 曲线 | ✅ MySQL |
| `backend/services/orderMetricsService.js` | 统一入口，禁止 cache | ✅ MySQL |

### B. 必须迁移到 legacy / quarantine（禁止 Dashboard 生产引用）

| 文件 | 命中 | 处置 |
|------|------|------|
| `backend/tiktok-api/ordersDashboardFromCache.js` | orders-cache 聚合 | 📦 `legacy-quarantine/` 登记；仅 legacy 路由 / ops |
| `backend/routes/legacyDashboardRoutes.js` | `/api/legacy-dashboard` | 🔒 默认不挂载（`ENABLE_LEGACY_DASHBOARD_ROUTES=1` 才启用） |
| `backend/routes/legacyRoutes.js` | registerLegacyRoutes | 🔒 同上 |
| `backend/tiktok-api/scheduler.js` | 写 orders-cache.json | ✅ `DASHBOARD_MYSQL_ONLY=1` 默认跳过写盘 |
| `backend/scripts/tiktokOpenApiSyncWorker.js` | target=orders-cache+mysql | ✅ 日志改为 target=mysql |
| `backend/modules/shops/importCacheShops.js` | 从 cache 导入 | 📦 ops-only |
| `backend/modules/orders/orderCacheRebuildService.js` | 重建 cache | 📦 ops-only |
| `backend/lib/ordersCachePath.js` | cache 路径 | 📦 legacy 工具 |
| `frontend/src/components/dashboard/gmvCompareFetch.ts` | `/api/analytics/gmv-compare` | ⚠️ deprecated，大屏未引用 |

### C. 必须保留但禁止生产 Dashboard 引用

| 文件 | 说明 |
|------|------|
| `backend/lib/readSyncShops.js` | 默认 `OPENAPI_SHOPS_SOURCE=mysql`；json 仅紧急回滚 |
| `backend/lib/saasMysqlOnly.js` | SaaS API 拦截 legacy fallback |
| `backend/lib/dataSourceDebug.js` | debug.source=mysql |
| `backend/modules/ops/*` | 运维对账 / 导入 cache |
| `backend/scripts/rebuildOrdersCacheFromMysql.js` | 一次性运维 |
| `backend/scripts/migrateGmvCacheToExchangeRates.js` | 一次性迁移 |

### D. 可删除（第二阶段物理删除，本阶段不 rm）

| 路径 | 说明 |
|------|------|
| `storage/orders-cache.json` | 运行时备份，禁止 dashboard 读 |
| `storage/gmv-cache.json` | 同上 |
| `storage/shops.json` | 同上 |

### E. 非 Dashboard 命中（不动）

| 文件 | 说明 |
|------|------|
| `frontend/src/lib/exchangeRateFallback.ts` | 汇率 UI fallback（非订单数据） |
| `frontend/src/i18n/*.json` | 文案含 orders-cache 字样（待 i18n 更新） |
| `backend/db/orderRepository.js` | SQLite 预留，未接 dashboard |
| `backend/db/sqliteOrdersInit.js` | SQLite 初始化 |

---

## 二、Dashboard 接口统一契约

所有接口经 `parseDashboardFilterQuery` + `buildDashboardWhere`：

| 字段 | SQL 作用 |
|------|----------|
| tenantId | `orders.tenant_id = ?` |
| shopId | `shops` 解析 → `orders.shop_id = ?`；all 不限 |
| market | `orders.market` 条件 |
| orderFilter / orderStatus | `order_status` + `raw_json`（paid/valid/…） |
| timeRange + startDate/endDate | `DATE(COALESCE(paid_at, created_at_platform, created_at))` |
| timezone | 服务器本地日历日（与 staging 一致） |

### 接口 → 表 → sqlTag

| HTTP | 表 | sqlTag |
|------|-----|--------|
| GET /api/dashboard/orders | orders (+ order_items 件数) | realtime_orders_limit |
| GET /api/dashboard/summary | orders | summary_orders_count_and_gmv_group |
| GET /api/dashboard/ranking | orders | ranking_shop_currency_group |
| GET /api/dashboard/product-ranking | order_items ⋈ orders | product_ranking_items_join_group |
| GET /api/dashboard/gmv-compare, /gmv-trend | orders | gmv_compare_* |
| GET /api/dashboard/order-volume, /order-trend | orders | trend_hour_dateformat_group |

---

## 三、日志格式（已实现）

```
[dashboard-contract] endpoint=summary source=mysql tenantId=1 shopId=42 market=ALL orderStatus=paid timeRange=today startDate= endDate= rows=15 durationMs=120 reason=
[dashboard-contract] endpoint=summary source=mysql ... rows=0 reason=shop_filter_no_match
```

`rows=0` 时 `reason` 必填：`shop_filter_no_match` | `no_orders_matched_filter` | …

---

## 四、验收 grep（staging 部署后）

```bash
# Dashboard 模块不得引用 cache
rg -n "orders-cache|gmv-cache|shops\.json|readJsonCache" backend/modules/dashboard backend/services/orderMetricsService.js

# 前端大屏不得调 legacy 聚合
rg -n "legacy-dashboard|/api/gmv/current|orders-cache" frontend/src/legacy frontend/src/components/RealtimeOrdersPanel.tsx

# 契约日志
pm2 logs daping-staging --lines 200 | grep dashboard-contract
```

---

## 五、环境变量

| 变量 | 默认 | 说明 |
|------|------|------|
| `DASHBOARD_MYSQL_ONLY` | `1` | OpenAPI worker 不写 orders-cache.json |
| `OPENAPI_SHOPS_SOURCE` | `mysql` | 禁止生产默认 json |
| `ENABLE_LEGACY_DASHBOARD_ROUTES` | 未设置 | 不设则禁用 legacy dashboard 路由 |
