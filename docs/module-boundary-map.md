# 模块边界地图（Phase 2）

## 目标结构 vs 当前结构

| 推荐模块 | 当前状态 | 实际路径 | 锁定 |
|----------|----------|----------|------|
| `auth` | ✅ 存在 | `modules/auth/` | 🔒 仅 bugfix |
| `users` | ✅ 存在 | `modules/users/` | 🔒 |
| `tenants` | ✅ 存在 | `modules/tenants/` | 🔒 |
| `shops` | ✅ 存在 | `modules/shops/` | 🔒 KPI 经 todayMetrics |
| `orders` | ✅ 存在 | `modules/orders/` | 🔒 |
| `analytics` | ✅ 存在 | `modules/analytics/` | ⚠️ 与 dashboard 口径待合并 |
| `realtime` | ⚠️ 别名 | `modules/dashboard/warRoomOrders.js` | 🔒 路由 `/api/dashboard/orders` |
| `currency` | ⚠️ 分散 | `exchangeRateService.js`, `lib/rates.js`, `server.js` | 待迁 `modules/currency` |
| `sync` | ✅ 存在 | `modules/sync/`, `sync/`, `syncJobs/` | 🔒 |
| `logs` | ⚠️ 拆分 | `operation-logs/`, mount `/api/logs` | 🔒 |

**额外模块（保持，不强行改名）**：`authorizations`, `billing`, `notifications`, `queue`, `settings`, `ops`（已空心化 ping only）。

---

## 模块内文件职责（标准）

| 文件 | 职责 |
|------|------|
| `routes.js` | HTTP 入参、中间件链、调 controller |
| `controller.js` | 解析 req、调 service、写响应 |
| `service.js` | 业务编排、权限组合、事务 |
| `repository.js` / `*Query.js` | SQL only |
| `validators.js` | 参数校验（可选） |
| `constants.js` | 枚举（可选） |

### 当前偏差

| 模块 | 偏差 | 处理 |
|------|------|------|
| `dashboard` | 无单一 `repository.js`，统计在 `*Query.js` | 接受；`*Query.js` = repository 角色 |
| `dashboard` | `filterContract.js` 过重 | 锁定；新过滤条件只改此处 |
| `shops` | `controller.js` 少量内联 SQL | TODO：迁到 repository |
| `currency` | 根级 `exchangeRateService.js` + server 路由 | P2 迁入 `modules/currency` |
| `server.js` | TikTok OAuth、汇率、collect-now | 见 server 清理清单 |

---

## 路由挂载（`registerApiRoutes.js`）

### SaaS MySQL Only（`saasMysqlOnlyMiddleware`）

- `/api/tenants`, `/api/users`, `/api/shops`, `/api/orders`
- `/api/dashboard`, `/api/analytics`, `/api/sync`, `/api/sync-jobs`

### 业务（MySQL，无 mysql-only 标签但禁止 cache）

- `/api/authorizations`, `/api/settings`, `/api/operation-logs`, `/api/logs`
- `/api/billing`, `/api/queue`, `/api/notifications`, `/api/ops`

### 独立挂载

- `/api/auth` — `server.js` 直接 mount

---

## 中间件链（数据范围）

| 中间件 | 作用 |
|--------|------|
| `authRequired` | JWT |
| `tenantScope` | `req.tenantId` |
| `effectiveTenantScope` | 平台管理员 `?tenant_id=` |
| `attachDataScope` | `req.dataScope`（platform / tenant_all / assigned） |
| `requireFullAccess` | 拒绝只读受限账号 |
| `requireRole(...)` | 角色 |
| `buildShopScopeWhere` | SQL 店铺范围（`lib/dataScope.js`） |

**Dashboard 特殊**：`/orders` 实时列表不经过 `requireFullAccess`（避免 401 与 legacy 冲突）。

---

## server.js 残留业务接口

见 [`locked-baseline.md`](./locked-baseline.md) 与交付报告「server.js 清理」。

| 路径 | 分类 | 迁移目标 | 暂不迁移原因 |
|------|------|----------|--------------|
| `GET /api/exchange-rate` | 汇率 | `modules/currency/routes` | 公开读接口，改动需前端联调 |
| `GET /api/admin/exchange-rates/health` | 汇率 | currency 模块 | 低优先级 |
| `GET/POST /api/tiktok/*` | OAuth/采集 | `modules/shops` 或 `sync` | OAuth 回调 URL 固定、环境分支多 |
| `GET /api/tiktok/shops` | 店铺 JSON | 废弃，改用 `/api/shops` | 需确认无外部依赖 |
| `POST /api/tiktok/collect-now` | 同步 | `/api/sync/run` | 队列模式 ENV 已部分替代 |

**已迁移到 modules**（经 `registerApiRoutes`）：tenants, users, shops, orders, dashboard, analytics, sync, authorizations, settings, logs, billing, queue, notifications, ops。

---

## 前端模块边界

| 区域 | 路由 | 数据 API 族 |
|------|------|-------------|
| 作战室 | `/legacy` | `/api/dashboard/*` |
| SaaS 总览 | `/dashboard` → AnalyticsPage | `/api/analytics/*` |
| 订单中心 | `/orders` | `/api/orders/*` |
| 店铺 | `/shops` | `/api/shops/*` |

**边界问题**：两套时间模型（日历 `range` vs `hours`），见 `metric-definition-map.md`。

---

## 锁定规则

1. 已标记 🔒 的模块：无新需求不得重构目录结构。
2. 新增业务 API **必须**进入对应 `modules/*`，禁止写 `server.js`。
3. 新增统计必须先更新 `metric-definition-map.md`。
4. 修改 `todayMetricsQuery.js` 必须跑 `diagnose-today-metrics-consistency.js`。
