# API 映射（阶段十锁定 · SaaS / Ops / Legacy 分层）

> **SaaS 数据源**：MySQL only（见 `docs/data-source-policy.md`）。**禁止** SaaS 路由读 `orders-cache.json` / `shops.json` / `gmv-cache.json`。
>
> **Ops 边界**：见 `docs/ops-boundary.md`。运维接口前缀 `/api/ops/*`，**仅平台管理员**。
>
> **数据范围**：`backend/lib/dataScope.js` — `getUserScope` / `buildShopScopeWhere` / `buildOrderScopeWhere` / `buildSyncScopeWhere`。

## API 分层总览

| 层级 | 前缀 / 位置 | 调用方 | 数据源 |
|------|-------------|--------|--------|
| **SaaS** | `/api/users` `shops` `orders` `dashboard/*` `analytics` … | SaaS 页面 | MySQL |
| **Ops** | `/api/ops/*` | 平台运维、脚本 | cache/json ↔ MySQL 工具 |
| **Legacy** | `GET /api/dashboard`（war-room）、`/legacy` 前端 | 旧大屏、回滚 | cache/json fallback |
| **Ops 别名（deprecated）** | 原 `/api/shops/import-cache`、`/api/orders/reconcile` 等 | 兼容旧管理页 | 同 Ops，需平台管理员 |

## 权限与数据范围（阶段五）

| 角色 | 店铺 | 订单 | 授权 | 同步日志 | 手动同步 | 改店/改授权 |
|------|------|------|------|----------|----------|-------------|
| 平台管理员 (`scope=platform` 或 super_admin) | 全部 | 全部 | 全部 | 全部 | ✓ | ✓ |
| 账户管理员 (`admin`) | 本租户全部 | 本租户 | 本租户 | 本租户 | ✓ | ✓ |
| 普通用户 (`viewer`) | `user_shop_permissions` 分配 | 分配店铺 | 分配店铺 | 分配店铺 | ✗ | ✗ |


## Auth — `modules/auth`

| Method | Path | 说明 |
|--------|------|------|
| POST | `/api/auth/login` | 登录 |
| POST | `/api/auth/register` | 注册 |
| POST | `/api/auth/logout` | 登出 |
| GET | `/api/auth/me` | 当前用户 |

## Users — `modules/users`（阶段六）

| Method | Path | 说明 |
|--------|------|------|
| GET | `/api/users` | 分页列表：`page` `page_size` `keyword` `role` `status` → `{ list, total, page, page_size }` |
| POST | `/api/users` | 创建用户 |
| PATCH | `/api/users/:id/status` | 启用/禁用 |
| POST | `/api/users/:id/reset-password` | 重置密码 |
| DELETE | `/api/users/:id` | 删除用户（viewer 等） |
| POST | `/api/users/:id/approve` | 平台审核通过 |
| POST | `/api/users/:id/reject` | 平台审核拒绝 |
| GET | `/api/users/assignable-shops` | **仅租户账户管理员**（`role=admin` 且非 platform scope）；本租户店铺 |
| GET | `/api/users/:id/shop-permissions` | **仅账户管理员**查看本租户 **viewer** 已分配店铺；平台管理员 **403** |
| PUT | `/api/users/:id/shop-permissions` | **仅账户管理员**为本租户 **viewer** 覆盖保存；平台/跨租户/非 viewer **403** |
| POST | `/api/users` | 平台：仅可创建 `admin`；租户 admin：仅可创建 `viewer` |
| GET | `/api/users` | 平台：仅 `admin`/`super_admin` 类（**不含 viewer**）；租户 admin：仅本租户 `viewer` |

## Shops — `modules/shops`

| Method | Path | 说明 |
|--------|------|------|
| GET | `/api/shops` | 店铺分页列表：`page` `page_size` `keyword` `platform` `region` `status` → `{ list, total, page, page_size }`（与 summary 同 scope） |
| GET | `/api/shops/summary` | 汇总（同 `dataScope`） |
| GET/PUT | `/api/shops/:id` | 详情/更新 |
| POST | `/api/shops/health/refresh` | 健康刷新（**MySQL only**，`shopHealthService` + `shopLiveStatsService`，不读 orders-cache） |
| — | `shopLiveStatsService` 单店兜底 | 按 `shop_id` / `platform_shop_id` / 店名+市场 OR 查询；**禁止** `IN (?)` 子查询占位符错位（2026-05 稳定补丁） |

## Orders — `modules/orders`（SaaS）

| Method | Path | 说明 |
|--------|------|------|
| GET | `/api/orders/list` | 订单列表（MySQL 分页） |
| GET | `/api/orders/detail/:id` | 订单详情 + 行项目 |
| GET | `/api/orders/stats` | 汇总统计 |

## Ops — `modules/ops`（**平台管理员 only**）

| Method | Path | 说明 |
|--------|------|------|
| GET | `/api/ops/import-cache/preview` | 预览 legacy cache 可导入店铺 |
| POST | `/api/ops/import-cache` | 从 cache/json 导入 MySQL（非 SaaS 主链路） |
| GET | `/api/ops/orders/reconcile` | orders-cache vs MySQL 对账 |
| POST | `/api/ops/orders/rebuild-cache` | 从 MySQL 重建 `orders-cache.json`（不写回 MySQL 主数据） |
| GET | `/api/ops/orders/cache-paths` | cache 文件路径诊断 |

### Ops 别名（deprecated，同 Ops 权限）

| Method | Path | 迁移至 |
|--------|------|--------|
| GET | `/api/shops/import-cache-preview` | `/api/ops/import-cache/preview` |
| POST | `/api/shops/import-cache` | `/api/ops/import-cache` |
| GET | `/api/orders/reconcile` | `/api/ops/orders/reconcile`（响应 `X-Deprecated` + `{ deprecated: true }`） |
| POST | `/api/orders/cache/rebuild-from-mysql` | `/api/ops/orders/rebuild-cache` |
| GET | `/api/orders/cache/paths` | `/api/ops/orders/cache-paths` |

**前端（阶段八–十）**：
- `ShopMgmtPanel` 经 `services/api/ops.ts` 调用 Ops 对账（仅平台 scope）。
- `/reconcile` **已废弃**：`App.tsx` 重定向 `/dashboard`；`ReconcilePage` / `ReconcilePanel` **已删除**。
- SaaS 侧栏与 `DashboardHeader` **无** reconcile 可见入口。

## 前端路由（SaaS）

| 路径 | 页面 | 备注 |
|------|------|------|
| `/login` | 登录 | |
| `/dashboard` | 数据总览 | SaaS 首页 |
| `/shops` | 店铺 | |
| `/orders` | 订单 | |
| `/sync` | 同步中心 | |
| `/authorizations` | 授权 | |
| `/users` | 用户 | admin+ |
| `/legacy` | 旧 war-room | Legacy 层 |
| `/reconcile` | — | **重定向** → `/dashboard` |

## Authorizations — `modules/authorizations`

| Method | Path | 说明 |
|--------|------|------|
| GET | `/api/authorizations/list` | 授权列表（按 `platform_shop_id` 聚合；`token_status`：active > expired > missing） |
| GET | `/api/authorizations/detail/:id` | 授权详情（脱敏 token） |
| GET | `/api/authorizations` | 同 list 别名 |

## Sync — `modules/sync`

| Method | Path | 说明 |
|--------|------|------|
| GET | `/api/sync/status` | 店铺同步状态 + `error_label` 业务文案（不暴露 shops.json/cache 诊断） |
| GET | `/api/sync/logs` | `sync_shop_logs` 筛选列表 |
| POST | `/api/sync/run/:shopId` | 单店手动同步（**admin+**，viewer 403） |
| POST | `/api/sync/retry/:shopId` | 单店重试（**admin+**） |
| POST | `/api/tiktok/collect-now` | **legacy** 全量采集（`server.js`） |

## Dashboard — `modules/dashboard`（SaaS · **MySQL only**）

| Method | Path | 说明 |
|--------|------|------|
| GET | `/api/dashboard/orders` | War-Room 实时订单（Bearer + viewer；MySQL，与 analytics recent 同源） |
| GET | `/api/dashboard/summary` | 订单数 / GMV 汇总 |
| GET | `/api/dashboard/trend?range=today` | 今日分时趋势 `{ list:[{hour,gmv_usd,order_count}] }`（兼容 `data`/`series`）；与 summary 同 `paid_at→created_at_platform→created_at` 口径；空序列时按 summary 兜底单点 |
| GET | `/api/dashboard/ranking` | 店铺排行 |
| GET | `/api/dashboard/shop-ranking` | 同上别名 |

## Legacy — 旧 war-room（`routes/legacyDashboardRoutes.js`）

| Method | Path | 说明 |
|--------|------|------|
| GET | `/api/dashboard` | 旧全量 payload（可与 SaaS `/api/dashboard/summary` 共存，路径不同） |
| GET | `/api/dashboard/products` | 旧商品 |
| GET | `/api/dashboard/orders` | 旧订单列表 |
| GET | `/api/gmv/current` | 同上别名 |

> 响应头 `X-Api-Tier: legacy`。仅供 `/legacy` 与回滚；**SaaS / Ops 页面禁止调用**。

## SaaS API 数据源确认（阶段七）

| 前缀 | 数据源 |
|------|--------|
| `/api/dashboard/*`（modules） | MySQL |
| `/api/analytics/*` | MySQL + `exchange_rates` |
| `/api/shops` `/api/shops/summary` | MySQL |
| `/api/orders/list` `stats` `detail` | MySQL |
| `/api/sync/*` | MySQL |
| `/api/authorizations/*` | MySQL |
| `/api/settings` | MySQL |
| `POST /api/shops/health/refresh` | MySQL（`shopHealthService`，无 cache fallback） |
| `/api/dashboard`（根路径，legacy 路由） | **legacy** orders-cache / gmv-cache fallback |
| `/api/ops/*` | cache/json 运维工具（非 SaaS 主路径） |

## Analytics — `modules/analytics`（SaaS 数据总览主 API · MySQL）

| Method | Path | 说明 |
|--------|------|------|
| GET | `/api/analytics/top-products` | 热销 SKU |
| GET | `/api/analytics/top-shops` | 店铺 GMV |
| GET | `/api/analytics/recent-orders` | 最近订单 |
| GET | `/api/analytics/gmv-compare` | 趋势对比（失败返回空序列 + `meta.seriesEmpty`，非 500） |
| GET | `/api/analytics/search-sku` | SKU 搜索 |

## Settings — `modules/settings`

| Method | Path | 说明 |
|--------|------|------|
| GET | `/api/settings` | `system_settings` + `exchange_rates` |

## Logs — `modules/logs`

| Method | Path | 说明 |
|--------|------|------|
| GET | `/api/operation-logs` | 操作日志 |
| GET | `/api/logs` | 同上别名 |

## OAuth

| Method | Path | 说明 |
|--------|------|------|
| GET | `/api/tiktok/auth/start` | 授权跳转 |
| GET | `/api/tiktok/auth/callback` | 回调写 MySQL |

## 其它

| 前缀 | 模块 |
|------|------|
| `/api/notifications` | notifications |
| `/api/billing` | billing |
| `/api/queue` | queue |
| `/api/health` | 健康检查 |
