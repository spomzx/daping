# API 权限矩阵（Phase 2）

**图例**

- **tenant scoped**：`tenantScope` + SQL `tenant_id`
- **shop scoped**：`attachDataScope` + `buildShopScopeWhere`
- **market scoped**：query `market` 过滤
- **risk**：`low` | `medium` | `high`
- **fix needed**：`no` | `yes` | `track`

**角色**：`super_admin`（平台）| `admin`（租户管理员）| `viewer`（只读）| 未登录

---

## Auth

| API path | role required | tenant | shop | market | status | risk | fix |
|----------|---------------|--------|------|--------|--------|------|-----|
| `POST /api/auth/login` | 无 | — | — | — | ok | low | no |
| `POST /api/auth/register` | 无 | — | — | — | ok | low | no |
| `GET /api/auth/me` | 已登录 | yes | — | — | ok | low | no |

---

## Tenants（平台）

| API path | role required | tenant | shop | market | status | risk | fix |
|----------|---------------|--------|------|--------|--------|------|-----|
| `GET /api/tenants` | platform ops | 全平台 | — | — | ok | medium | no |
| `PATCH /api/tenants/:id` | platform ops | yes | — | — | ok | high | no |
| `GET /api/tenants/plan/*` | tenant admin | yes | — | — | ok | medium | no |

---

## Users

| API path | role required | tenant | shop | market | status | risk | fix |
|----------|---------------|--------|------|--------|--------|------|-----|
| `GET /api/users` | admin+ | yes | — | — | ok | high | no |
| `POST /api/users` | admin+ | yes | — | — | ok | high | no |
| `GET/PUT /api/users/:id/shop-permissions` | admin | yes | assign | — | ok | **high** | no |
| `DELETE /api/users/:id` | admin+ | yes | — | — | ok | high | no |

---

## Shops

| API path | role required | tenant | shop | market | status | risk | fix |
|----------|---------------|--------|------|--------|--------|------|-----|
| `GET /api/shops` | viewer+ | yes | scope | opt | ok | medium | no |
| `GET /api/shops/summary` | viewer+ | yes | scope | — | ok | low | no |
| `POST /api/shops` | admin+ | yes | — | — | ok | high | no |
| `PATCH /api/shops/:id` | admin+ | yes | yes | — | ok | high | no |
| `POST /api/shops/health/refresh` | admin+ | yes | scope | — | ok | medium | no |

---

## Orders

| API path | role required | tenant | shop | market | status | risk | fix |
|----------|---------------|--------|------|--------|--------|------|-----|
| `GET /api/orders/list` | viewer+ | yes | scope | opt | ok | medium | no |
| `GET /api/orders/stats` | viewer+ | yes | scope | opt | ok | medium | no |
| `GET /api/orders/detail/:id` | viewer+ | yes | scope | — | ok | medium | no |

---

## Dashboard（作战室 / MySQL only）

| API path | role required | tenant | shop | market | status | risk | fix |
|----------|---------------|--------|------|--------|--------|------|-----|
| `GET /api/dashboard/summary` | viewer+ + fullAccess | yes | scope | opt | ok | medium | no |
| `GET /api/dashboard/ranking` | viewer+ + fullAccess | yes | scope | opt | ok | medium | no |
| `GET /api/dashboard/product-ranking` | viewer+ + fullAccess | yes | scope | opt | ok | medium | no |
| `GET /api/dashboard/gmv-compare` | viewer+ + fullAccess | yes | scope | opt | ok | medium | track 合并 analytics |
| `GET /api/dashboard/orders` | viewer+（无 fullAccess） | yes | scope | opt | ok | medium | no |
| `GET /api/dashboard/trend` | viewer+ + fullAccess | yes | scope | opt | ok | medium | no |

---

## Analytics（SaaS 总览）

| API path | role required | tenant | shop | market | status | risk | fix |
|----------|---------------|--------|------|--------|--------|------|-----|
| `GET /api/analytics/top-products` | viewer+ | yes | scope | opt | ok | medium | track 时间窗统一 |
| `GET /api/analytics/top-shops` | viewer+ | yes | scope | opt | ok | medium | track |
| `GET /api/analytics/recent-orders` | viewer+ | yes | scope | opt | ok | medium | War-Room 禁用 |
| `GET /api/analytics/gmv-compare` | viewer+ | yes | scope | opt | ok | medium | track 重复实现 |
| `GET /api/analytics/status-debug` | viewer+ | yes | — | — | ok | low | no |

---

## Sync / Authorizations

| API path | role required | tenant | shop | market | status | risk | fix |
|----------|---------------|--------|------|--------|--------|------|-----|
| `GET /api/sync/status` | viewer+ | yes | scope | — | ok | low | no |
| `POST /api/sync/run/:shopId` | admin+ | yes | yes | — | ok | high | no |
| `GET /api/sync-jobs` | viewer+ | yes | — | — | ok | medium | no |
| `GET /api/authorizations/list` | viewer+ | yes | scope | — | ok | medium | no |

---

## Settings / Logs / 其它

| API path | role required | tenant | shop | market | status | risk | fix |
|----------|---------------|--------|------|--------|--------|------|-----|
| `GET /api/settings` | 已登录 | yes | — | — | ok | low | no |
| `GET /api/operation-logs` | admin+ | yes | — | — | ok | medium | no |
| `GET /api/notifications` | 已登录 | yes | — | — | ok | low | no |
| `GET /api/billing/status` | 已登录 | yes | — | — | ok | low | no |
| `GET /api/ops/ping` | platform ops | yes | — | — | ok | low | no |

---

## server.js 残留（非 modules）

| API path | role required | tenant | shop | market | status | risk | fix |
|----------|---------------|--------|------|--------|--------|------|-----|
| `GET /api/exchange-rate` | **无** | — | — | — | ok 公开读 | low | track 迁 currency 模块 |
| `GET /api/admin/exchange-rates/health` | admin+ | — | — | — | ok | low | track |
| `GET /api/tiktok/auth-url` | admin+ | yes | — | — | ok | high | track 迁模块 |
| `GET /api/tiktok/auth/callback` | 无 | OAuth state | — | — | ok | high | no |
| `GET /api/tiktok/shops` | viewer+ | **弱** | — | — | **legacy JSON** | **high** | **yes** 改 MySQL |
| `POST /api/tiktok/collect-now` | admin+ | 弱 | — | — | ok | high | track |
| `GET /api/health` | 无 | — | — | — | ok | low | no |
| `GET /api/metrics` | optional | — | — | — | ok | low | no |

---

## 权限原则检查清单

| # | 原则 | 状态 |
|---|------|------|
| 1 | 平台管理员可看全部 tenant（`effectiveTenantScope`） | ✅ |
| 2 | 不能乱分配跨租户店铺（shop-permissions 校验 tenant） | ✅ 需持续回归 |
| 3 | 租户 admin 仅本 tenant | ✅ |
| 4 | 普通用户仅分配店铺 | ✅ `attachDataScope` |
| 5 | 订单/店铺/统计/日志 API 经 scope | ✅ 主链路 |
| 6 | 禁止仅靠前端隐藏按钮 | ✅ 后端 `requireRole` |
| 7 | `/api/tiktok/shops` JSON | ❌ 待修复 |

---

## 新增 API 登记

新增行必须包含：path、role、tenant/shop/market、risk、实现模块路径。
