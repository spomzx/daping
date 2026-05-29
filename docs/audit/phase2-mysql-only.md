# Phase 2-2｜SaaS 主数据源锁定（MySQL Only）

> **实施日期**：2026-05-19  
> **原则**：隔离 legacy，不删除 legacy 文件 / SQLite / cache / worker。

## 1. 目标行为

以下 SaaS 主接口前缀在 **MySQL 不可用** 或 **试图读取 legacy 存储** 时：

- `GET/POST /api/dashboard/*`
- `GET/POST /api/analytics/*`
- `GET/POST /api/orders/*`
- `GET/POST /api/shops/*`
- `GET/POST /api/tenants/*`
- `GET/POST /api/users/*`

行为：

1. **MySQL ONLY**（业务数据）
2. 不读 `orders-cache.json` / `gmv-cache.json` / `shops.json` / `dashboard.db`
3. 触发保护时打日志：`[BLOCKED_LEGACY_FALLBACK]`
4. 返回 **503** + `{ "error": "MYSQL_REQUIRED", ... }`

`/api/health` 增加：

```json
{
  "saasDataSource": "mysql-only",
  "legacyFallbackBlocked": true,
  "legacyWarRoomDataSource": "mysql | orders-cache.json"
}
```

（`legacyWarRoomDataSource` 仅描述 **legacy war-room** 环境变量，与 SaaS 无关。）

---

## 2. 已阻断的 Fallback

| 路径 | 原行为 | 现行为 |
|------|--------|--------|
| `GET /api/orders/reconcile` | 调 Ops 对账（读 orders-cache） | **503 MYSQL_REQUIRED**，提示 `/api/ops/orders/reconcile` |
| `GET /api/shops/import-cache-preview` | 读 cache 预览 | **503**（deprecated 别名整段阻断） |
| `POST /api/shops/import-cache` | 从 cache 导入 | **503** |
| `GET /api/orders/cache/*` | cache 路径/重建别名 | **503** |
| `importCacheShops.readJsonSafe` 无 `req.allowLegacyCacheRead` | 读 cache 文件 | **抛 MYSQL_REQUIRED** + 日志 |
| SaaS 模块无 MySQL pool | 部分接口 `database_unavailable` | 中间件统一 **503 MYSQL_REQUIRED** |

### 仍允许（非 SaaS 主链路）

| 路径 | 说明 |
|------|------|
| `GET /api/dashboard`（legacy war-room） | `@deprecated legacy only`；可 `DASHBOARD_DATA_SOURCE=cache` |
| `GET /api/gmv/current` | 同上 |
| `/api/ops/*` | `req.allowLegacyCacheRead=true`，可读 cache **仅用于运维导入/对账** |
| OpenAPI worker | 仍写 `orders-cache.json`（未改 sync） |

### SaaS 内仍允许的「MySQL 内聚合」

| 行为 | 说明 |
|------|------|
| `GET /api/dashboard/trend` 无小时数据时 | 用 **同窗口 MySQL 汇总** 生成单点 `_mysql_hour_snapshot`（非 cache） |
| 汇率 `buildSaaSFxContext` | MySQL `exchange_rates` → Frankfurter API → 内置常量（**不读 gmv-cache**） |

---

## 3. 实现要点

| 文件 | 作用 |
|------|------|
| `backend/lib/saasMysqlOnly.js` | 常量、中间件、`assertLegacyStorageReadAllowed`、`sendMysqlRequired` |
| `backend/middlewares/saasMysqlOnly.js` | Express 导出 |
| `backend/routes/registerApiRoutes.js` | 6 个 SaaS 路由挂载 `saasMysqlOnlyMiddleware` |
| `backend/routes/deprecatedOpsAliases.js` | `/api/shops|orders` 下旧 Ops 别名 **全部 503** |
| `backend/modules/shops/importCacheShops.js` | 读盘前检查 `req.allowLegacyCacheRead` |
| `backend/middlewares/opsAccess.js` | `markOpsApi` 设置 `allowLegacyCacheRead` |
| `backend/lib/healthCheck.js` | `saasDataSource` / `legacyFallbackBlocked` |

`DASHBOARD_DATA_SOURCE` **仅**影响 `routes/legacyDashboardRoutes.js`，**不影响** `modules/dashboard`。

---

## 4. 仍保留的 Legacy

- `backend/routes/legacyDashboardRoutes.js` — war-room `/api/dashboard`
- `backend/tiktok-api/scheduler.js` — 写 MySQL + orders-cache
- `backend/data/dashboard.db` + `better-sqlite3` 启动初始化
- `backend/storage/*.json` 文件
- `frontend/src/legacy/LegacyDashboardPage.tsx` — `/legacy` 路由未改

---

## 5. 仍写 Cache 的 Worker（未改）

| 组件 | 写入 |
|------|------|
| `tiktok-openapi-sync` / `scheduler.collectOnce` | `orders-cache.json`（主写仍为 MySQL `orders`） |
| `POST /api/ops/orders/rebuild-cache` | 从 MySQL 重建 cache |

---

## 6. 后续可删除路径（Phase 2-3+）

1. `readOrdersAggregateFromStorage`（`server.js` 死代码）
2. `db/orderRepository.js` + 无引用的 SQLite 读路径
3. 生产环境移除 `DASHBOARD_DATA_SOURCE=cache`
4. Legacy 汇率停读 `gmv-cache.json`
5. 关停 worker 写 `orders-cache`（保留 Ops rebuild 即可）
6. 删除 `deprecatedOpsAliases` 挂载（待所有客户端迁移到 `/api/ops`）

---

## 7. 验收清单

| 项 | 说明 |
|----|------|
| `npm run build` | 前端构建通过 |
| `GET /api/health` | 含 `saasDataSource: "mysql-only"`, `legacyFallbackBlocked: true` |
| `GET /api/dashboard/summary` | 仅 MySQL；无 pool 时 503 MYSQL_REQUIRED |
| `GET /api/orders/reconcile` | 503 + `[BLOCKED_LEGACY_FALLBACK]` |
| `GET /legacy` + `GET /api/dashboard` | legacy 仍可运行（MySQL 或 cache 由 env 决定） |
| 未删除 legacy 文件 | ✅ |

---

## 8. 相关文档

- `docs/audit/phase2-data-source-audit.md` — Phase 2-1 审计
- `docs/data-source-policy.md` — 策略基线
