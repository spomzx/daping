# 版本锁定（阶段十 · 稳定维护期基线）

## 当前 Staging 锁定（一期交付）

| 项 | 值 |
|----|-----|
| **版本号** | `staging-2026-05-18-stable-v1` |
| **锁定日期** | 2026-05-18 |
| **快照文档** | [releases/staging-2026-05-18-stable-v1.md](releases/staging-2026-05-18-stable-v1.md) |
| **根目录标记** | 项目根 `STAGING_VERSION` |

**本版记录：**

- tenant / order 数据隔离已修复
- orders 全部 `tenant_id=6`
- `orphan_orders=0`
- OpenAPI 同步恢复
- legacy 大屏可用
- sync / users 基础 UI 已收口
- **后续 UI 细节进入二期优化**

**Git 标签建议**（由团队执行）：`git tag staging-2026-05-18-stable-v1`

---

## 稳定版本号建议

| 维度 | 版本 | 说明 |
|------|------|------|
| **SaaS 架构** | `saas-v1.0.0-stable` | 三层分离 + modules 主路径完成 |
| **后端运行时** | `p8-ops-isolated`（`server.js` `SERVICE_VERSION`） | 阶段八 Ops 隔离；十未改 server |
| **权限模型** | `datascope-v1` | `lib/dataScope.js` + `user_shop_permissions` |
| **数据源策略** | `mysql-primary-v1` | SaaS 主链路仅 MySQL |
| **前端** | `0.0.0`（package） | 建议发布时升为 `1.0.0` |

**标签建议**：`git tag saas-v1.0.0-stable`（由团队执行，本阶段不自动打 tag）。

## 已废弃模块 / 能力

- 独立 `/reconcile` 页面与 `ReconcilePanel` 组件
- SaaS 路由上的 `GET /api/orders/reconcile`（保留 deprecated 响应）
- `POST /api/shops/import-cache` 在 SaaS shops 路由（迁至 Ops）
- war-room 顶栏「订单对账」入口
- cache/json 作为 SaaS 统计 fallback

## 默认入口（稳定版 · War-Room 优先）

| 场景 | 目标路由 | 说明 |
|------|----------|------|
| 登录成功 | `/legacy` | War-Room 大屏 |
| `/` 或 `/analytics` | `/legacy` | 不再默认 `/dashboard` |
| SaaS 管理后台 | `/dashboard` | 侧栏 `saas.nav.saasConsole` → 进入管理后台 |
| 无权限 SaaS 子页 | `/dashboard` | 如 `/users` 被拒时回退 Console 首页 |
| 未知路径（已登录） | `/legacy` | `App.tsx` 兜底 |

**定位**：`/legacy` = **War-Room**；`/dashboard` = **SaaS Console**。架构三层不变，仅调整前端默认跳转。

## 已冻结 Legacy（War-Room）

| 项 | 冻结内容 |
|----|----------|
| `GET /api/dashboard`（根） | war-room 聚合，可读 cache |
| 前端 `/legacy` | `GmvDashboard` 旧单页（登录默认入口） |
| `legacy/*` 文档目录 | 仅回滚参考 |
| `DASHBOARD_DATA_SOURCE=cache` | 仅影响 legacy 聚合 |

**禁止**：在 Legacy 层新增业务字段、新菜单、新 SaaS 依赖。

## 禁止事项（维护期）

1. 禁止在 `server.js` 新增业务 SQL、dashboard 聚合、reconcile、import-cache、rebuild。
2. 禁止扩展 Legacy API 与 `/legacy` 页面功能。
3. 禁止 SaaS `modules/*` 主路径读取 `orders-cache.json` / `shops.json` / `gmv-cache.json`。
4. 禁止 SaaS 前端调用 `/api/ops/*`（除已文档化的平台内嵌运维按钮）。
5. 禁止跨模块「救火式」大改；须先更新模块边界文档。
6. 禁止修改数据库核心表结构（本阶段）；迁移单独立项。

## 后续开发原则

1. 新功能 = 新/扩展现有 `backend/modules/<domain>` + `frontend/src/pages` + `services/api`。
2. 新 API 先写明：**层级（SaaS/Ops/Legacy）**、**数据源（MySQL/cache）**、**dataScope**。
3. 运维能力只加在 `modules/ops`，并更新 `docs/ops-boundary.md`。
4. 废弃项只增不减地记入 `docs/deprecated-list.md`。
5. 验收： `npm run build` + 权限矩阵抽样 + grep 数据源。

## 阶段十验收快照（静态）

| # | 项 | 结果 |
|---|-----|------|
| 1 | `npm run build` | 执行通过（见交付日志） |
| 2 | 路由 | 默认 `/legacy`；SaaS `/dashboard` … `/users`；`/login` 在 `App.tsx` |
| 3 | `/reconcile` | → `/dashboard` |
| 4 | `/legacy` | 保留 |
| 5 | Ops | `/api/ops/*` 在 `registerApiRoutes` |
| 6 | SaaS 无 cache 主读 | modules 主路径 grep 通过 |
| 7 | dead code | `ReconcilePage` / `ReconcilePanel` 已删 |

## 文档索引（锁定集）

0. `docs/releases/staging-2026-05-18-stable-v1.md` — **当前 Staging 一期基线**
1. `docs/system-architecture.md`
2. `docs/api-map.md`
3. `docs/database-map.md`
4. `docs/deprecated-list.md`
5. `docs/data-source-policy.md`
6. `docs/ops-boundary.md`
7. `docs/version-lock.md`（本文）
