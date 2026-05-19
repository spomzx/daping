# 数据源策略（阶段十锁定）

## Staging 验收环境

预发验收以 **daping-staging**（PM2：`daping-staging`、`tiktok-openapi-sync`）为准。其它目录下旧 `daping` 进程或 **better-sqlite3** 日志不属于 staging 验收范围。

## SaaS 主数据源

| 域 | 来源 | API 示例 |
|----|------|----------|
| 店铺 | MySQL `shops` | `GET /api/shops` |
| 订单 | MySQL `orders` | `GET /api/orders/*` |
| 同步 | MySQL `sync_shop_logs` | `GET /api/sync/*` |
| 授权 | MySQL `shops` + `shop_auth_tokens` | `GET /api/authorizations/*` |
| 看板汇总 | MySQL | `GET /api/dashboard/*` |
| 分析 | MySQL | `GET /api/analytics/*` |
| 汇率 | MySQL `exchange_rates` → 实时 API → 内置 fallback | `GET /api/settings` |
| 用户/权限 | MySQL | `GET /api/users` |

**禁止**：SaaS 路由读取 `orders-cache.json`、`shops.json`、`gmv-cache.json`。

**阶段十补丁**：SaaS 同步中心 / 授权明细 API 返回前会剥离历史 cache/json 诊断，并映射为统一业务文案（如「OpenAPI 同步正常」「缺少授权 Token」）；`GET /api/analytics/gmv-compare` 失败时返回空序列而非 500。

**阶段七补丁**：`backend/modules/*` 主路径（含 `shopHealthService` 健康刷新、`shopLiveStatsService` enrich）已清除对上述文件的读取；仅 `import-cache` / `orders` 对账运维路由与文件末尾 **legacy 导出** 仍可能接触 cache（不得被 SaaS API 调用）。

## Legacy / 运维（cache/json）

| 文件 | 允许用途 |
|------|----------|
| `orders-cache.json` | `/legacy`、`routes/legacyDashboardRoutes.js`；worker 写盘（deprecated）；`POST /api/ops/orders/rebuild-cache` |
| `shops.json` | `OPENAPI_SHOPS_SOURCE=json` 紧急回滚；`POST /api/ops/import-cache` |
| `gmv-cache.json` | 仅 legacy 大屏汇率 fallback；迁移脚本 `migrateGmvCacheToExchangeRates.js` |

## 禁止事项

1. 新 SaaS 功能不得 `readJsonSafe` 读上述三文件。
2. 不得将 cache 作为 SaaS API 的 silent fallback。
3. 环境变量 `DASHBOARD_DATA_SOURCE=cache` 仅影响 **legacy** `server.js` 聚合，不影响 `modules/dashboard`。

## 排查顺序（SaaS 数据异常）

1. MySQL 连接与 `req.tenantId` / `dataScope`
2. `shops` / `orders` 表是否有行
3. `sync_shop_logs` 最近是否 success
4. `exchange_rates` 是否有对应币对（可跑迁移脚本）
5. **不要**优先查 cache/json（除非复现 legacy 路径）

## 阶段十 SaaS 主路径扫描结论

| 范围 | `orders-cache` / `shops.json` / `gmv-cache` 运行时读取 |
|------|--------------------------------------------------------|
| `modules/dashboard` | 无 |
| `modules/shops`（summary/health SaaS 路径） | 无 |
| `modules/orders`（list/stats） | 无 |
| `modules/analytics` | 无 |
| `modules/sync` / `authorizations` / `users` | 无 |
| `frontend/src/services/api`（除 `ops.ts`） | 无 |
| `modules/ops` + legacy + scripts | 允许 |

## 相关文档

- `docs/deprecated-list.md`
- `docs/api-map.md`
- `docs/database-map.md`
- `docs/system-architecture.md`
- `docs/version-lock.md`
