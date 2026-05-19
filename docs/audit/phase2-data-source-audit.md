# Phase 2-1｜SaaS 数据源稳定化审计

> **审计类型**：只读（不改业务代码 / API / DB / 同步器 / UI）  
> **审计日期**：2026-05-19  
> **环境假设**：生产/预发默认 `DASHBOARD_DATA_SOURCE` 未设置或 `mysql`；MySQL 已配置 `DB_*`。

## 1. 执行摘要

| 结论 | 说明 |
|------|------|
| **SaaS 主路径** | `backend/modules/*` 下看板、分析、订单、店铺、同步、租户、用户均已以 **MySQL** 为读写主源，与 `docs/data-source-policy.md` 一致。 |
| **未统一到 MySQL 的路径** | 主要集中在 **Legacy War-Room**（`/legacy` → `GET /api/dashboard`）、**OpenAPI Worker 写盘**（`orders-cache.json`）、**TikTok 直连路由**（`readShops()` → `shops.json`）、**SQLite 初始化**（`data/dashboard.db`，当前无业务引用）、**运维 Ops**（cache 导入/对账/重建）。 |
| **环境开关** | `DASHBOARD_DATA_SOURCE=cache` 仅影响 **legacy** 聚合读 `orders-cache.json`；**不影响** `modules/dashboard`（SaaS `/api/dashboard/summary` 等）。 |
| **前端路由** | 登录默认进 `/legacy`（旧大屏）；SaaS 控制台 `/dashboard` 使用 `AnalyticsPage` + `/api/analytics/*` + `/api/dashboard/summary|trend`，**不调用** legacy `GET /api/dashboard`。 |

---

## 2. 模块数据来源矩阵

| # | 模块 | SaaS / 主 API | 主数据源 | MySQL 主源？ | Fallback / Legacy | 本地 JSON / Cache / SQLite | 风险 | 建议 |
|---|------|---------------|----------|-------------|-------------------|---------------------------|------|------|
| 1 | **GMV** | SaaS: `GET /api/dashboard/summary`, `GET /api/analytics/gmv-compare` | `orders` + `exchange_rates`（分析侧 `buildSaaSFxContext`） | ✅ 是 | 汇率：MySQL → Frankfurter API → 内置常量 | Legacy: `orders-cache` / `gmv-cache`（见 #13） | P1（legacy 与 SaaS 口径可能不一致） | SaaS **保留**；legacy **隔离** |
| 2 | **orders** | `GET /api/orders/list`, `/stats`, `/detail/:id` | MySQL `orders` | ✅ 是 | 无 cache 回退 | 无（列表路径） | — | **保留** |
| 3 | **shops** | `GET /api/shops`, `/summary`, `/health` | MySQL `shops`, `shop_auth_tokens` | ✅ 是 | MySQL 不可用时空列表，**不**读 `shops.json`（SaaS 健康） | Ops: `POST /api/ops/import-cache` 从 cache 导入 | P1（Ops 误用） | SaaS **保留**；Ops **隔离** |
| 4 | **tenants** | `GET/PATCH /api/tenants` | MySQL `tenants`, `user_tenants`, 等 | ✅ 是 | 无 | 无 | — | **保留** |
| 5 | **users** | `GET/POST/PATCH /api/users` | MySQL `users`, `user_tenants`, `user_shop_permissions` | ✅ 是 | 无 | 无 | — | **保留** |
| 6 | **exchange rates** | `GET /api/settings`（`exchange_rates` 表） | MySQL `exchange_rates` | ✅ 是（SaaS） | `buildSaaSFxContext`: MySQL → `getConversionRate`（Frankfurter + 内存缓存 + 常量） | Legacy 大屏仍可读 `gmv-cache.json` | P1 | SaaS **保留**；淘汰 legacy 读 `gmv-cache` |
| 7 | **sync status** | `GET /api/sync/status`, `/logs` | MySQL `shops` + `sync_shop_logs` + `syncMetrics` | ✅ 是 | 诊断文案过滤 cache 关键字 | Worker 仍写 `orders-cache`（非 SaaS 读路径） | P2 | **保留**；文档标明 worker 写盘为 deprecated |
| 8 | **realtime orders** | `GET /api/dashboard/orders` | MySQL（`warRoomOrders.js` ≈ `analytics/recent-orders`） | ✅ 是 | 无 cache | 无 | — | **保留** |
| 9 | **product ranking** | `GET /api/analytics/top-products` | MySQL `orders` / `order_items` 聚合 | ✅ 是 | 无 | Legacy 大屏从 cache 订单内存聚合 | P1（仅 legacy 用户） | SaaS **保留**；legacy **隔离** |
| 10 | **shop ranking** | `GET /api/dashboard/ranking`, `/api/analytics/top-shops` | MySQL | ✅ 是 | trend 无数据时用当日汇总单点 `_fallback`（仍 MySQL） | 无 | P2 | **保留** |
| 11 | **dashboard summary** | `GET /api/dashboard/summary` | MySQL `orders`（`modules/dashboard/repository`） | ✅ 是 | `mysql_unavailable` → 503 | 无 | — | **保留** |
| 12 | **analytics** | `GET /api/analytics/*` | MySQL | ✅ 是 | 无 orders-cache / gmv-cache | 无 | — | **保留** |
| 13 | **legacy `/dashboard`** | `GET /api/dashboard`, `/api/gmv/current`（`legacyDashboardRoutes.js`） | 默认 **MySQL**（`isMysqlPrimaryDashboard()`） | ⚠️ 可切换 | `DASHBOARD_DATA_SOURCE=cache` → `orders-cache.json`；汇率可 `gmv-cache.json`；店铺 gate 失败时平台用户可读 `readShops()` | `orders-cache`, `gmv-cache`, `shops.json` | **P0**（cache 模式影响真实展示） | **隔离**；生产禁止 `cache` |
| 14 | **SaaS admin `/dashboard`** | 前端 `AnalyticsPage`（`saasMode`） | `/api/analytics/*` + `/api/dashboard/summary|trend`（`GmvCompareTrendPanel`） | ✅ 是 | 同 #6 汇率链 | 不调用 legacy `/api/dashboard` | P2 | **保留** |

---

## 3. Legacy / Cache / SQLite / 本地文件清单

### 3.1 文件与目录

| 路径 | 写入方 | 读取方（运行时） | 用途 |
|------|--------|------------------|------|
| `backend/storage/orders-cache.json` | `tiktok-api/scheduler.js`, `tiktokOpenApiSyncWorker.js` | `legacyDashboardRoutes`（`DASHBOARD_DATA_SOURCE=cache`）；Ops 对账/重建 | OpenAPI 同步副产物；legacy 回滚 |
| `backend/storage/gmv-cache.json` | 历史采集（已基本停用） | `legacyDashboardRoutes` 汇率 fallback | 仅 legacy |
| `backend/storage/shops.json` | `tiktok-api/shops.writeShops`, OAuth `client.js` | `readShops()`：`server.js` TikTok 调试路由；legacy 店铺 catalog；`OPENAPI_SHOPS_SOURCE=json` | Token/店铺紧急回滚 |
| `backend/storage/tiktokSnapshot.json` | 采集脚本 | `server.js` 静态读 | 调试/快照 |
| `backend/storage/tiktokOrders_*.json` | 历史 | `server.js` `readOrdersAggregateFromStorage`（**已定义未调用**，死代码） | 可后续删除 |
| `backend/data/dashboard.db` | `db/sqlite.js` 启动初始化 | `db/orderRepository.js`（**无 require 引用**，死代码） | SQLite 遗留 |
| `backend/storage.local.bak/*` | 备份 | 仅 `scripts/importCaveraFromShopsJson.js` 等 | 一次性脚本 |

### 3.2 环境变量

| 变量 | 默认值 | 影响 |
|------|--------|------|
| `DASHBOARD_DATA_SOURCE` | `mysql`（非 `cache` 即 MySQL） | 仅 **legacy** `GET /api/dashboard` 订单来源 |
| `OPENAPI_SHOPS_SOURCE` | `mysql` | `json` 时同步 worker 读 `shops.json` |
| `SHOPS_JSON_PATH` | `backend/storage/shops.json` | 覆盖 shops 文件路径 |
| `STORAGE_DIR` | `backend/storage` | cache 根目录 |
| `DAPING_DB_PATH` | `backend/data/dashboard.db` | SQLite 路径 |

### 3.3 关键代码锚点

```143:145:backend/modules/orders/mysqlDashboardOrdersService.js
function isMysqlPrimaryDashboard() {
  return String(process.env.DASHBOARD_DATA_SOURCE || 'mysql').trim().toLowerCase() !== 'cache';
}
```

```151:170:backend/routes/legacyDashboardRoutes.js
        if (isMysqlPrimaryDashboard()) {
          const mysqlPack = await loadDashboardOrdersFromMysql({ ... });
          ...
        } else {
          const pack = readJsonSafe(path.join(STORAGE_DIR, 'orders-cache.json')) || {};
          rawOrders = Array.isArray(pack.orders) ? pack.orders : [];
          dashboardDataSource = 'orders-cache.json';
        }
        const gmvCache = readJsonSafe(path.join(STORAGE_DIR, 'gmv-cache.json')) || {};
```

```72:73:backend/tiktok-api/scheduler.js
 * OpenAPI 同步：主写入 MySQL orders；并 **@deprecated** 合并写入 orders-cache.json
```

---

## 4. 前端数据消费

| 页面 | 路由 | 主要 API | 数据源层级 |
|------|------|----------|------------|
| Legacy War-Room | `/legacy` | `GET /api/dashboard?...` | Legacy 层（MySQL 或 cache） |
| SaaS 数据总览 | `/dashboard` | `/api/analytics/*`, `/api/dashboard/summary`, `/trend` | SaaS MySQL |
| 实时订单组件 | Legacy 内嵌 | `GET /api/dashboard/orders` | SaaS MySQL |
| GMV 对比图 | Legacy + SaaS | `/api/analytics/gmv-compare` + `fetchDashboardSummary` | MySQL |
| 店铺管理 | `/shops` | `/api/shops` | MySQL；文案仍提及 cache（i18n） |
| Ops（平台） | 管理端调用 | `/api/ops/import-cache`, `/reconcile`, `/rebuild-cache` | 读写 cache（运维） |

**注意**：`App.tsx` 登录成功默认 `nav` 至 `/legacy`，新用户首屏仍为 Legacy，与 SaaS 主数据源策略并存——属产品路由问题，非后端数据源未统一。

---

## 5. 风险分级汇总

### P0 — 影响真实数据或全量泄漏

| 项 | 描述 |
|----|------|
| 生产设置 `DASHBOARD_DATA_SOURCE=cache` | Legacy 大屏读 `orders-cache.json`，与 MySQL 主数据可能严重偏离 |
| Legacy + 平台 scope + 无 `mysqlGate` | 仍可能用 `readShops()` 全量店铺 catalog（`legacyDashboardRoutes.js`） |

### P1 — 展示不一致或运维误用

| 项 | 描述 |
|----|------|
| Legacy 读 `gmv-cache.json` 汇率 | 与 SaaS `exchange_rates` / Frankfurter 链不一致 |
| `tiktok-api/client.js` 仍 `writeShops` | OAuth 后双写 `shops.json`，与 MySQL 可能短暂不一致 |
| `server.js` TikTok 路由依赖 `readShops()` | 非 SaaS 模块，但生产若调用则绕 MySQL |
| Ops `import-cache` / `rebuild-cache` | 平台管理员可改 cache，间接影响 legacy |
| 登录默认 `/legacy` | 用户看到 legacy 聚合而非 SaaS 总览 |

### P2 — 历史兼容 / 可保留

| 项 | 描述 |
|----|------|
| Worker 写 `orders-cache.json` | 主写 MySQL；cache 供 legacy/对账 |
| SQLite `dashboard.db` 初始化 | 无业务引用，仅启动日志 |
| `readOrdersAggregateFromStorage` 死代码 | 无调用 |
| i18n 中 orders-cache 文案 | 仅提示，非读盘 |
| `modules/dashboard` trend `_fallback` | 仍查 MySQL 当日汇总 |

---

## 6. 与既有文档关系

- 策略基线：`docs/data-source-policy.md`（阶段十锁定）— 本审计与之**一致**，并补充 Phase 2 代码级锚点与前端路由差异。
- 阶段一：`docs/audit-phase1-report.md` — 本报告为 Phase 2-1 专项深化。

---

## 7. 下一阶段建议处理顺序

| 阶段 | 动作 | 目标 |
|------|------|------|
| **2-2** | 生产/预发 **锁定** `DASHBOARD_DATA_SOURCE=mysql`；监控/告警若检测到 `cache` | 消除 P0 |
| **2-3** | Legacy 汇率改为与 SaaS 相同链（`buildSaaSFxContext`），**停止读 `gmv-cache.json`** | 消除 P1 汇率分叉 |
| **2-4** | OAuth / TikTok client：**停止写 `shops.json`** 或改为只读备份；`server.js` TikTok 路由改读 MySQL token | 店铺/token 单源 |
| **2-5** | Worker：**可配置关闭** `orders-cache` 写盘；保留 Ops `rebuild-cache` 仅运维 | 降低 cache 漂移 |
| **2-6** | 产品：登录默认跳转 `/dashboard`；`/legacy` 仅管理员或显式入口 | 减少 legacy 暴露 |
| **2-7** | 删除死代码：`readOrdersAggregateFromStorage`、`orderRepository`+SQLite 初始化（需单独变更评审） | 减维护面 |
| **2-8** | Ops 面板与 i18n 明确「cache 非 SaaS 数据源」 | 防误用 |

---

## 8. 只读检查脚本

```bash
bash scripts/audit/check-data-sources.sh
```

脚本对 `backend/`、`frontend/src/`、`scripts/`、`docs/` 执行关键词 grep（排除 `node_modules`、`dist`），按分类输出命中行，**不修改任何文件**。

---

## 9. 验收对照

| 项 | 状态 |
|----|------|
| 未改业务代码 / API / DB / 同步器 / UI | ✅ |
| `docs/audit/phase2-data-source-audit.md` | ✅ 本文档 |
| `scripts/audit/check-data-sources.sh` | ✅ |
| 列出 legacy/cache 依赖 | ✅ §3、§5 |
| 下一阶段处理顺序 | ✅ §7 |

---

*审计方法：静态代码检索（`legacyDashboardRoutes`、`registerApiRoutes`、`modules/*`、`tiktok-api/scheduler`、`readSyncShops`、`saasExchangeRates`、前端 `App.tsx` / `AnalyticsPage` / `LegacyDashboardPage`）+ 关键词扫描脚本。*
