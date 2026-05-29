# SaaS 数据源统一地图（Phase 2）

> **Baseline**：`daping-staging`（clean 后）为唯一开发基础。  
> **目标**：所有业务数据读取遵守统一链路，禁止 JSON/SQLite/cache fallback。

## 统一数据链路（强制）

```
TikTok API / Sync Job
  → MySQL（orders / shops / shop_auth_tokens / exchange_rates / sync_*）
    → backend service 层
      → backend route 层（HTTP + 权限 + 参数）
        → frontend services/api/*
          → 页面组件（展示 only）
```

## 禁止项（运行时）

| 禁止 | 说明 |
|------|------|
| `orders-cache.json` / `gmv-cache.json` | SaaS 路由不得读取；`saasMysqlOnlyMiddleware` 阻断 |
| `shops.json` | SaaS 店铺列表必须 MySQL；`GET /api/tiktok/shops` 仍为 legacy（待迁移） |
| `dashboard.db` / SQLite | 未接入 SaaS 主路由；仅诊断脚本可选 |
| `storage/*.json` fallback | 禁止作为 KPI/订单统计源 |
| 前端拼复杂统计 | 日期窗、GMV、订单数由后端生成 |

门禁：`node backend/scripts/auditSaasUnification.js`、`npm run check:no-dashboard-legacy`（backend）。

---

## 1. Backend 数据读取入口

### 订单 Orders

| 层级 | 路径 | 表 |
|------|------|-----|
| Route | `modules/orders/routes.js` | — |
| Service | `modules/orders/ordersListService.js` | `orders` |
| Repository | `modules/orders/repository.js` | `orders`, `order_items` |
| 持久化 | `orderPersistenceService.js`, `orderItemPersistenceService.js` | 写入 |
| 大屏实时 | `modules/dashboard/warRoomOrders.js` | `orders` |
| 列表统计 | `GET /api/orders/list`, `/stats` | `orders` |

### GMV / 今日 KPI（LOCKED）

| 层级 | 路径 | 说明 |
|------|------|------|
| **唯一聚合** | `modules/dashboard/todayMetricsQuery.js` | `COUNT(DISTINCT o.id)` + 分币种 SUM → USD |
| Summary | `summaryQuery.js` → `queryTodayMetricsTenantTotal` | 今日主卡 |
| Ranking | `rankingQuery.js` | 店铺排行 |
| Shops 列表 | `shopTodayStats.js` → todayMetrics | `today_orders`, `today_gmv` |
| Compare | `gmvCompareQuery.js` | 今昨分时（非 KPI 主数字） |
| Analytics 并行 | `analytics/analyticsCompareService.js` | **待合并** |

### 店铺 Shops

| 层级 | 路径 | 表 |
|------|------|-----|
| Route | `modules/shops/routes.js` | — |
| Service | `modules/shops/service.js` | `shops` |
| 授权 | `modules/authorizations/*` | `shops`, tokens |
| Legacy | `server.js` `GET /api/tiktok/shops` | **shops.json**（待迁） |
| 同步状态 | `modules/sync/*`, `syncJobs/*` | `sync_shop_logs`, `shop_sync_status` |

### 汇率 Currency

| 层级 | 路径 | 表 |
|------|------|-----|
| Route（待迁） | `server.js` `GET /api/exchange-rate` | — |
| Service | `modules/exchangeRateService.js` | `exchange_rates` |
| Lib | `lib/rates.js`, `lib/saasExchangeRates.js` | — |
| Settings | `modules/settings/*` | `exchange_rates` |

### 用户 / 租户

| 域 | Route 模块 | 表 |
|----|------------|-----|
| Auth | `modules/auth/*` | `users`, sessions/JWT |
| Users | `modules/users/*` | `users`, `user_shop_permissions` |
| Tenants | `modules/tenants/*` | `tenants`, plans |

### 挂载入口

- `routes/registerApiRoutes.js`：SaaS 主链路 + `saasMysqlOnlyMiddleware`
- `server.js`：auth、TikTok OAuth、汇率、health、静态资源

---

## 2. Frontend API 入口

| 层 | 路径 | 用途 |
|----|------|------|
| 传输 | `src/apiClient.ts` | `apiFetch`, `fetchWithAuth`, 登录 |
| Service | `src/services/api/*.ts` | 业务 API 封装 |
| 平台租户 | `src/lib/platformViewTenant.ts` | `?tenant_id=` 注入 |

**绕过 service 的热点**（待收敛）：

- `legacy/LegacyDashboardPage.tsx` — 混用 service + apiFetch
- `GmvCompareTrendPanel.tsx`, `OrderVolumeChart.tsx`, `RealtimeOrdersPanel.tsx` — 直连 dashboard API
- `AnalyticsPage.tsx` — 本地 fetchJson → analytics API
- `ShopMgmtPanel.tsx` — shops service + apiFetch 并行

---

## 3. Legacy / Cache / SQLite 引用状态

| 类型 | 状态 | 位置示例 |
|------|------|----------|
| orders-cache / gmv-cache | SaaS **禁止**；scheduler 可写盘（默认关） | `tiktok-api/scheduler.js`, quarantine |
| shops.json | **server TikTok shops 仍读** | `tiktok-api/shops.js`, `server.js` L386 |
| SQLite | 未挂 SaaS 路由 | `db/sqlite*.js` |
| 410 Gone | 旧 reconcile/import-cache | `routes/removedLegacyGone.js` |

---

## 4. 重复算法（需合并登记）

| 指标 | 实现 A | 实现 B | 建议 |
|------|--------|--------|------|
| 今日 GMV/订单 | `todayMetricsQuery.js` | — | **锁定 A** |
| GMV 对比曲线 | `gmvCompareQuery.js` | `analyticsCompareService.js` | 合并为 shared compare service |
| 趋势累计 | `trendQuery.js` | `analytics/service.js` | 共享 `buildDashboardWhere` |
| collect-now KPI | `tiktok-api/normalize.js` | TMQ | 仅 OpenAPI 采集，不用于 SaaS 展示 |

---

## 5. Route 层统计逻辑

**原则**：`routes.js` 无 SQL；统计在 `*Query.js` / `repository.js` / `service.js`。

| 风险 | 位置 |
|------|------|
| Controller 内联 SQL | `modules/shops/controller.js`（user_tenants 查询） |
| 重 WHERE 构建 | `modules/dashboard/filterContract.js` |
| Analytics 大 service | `modules/analytics/service.js` |

---

## 迁移计划（本阶段不强行重构）

1. **P0**：锁定 `todayMetricsQuery` + 文档 + audit 脚本（本交付）
2. **P1**：合并 gmv-compare 双实现
3. **P2**：`server.js` 汇率 → `modules/currency`；TikTok shops → MySQL `/api/shops` 或 `modules/sync`
4. **P3**：前端作战室全部走 `services/api/dashboard.ts`
5. **P4**：统一 `timeWindow` 响应契约

---

## 相关文档

- [`data-source-policy.md`](./data-source-policy.md) — KPI 硬锁
- [`metric-definition-map.md`](./metric-definition-map.md) — 指标口径
- [`module-boundary-map.md`](./module-boundary-map.md) — 模块边界
- [`api-permission-matrix.md`](./api-permission-matrix.md) — 权限矩阵
- [`locked-baseline.md`](./locked-baseline.md) — 锁定纪律
