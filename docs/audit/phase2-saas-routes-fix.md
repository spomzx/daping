# Phase 2｜SaaS 路由 404 修复说明

## 根因

`backend/routes/registerApiRoutes.js` 中 `mountSaasMysqlOnlyRouter` 使用：

```js
require('./modules/tenants/routes')
```

该路径相对于 **`routes/`** 目录，实际解析为 `backend/routes/modules/...`（不存在），导致 **MODULE_NOT_FOUND**，整段 `registerApiRoutes` 失败，以下 API 全部 **404**：

- `/api/tenants`
- `/api/users`
- `/api/analytics/*`
- `/api/shops`（部分）
- `/api/dashboard/summary` 等 SaaS dashboard 子路由

## 附带修复

`backend/lib/saasMysqlOnly.js` 中 `getMysqlPool` 误写为 `require('./mysqlPool')`，已改为 `require('../db/mysqlPool')`，否则 SaaS 中间件无法加载。

## 修复

统一使用：

```js
path.join(__dirname, '..', 'modules', '<name>', 'routes.js')
```

并将 `sync` 纳入 SaaS MySQL-Only 中间件挂载列表。

## 日志模块（mounted=15）

| 挂载路径 | 模块目录 | 说明 |
|----------|----------|------|
| `/api/operation-logs` | `modules/operation-logs/` | 店铺/平台操作审计（`GET /`、`GET /ping`） |
| `/api/logs` | `modules/logs/` | 同上列表能力 + `GET /ping` |

此前 `operation-logs` 误指向不存在的 `modules/operation-logs`，且与 `/api/logs` 共用同一 router 实例，导致 `failed=2`。

## Deploy 后验证

```bash
cd /home/admin/daping-staging/backend
node scripts/check-saas-routes.js
# 或
npm run check:saas-routes
```

期望：无 `404` 行；受保护接口可为 `401`/`403`（记为 OK）。

## 未改动

- `scripts/deploy/deploy-staging.sh`
- `scripts/rollback/rollback.sh`
- backups / nginx chmod 逻辑
