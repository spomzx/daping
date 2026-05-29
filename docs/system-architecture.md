# 系统架构（稳定版 · 阶段十锁定）

> 阶段一～九已完成模块化与三层隔离。本文档为**正式架构基线**，新功能须先对照本文再开发。

## 三层架构

```
┌─────────────────────────────────────────────────────────────┐
│  War-Room（登录默认入口 · 冻结 UI）                            │
│  /legacy  +  GET /api/dashboard（根路径聚合）                   │
│  orders-cache.json / gmv-cache.json fallback                  │
└───────────────────────────┬─────────────────────────────────┘
                            │ 业务数据最终落 MySQL
┌───────────────────────────▼─────────────────────────────────┐
│  SaaS Console（管理后台 · MySQL）                              │
│  /dashboard /shops /orders /sync /authorizations /users       │
│  modules: dashboard, shops, orders, sync, authorizations, …   │
└───────────────────────────┬─────────────────────────────────┘
                            │ 只读/写入 MySQL
┌───────────────────────────▼─────────────────────────────────┐
│  Ops 运维（platform only）                                   │
│  /api/ops/*  import-cache · rebuild-cache · reconcile        │
└─────────────────────────────────────────────────────────────┘
```

| 层 | 前端路由 | 角色定位 | API 前缀 | 数据源 | 扩展策略 |
|----|----------|----------|----------|--------|----------|
| **War-Room** | `/legacy` | **登录后默认**；实时 GMV / 订单流大屏 | `GET /api/dashboard` 等 | cache/json | **禁止扩展** |
| **SaaS Console** | `/dashboard` … `/users` | 管理后台；侧栏「进入管理后台」 | `/api/shops` `orders` `sync` … | **MySQL** | 按 `modules/*` 新增 |
| **Ops** | 无独立页（平台店铺管理内嵌） | 运维工具 | `/api/ops/*` | cache ↔ MySQL 工具 | 仅平台管理员 |

**默认路由（稳定版入口）**：`/`、`/login` 成功后 → `/legacy`；SaaS 各页仍通过 `/dashboard` 及 `saasNav` 进入。

## 模块结构（backend）

| 目录 | 职责 |
|------|------|
| `modules/auth` | 登录 / 注册 / me |
| `modules/users` | 用户与 `user_shop_permissions` |
| `modules/shops` | 店铺 CRUD、健康、OAuth 落库 |
| `modules/orders` | 订单 list/detail/stats（SaaS） |
| `modules/sync` | 同步状态与日志 |
| `modules/authorizations` | 授权列表/明细 |
| `modules/dashboard` | SaaS 看板 summary/trend/ranking |
| `modules/analytics` | 数据总览 API |
| `modules/ops` | 运维 import / reconcile / rebuild |
| `modules/settings` | 系统设置与汇率（MySQL） |
| `modules/logs` | 操作日志 |
| `routes/registerApiRoutes.js` | 业务路由挂载 |
| `routes/legacyDashboardRoutes.js` | Legacy war-room 聚合 |
| `routes/deprecatedOpsAliases.js` | 旧 Ops URL 别名 |
| `lib/dataScope.js` | tenant / platform 数据范围 |
| `server.js` | 启动、中间件、OAuth 兼容、静态资源、listen |

## 前端结构

| 路径 | 说明 |
|------|------|
| `pages/*` | SaaS 页面（Dashboard、Shops、Orders…） |
| `components/layout/SaasLayout` + `config/saasNav.ts` | SaaS 导航 |
| `services/api/*` | API 封装（SaaS 仅 MySQL 路径） |
| `services/api/ops.ts` | Ops API（仅平台场景） |
| `App.tsx` | 路由：`/`、`/login` 默认 → `/legacy`（War-Room）；`/reconcile` → `/dashboard`；SaaS 页走 `SaasLayout` |
| `config/saasNav.ts` | 侧栏含「进入管理后台」→ `/dashboard` |

## 数据流（SaaS 订单示例）

1. TikTok OpenAPI worker → 写入 **MySQL** `orders` / `order_items`
2. （可选 deprecated）worker 合并写 `orders-cache.json` — **不作为 SaaS 统计源**
3. SaaS `GET /api/orders/list` → `dataScope` 过滤 → MySQL 分页返回
4. 排障：SyncCenter `sync_shop_logs`；平台可用 Ops reconcile

## 权限与 Tenant 模型

- **Tenant**：`users.tenant_id` + `user_tenants`；业务数据带 `tenant_id`
- **Platform**：`users.scope = platform` 或角色 `super_admin` → `isPlatformScope`
- **Viewer**：`user_shop_permissions` 限定店铺子集
- **dataScope**：`getUserScope` / `buildShopScopeWhere` / `buildOrderScopeWhere` / `buildSyncScopeWhere`

详见 `docs/api-map.md` 权限表与阶段十验收权限矩阵（`docs/version-lock.md` 引用）。

## 数据源规则（摘要）

- SaaS **禁止**读 `orders-cache.json`、`shops.json`、`gmv-cache.json`
- Legacy **允许** cache fallback（`DASHBOARD_DATA_SOURCE=cache` 等）
- Ops **允许** 读写在运维工具链内

完整条款：`docs/data-source-policy.md`。

## 已废弃 / 冻结

| 项 | 状态 |
|----|------|
| `/reconcile` 页面 | 废弃，重定向 `/dashboard` |
| `GET /api/orders/reconcile` | deprecated 别名 → Ops |
| `ReconcilePage` / `ReconcilePanel` | 已删除（阶段十） |
| Legacy war-room 新功能 | 冻结 |
| `server.js` 内新增业务 SQL/聚合 | 禁止 |

## 相关文档

- `docs/api-map.md` — API 清单
- `docs/ops-boundary.md` — Ops 边界
- `docs/deprecated-list.md` — 废弃项
- `docs/version-lock.md` — 版本与维护期原则
- `docs/database-map.md` — 表结构
