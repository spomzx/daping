# Phase3｜日志中心（Operation Log Center）

## 表结构

主表：`operation_logs`（已有，Phase3 可选迁移扩展列）

| 字段 | 说明 |
|------|------|
| id | 主键 |
| tenant_id | 租户 |
| user_id | 操作人 |
| username / role / status / message | 迁移脚本 `migratePhase3.js` 可选列；未迁移时写入 `detail_json` |
| action / module / target_type / target_id | 操作语义 |
| before_data / after_data | JSON（列或 detail_json） |
| ip / user_agent | 请求上下文 |
| created_at | 时间 |

索引：`tenant_id + created_at`、`module + created_at`、`user_id`

可选迁移：

```bash
cd backend && node modules/operation-logs/migratePhase3.js
```

## API（MySQL-only）

| 方法 | 路径 | 权限 |
|------|------|------|
| GET | `/api/operation-logs/ping` | 公开 |
| GET | `/api/operation-logs` | admin / super_admin |
| GET | `/api/operation-logs/stats` | admin / super_admin |
| GET | `/api/operation-logs/:id` | admin / super_admin |

查询参数：`tenantId`（平台）、`module`、`action`、`userId`、`status`、`startDate`、`endDate`、`page`、`pageSize`

## 权限

- **平台管理员**：可看全部租户（`tenantId` 筛选）
- **租户 admin**：仅本租户（`tenantScope`）
- **viewer**：禁止（路由 `requireRole('admin','super_admin')`）

## 写入点

统一入口：`backend/lib/operationLogger.js` → `logOperation()`

封装：`backend/modules/operation-logs/audit.js` → `auditFromRequest()`

已接入：

| 模块 | 动作示例 |
|------|----------|
| users | create_user, update_user_status, delete_user |
| tenants | update_tenant_plan |
| shops | shop_create, disable_shop, enable_sync, … |
| sync | manual_sync, sync_retry（success/failed） |

## 前端

- `frontend/src/pages/Logs/OperationLogCenterPage.tsx`
- `frontend/src/components/logs/*`
- 路由：`/logs`（替换原 Placeholder）

## 后续扩展

- 导出 CSV
- 告警 webhook（连续 sync failed）
- 写入 auth 登录/登出细粒度
- 按 target 类型钻取详情页

## 验收

```bash
cd backend && npm run check:saas-routes
curl -s http://127.0.0.1:3081/api/operation-logs/ping
```
