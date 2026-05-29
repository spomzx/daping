# HTTP 路由注册

| 文件 | 挂载 | 说明 |
|------|------|------|
| `registerApiRoutes.js` | `/api/users` … `/api/ops` | SaaS + Ops 主链路 |
| `removedLegacyGone.js` | 旧 legacy/ops 别名路径 | 统一 **410** `legacy_removed` |

已下架路由源码归档：`backend/legacy-quarantine/routes/`（`legacyDashboardRoutes.js`、`legacyRoutes.js`、`deprecatedOpsAliases.js`）。

`server.js` 负责：`app` 初始化、中间件、`registerApiRoutes`、`registerRemovedLegacyGone`、TikTok OAuth、health、静态资源、`listen`。

**禁止**在 `server.js` 新增：业务 SQL、dashboard 聚合、reconcile、import-cache、rebuild。
