# HTTP 路由注册（阶段十）

| 文件 | 挂载 | 层级 |
|------|------|------|
| `registerApiRoutes.js` | `/api/users` … `/api/ops` | SaaS + Ops |
| `legacyRoutes.js` → `legacyDashboardRoutes.js` | `GET /api/dashboard` 等 | Legacy |
| `deprecatedOpsAliases.js` | `/api/shops/import-cache*`、`/api/orders/reconcile` | Ops 别名（deprecated） |

`server.js` 负责：`app` 初始化、中间件、`registerApiRoutes`、`registerLegacyRoutes`、OAuth 兼容路由、health、静态资源、`listen`。

**禁止**在 `server.js` 新增：业务 SQL、dashboard 聚合、reconcile、import-cache、rebuild。
