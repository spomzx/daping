# Ops 运维边界（阶段十锁定）

## Ops API 作用

`/api/ops/*` 承载**非 SaaS 主链路**的运维能力：

- 从 legacy cache/json **导入** MySQL（`import-cache`）
- **对账（debug）**：`orders-cache.json` 与 MySQL 窗口对比（`GET /api/ops/orders/reconcile`）

### Reconcile 废弃说明（阶段九）

| 项 | 状态 |
|----|------|
| 前端 `/reconcile` 页面 | **已废弃**，重定向 `/dashboard` |
| `GET /api/orders/reconcile` | **deprecated** 别名，响应含 `deprecated: true` |
| `GET /api/ops/orders/reconcile` | **保留**，仅平台管理员 |
| SaaS 业务排障 | SyncCenter + `sync_shop_logs`、Orders 列表/统计 |

**禁止**：SaaS 页面调用 `/api/orders/reconcile`；`/reconcile` 路由已废弃；`ReconcilePage` / `ReconcilePanel` 已删除（阶段十）。

## 权限矩阵（阶段十验收）

| 能力 | 平台管理员 | 账户管理员 | 普通用户 (viewer) |
|------|------------|------------|-------------------|
| SaaS Dashboard / Analytics 全局 | ✅ | 本租户 | 分配店铺 |
| Users 菜单 | ✅（非 viewer 列表策略） | ✅ 本租户 viewer | ❌ |
| 分配 viewer 店铺 | ❌ | ✅ 本租户 | ❌ |
| `GET /api/ops/*` | ✅ | ❌ 403 | ❌ 403 |
| `GET /api/orders/reconcile`（deprecated） | ✅ + deprecated 头 | ❌ | ❌ |
| ShopMgmt 内嵌 Ops 对账 | ✅（platform scope） | ❌ 按钮隐藏 | ❌ |
- **重建 cache**：从 MySQL 写回 `orders-cache.json`（`orders/rebuild-cache`），**不修改 MySQL 主数据**

SaaS 业务页面（Dashboard、Shops、Orders、Sync 等）的数据真相源始终是 **MySQL**（见 `docs/data-source-policy.md`）。

## 权限

| 角色 | Ops API |
|------|---------|
| 平台管理员（`scope=platform` 或 `super_admin` / `platform_admin`） | 全部 `/api/ops/*` |
| 账户管理员（租户 `admin`） | **403**（含原 deprecated 别名路径） |
| 普通用户（`viewer`） | **403** |

实现：`backend/middlewares/opsAccess.js` → `requirePlatformOps`。

前端**不展示** Ops 菜单（本阶段未改 UI）。

## SaaS 与 Ops 边界

| 能力 | SaaS | Ops |
|------|------|-----|
| 店铺列表/汇总 | `/api/shops` | — |
| 订单列表/统计 | `/api/orders/list` `stats` | — |
| 数据总览 | `/api/analytics/*`、 `/api/dashboard/summary` | — |
| cache 导入店 | — | `/api/ops/import-cache` |
| 订单对账 | — | `/api/ops/orders/reconcile` |
| cache 重建 | — | `/api/ops/orders/rebuild-cache` |

**禁止**：SaaS 页面直接调用 `/api/ops/*`（代码审查 + 响应头 `X-Ops-Only`）。

## Legacy 与 Ops 边界

| 层级 | 用途 | 典型路径 |
|------|------|----------|
| **Legacy** | 旧 war-room 大屏展示；可读 cache fallback | `GET /api/dashboard`（`routes/legacyDashboardRoutes.js`） |
| **Ops** | 运维写操作（导入、rebuild）与对账报告 | `/api/ops/*` |

- Legacy **不提供** SaaS 新功能扩展。
- Ops **不替代** Legacy 大屏聚合；二者分离。
- `/legacy` 前端路由仍调用 Legacy dashboard API，**不得**依赖 Ops API。

## Cache rebuild 规则

1. `POST /api/ops/orders/rebuild-cache` 仅更新 `storage/orders-cache.json`。
2. 不以 cache 为 SaaS 统计源；rebuild 后 SaaS 仍只读 MySQL。
3. rebuild 失败不得破坏 MySQL 事务数据。

## Import 规则

1. `POST /api/ops/import-cache` 为 **legacy import tool**，从 `shops.json` / 历史 cache 写入 MySQL。
2. 新店铺授权走 TikTok OAuth + MySQL，不走 import-cache。
3. 平台管理员可跨租户导入；须受 rate limit 与 `withStorageLock` 约束。

## 运维接口禁止前端业务调用

- SaaS `pages/*`、`services/api/*`：**不得**引用 `/api/ops/*`。
- `ShopMgmtPanel` 平台运维对账走 `/api/ops/orders/reconcile`（`services/api/ops.ts`）。
- 勿再开发 `/reconcile` 页面；旧 URL 仅重定向。
- 脚本与运维手册应改用 `/api/ops/*` 正式路径。

## Deprecated SaaS 别名

`routes/deprecatedOpsAliases.js` 保留旧 URL，响应含：

- 头：`X-Deprecated: true`、`X-Deprecated-Use`
- 体：`_deprecated`、`_use_instead`（JSON 对象时）

正式集成请使用 `/api/ops/*`。
