# Deprecated 清单

> 仍被引用但不得作为新功能数据源。新开发一律走 MySQL API。

| ID | 路径/能力 | 原因 | 替代 |
|----|-----------|------|------|
| D01 | `storage/shops.json` 作 worker 主源 | 多源不一致 | `readSyncShops.js` + MySQL |
| D02 | `OPENAPI_SHOPS_SOURCE=json` | 紧急回滚 | `mysql` |
| D03 | `DASHBOARD_DATA_SOURCE=cache` | 旧大屏 cache 主读 | `mysql` |
| D04 | `App.tsx` → `GmvDashboard` 路由 `/legacy` | 旧单页 BI | `/dashboard` |
| D05 | `server.js` `/api/dashboard` `/products` `/orders` | 旧 war-room 聚合 | `/api/analytics/*`；新 `/api/dashboard/summary` 等 |
| D05b | `/analytics` 前端路由 | 合并至 SaaS 主入口 | `/dashboard` |
| D06 | `pickDashboardShop()` CQ Chic 优先 | 调试偏见 | MySQL 店铺列表 |
| D07 | `POST /api/shops/import-cache` | 从 cache 导入店 | OAuth + MySQL |
| D08 | `shopHealthService.loadOpenApiSyncStateByPlatformShopId()` 同步版 | 仅读 json | `loadOpenApiSyncStateByPlatformShopIdAsync` |
| D09 | `gmv-cache.json` 汇率主源 | 侧车文件 | DB settings / 实时汇率 API |
| D10 | `dataSources/mock.js` | 无引用 | 删除 |
| D11 | `GET /api/orders/reconcile` | 阶段九正式废弃（`deprecated: true`） | `GET /api/ops/orders/reconcile`（平台运维） |
| D12 | `POST /api/tiktok/collect-now` | 全量 cache 采集 | `/api/sync/run/:shopId` |
| D13 | 新 SaaS 页读 `orders-cache.json` | cache 非主源 | MySQL orders API |
| D14 | `GET /api/shops` 无分页全量返回 | 阶段五已分页 | `page` + `page_size` |
| D15 | SaaS 页内 `apiFetch` 直连 | 阶段五收口 | `frontend/src/services/api/*.ts` |
| D16 | `saasNav` 对 viewer 隐藏 shops/sync | 阶段五放开只读 | 路由 + `dataScope` |
| D17 | `UserMgmtPage` 全屏旧布局 + 直接 `apiFetch` | 阶段六 | `pages/Users/UsersPage` + `services/api/users.ts` |
| D18 | `GET /api/users` 无分页全量 | 阶段六 | `page` + `page_size` |
| D19 | 平台管理员 PUT shop-permissions | 阶段六补丁 | 仅租户 admin 分配 viewer 店铺 |
| D20 | 平台 GET /api/users 含全量 viewer | tenant 隔离补丁 | 平台列表排除 viewer |
| D21 | SaaS `summaryService` 读 orders-cache | 阶段七 | MySQL 24h 店铺计数 |
| D22 | SaaS `analyticsCompareService` 读 orders-cache/gmv-cache | 阶段七 | MySQL + `saasExchangeRates` |
| D23 | SaaS `/api/shops` meta 暴露 orders_cache_path | 阶段七 | `data_source: mysql` |
| D24 | worker 写 orders-cache.json | 阶段七标记 deprecated | MySQL 主源；legacy 只读 cache |
| D25 | `migrateGmvCacheToExchangeRates.js` | 运维一次性 | `exchange_rates` 表 |
| D26 | `shopHealthService` 读 orders-cache / shops.json fallback | 阶段七补丁 | MySQL only + legacy 段导出 |
| D27 | `shopHealthService.loadOpenApiSyncStateByPlatformShopId` | 运维脚本 only | `loadOpenApiSyncStateByPlatformShopIdAsync` |
| D28 | `POST /api/shops/import-cache`（SaaS shops 路由） | 阶段八迁至 Ops | `POST /api/ops/import-cache`（平台管理员） |
| D29 | `GET /api/orders/reconcile`（SaaS orders 路由） | 阶段八迁至 Ops | `GET /api/ops/orders/reconcile` |
| D30 | `POST /api/orders/cache/rebuild-from-mysql` | 阶段八迁至 Ops | `POST /api/ops/orders/rebuild-cache` |
| D31 | `server.js` 内联 legacy `/api/dashboard` 聚合 | 阶段八抽取 | `routes/legacyDashboardRoutes.js` |
| D32 | 租户 admin 调用 import/reconcile | Ops 权限收紧 | 仅 `isPlatformScope` |
| D33 | `ShopMgmtPanel` 直调 `/api/shops/import-cache*`、`/api/orders/reconcile` | 阶段八补丁 | `services/api/ops.ts` → `/api/ops/*` |
| D34 | SaaS 页展示 `shops.json` / `orders-cache` / `gmv-cache` 诊断文案 | 阶段十补丁 | `sync/saasSyncLabels` + `authorizations/aggregate` 统一业务文案 |
| D34 | `ReconcilePanel` 直调旧 reconcile/rebuild | 阶段九废弃 | 组件仅保留 @deprecated 占位 |
| D35 | 前端路由 `/reconcile`、`ReconcilePage` | 阶段九废弃 | 重定向 `/dashboard`；排障用 Sync / Orders |
| D36 | 旧 war-room 顶栏「订单对账」链 `/reconcile` | 阶段九补丁已移除 `DashboardHeader` 按钮 | 直链 `/reconcile` 仍重定向 `/dashboard` |
| D37 | `ReconcilePage.tsx` / `ReconcilePanel.tsx` | 阶段十 dead code 清理 | 已删除 |
| D38 | `AppPageContext` 含 `reconcile` | 阶段十 | 已从 `DashboardHeader` 移除 |
