# Phase3｜operation_logs 表字段修复（status）

## 问题

Staging `/logs` 报错：

```
Unknown column 'ol.status' in 'field list'
```

**根因**：`repository.js` 的 stats / 筛选 SQL 直接引用 `ol.status`、`ol.message` 等列，但线上 `operation_logs` 仍为 Phase2 基础表结构（仅 `detail_json` 存扩展字段），未执行 Phase3 迁移。

## 真实表结构（迁移前）

| 列 | 说明 |
|----|------|
| id, tenant_id, user_id | 基础 |
| action, module, target_type, target_id | 操作语义 |
| ip, user_agent, detail_json | 请求上下文 |
| created_at | 时间 |

`status` / `username` / `message` 等存在于 `detail_json` 内。

## 修复方式

### 1. 查询层（即时兼容，无需先迁移）

`schemaMeta.js` 启动时读取 `INFORMATION_SCHEMA`：

- 无 `status` 列：SQL 仅用 `JSON_EXTRACT(detail_json, '$.status')`
- 有 `status` 列：`COALESCE(ol.status, JSON …, 'success')`

列表筛选 `?status=success|failed` 继续可用。

### 2. 迁移（推荐 staging 执行）

```bash
cd backend
node modules/operation-logs/migratePhase3.js
```

幂等规则：按列名 / 索引名检查，已存在则跳过。

新增列（顺序）：

- `username` VARCHAR(128)
- `role` VARCHAR(32)
- **`status` VARCHAR(32) NOT NULL DEFAULT 'success'**
- `message` VARCHAR(512)
- `before_data` / `after_data` JSON
- 索引 `idx_oplog_module_created (module, created_at)`

### 3. 写入层

`operationLogger.js` → `modules/operation-logs/write.js`：

- 动态 INSERT 按现有列写入
- `status: 'success' | 'failed'` 写入列（若存在）并同步 `detail_json`

### 4. 新库 schema

`backend/db/schema.sql` 中 `operation_logs` 已包含完整 Phase3 列定义。

## 修改文件

| 文件 | 说明 |
|------|------|
| `modules/operation-logs/schemaMeta.js` | 列检测 + status/message SQL 表达式 |
| `modules/operation-logs/repository.js` | 去除硬编码 `ol.status` |
| `modules/operation-logs/write.js` | 动态 INSERT |
| `modules/operation-logs/migratePhase3.js` | 幂等迁移 |
| `lib/operationLogger.js` | 改用 write |
| `db/schema.sql` | 新装库表结构 |

## Staging 验收

| 项 | 命令 / 页面 | 期望 |
|----|-------------|------|
| 迁移 | `node modules/operation-logs/migratePhase3.js` | 无报错，status 列存在 |
| API | `curl …/api/operation-logs/stats` | 200 + JSON |
| API | `curl …/api/operation-logs` | 200 + items |
| 前端 | https://stag.cqchic-cq.top/logs | 统计卡 + 列表 + 状态筛选 |
| PM2 | `pm2 logs daping-staging` | 无 SQL Unknown column |

> 部署后由人工勾选结果。
