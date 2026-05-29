# Backend 模块边界（阶段十锁定）

> 路径：`backend/modules/`。新功能必须落在对应模块，禁止在 `server.js` 堆业务逻辑。

| 模块 | 状态 | 路由前缀 | 数据源 |
|------|------|----------|--------|
| `auth/` | ✅ | `/api/auth` | MySQL |
| `users/` | ✅ | `/api/users` | MySQL + `user_shop_permissions` |
| `shops/` | ✅ | `/api/shops` | MySQL（SaaS）；import 在 ops |
| `orders/` | ✅ | `/api/orders` | MySQL list/stats；reconcile 在 ops |
| `sync/` | ✅ | `/api/sync` | MySQL `sync_shop_logs` |
| `authorizations/` | ✅ | `/api/authorizations` | MySQL |
| `dashboard/` | ✅ | `/api/dashboard/*` | MySQL summary/trend/ranking |
| `analytics/` | ✅ | `/api/analytics` | MySQL |
| `ops/` | ✅ | `/api/ops` | cache/json 运维工具 |
| `settings/` | ✅ | `/api/settings` | MySQL `exchange_rates` |
| `logs/` | ✅ | `/api/operation-logs` | MySQL |
| `notifications/` | ✅ | `/api/notifications` | MySQL |
| `billing/` | ✅ | `/api/billing` | 占位 |
| `queue/` | ✅ | `/api/queue` | 占位 |

## 路由注册（非 modules）

| 文件 | 职责 |
|------|------|
| `routes/registerApiRoutes.js` | SaaS + Ops 模块挂载 |
| `legacy-quarantine/routes/legacyDashboardRoutes.js` | 已下架；归档 |
| `routes/removedLegacyGone.js` | 旧路径统一 410 |

## 跨模块公共库

| 路径 | 职责 |
|------|------|
| `lib/dataScope.js` | tenant / platform 范围 |
| `lib/readSyncShops.js` | OpenAPI 同步店铺源（MySQL） |
| `lib/dashboardShopGate.js` | Legacy/SaaS 店铺 gate |
| `tiktok-api/` | OpenAPI client、scheduler（worker 写 cache 为 deprecated） |

## 禁止

- SaaS 模块内 `readJsonSafe` 读三件套 cache/json 作为主路径
- 在 `orders/routes` 恢复 reconcile（已迁 ops + deprecated 别名）
