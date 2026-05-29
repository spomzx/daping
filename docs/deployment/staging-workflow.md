# Staging 部署工作流

本文描述从本地开发到 Staging 验收的流程。

**服务器可执行脚本**（路径已写死为 `/home/admin/daping-staging`）与 **`.example.sh` 模板** 并存；日常发布请用前者。

## 0. 权限修复（若曾用 root 操作过项目）

```bash
cd /home/admin/daping-staging
bash scripts/maintenance/fix-permissions.sh
```

详见 [permission-guide.md](./permission-guide.md)。**不要用 root 执行 `npm install`。**

## 1. 服务器一键部署（推荐）

在 Staging 服务器项目根目录执行：

```bash
cd /home/admin/daping-staging
bash scripts/deploy/deploy-staging.sh
```

脚本将依次：发布前备份（`scripts/backup/create-deploy-backup.sh`，**仅代码**，排除 `backend/storage/`、SQLite、`node_modules`、`dist`、`logs` 等运行时文件）→ `npm run build` → **修复 `frontend/dist` 权限（nginx 可读）** → `npm install`（backend）→ `pm2 restart daping-staging` → `http://127.0.0.1:3081/api/health`。

回滚使用 `rsync --no-owner --no-group --omit-dir-times`，避免 chgrp/utime 权限错误。

成功输出：`STAGING DEPLOY SUCCESS`；失败：`STAGING DEPLOY FAILED`（exit 1）。

部署后完整 API 检查（可选，需平台管理员 JWT）：

```bash
export AUTH_TOKEN="<your-jwt>"
bash scripts/health/check-api.sh staging
```

回滚：

```bash
bash scripts/rollback/rollback.sh staging
```

## 2. 本地开发流程

1. 在仓库根目录（含 `frontend/`、`backend/`）开发功能。
2. 前端本地验证：
   ```bash
   cd frontend
   npm install
   npm run dev
   ```
3. 后端本地验证（配置 `.env` 中的 `DB_*` 等）：
   ```bash
   cd backend
   npm install
   node server.js
   ```
4. 提交前执行：
   - `cd frontend && npm run build`
   - 必要的后端脚本 / 迁移（如 `node db/init.js`，按团队规范）
5. 通过 Git 推送到约定分支（如 `develop` 或 `staging`）。

## 3. 上传到 Staging

1. 同步代码到 `/home/admin/daping-staging`（git pull / CI，按团队方式）。
2. 执行部署：
   ```bash
   cd /home/admin/daping-staging
   bash scripts/deploy/deploy-staging.sh
   ```
3. （可选）发布前手动备份 — 使用模板：
   ```bash
   deploy-staging 会在发布前自动生成 `backups/backup_YYYYMMDD_HHmmss.tar.gz`
   ```
   生产环境备份已内置在 `deploy-prod.sh` 中。

## 4. Staging 验收流程

1. 健康检查：
   ```bash
   bash scripts/health/check-api.sh staging
   # 含登录态检查：
   export AUTH_TOKEN="<平台管理员 JWT>"
   bash scripts/health/check-api.sh staging
   ```
2. 必验接口：
   - `GET /api/health` → 200
   - `GET /api/auth/me` → 200（带 Token）
   - `GET /api/tenants` → 200（平台管理员）
3. 业务冒烟（示例）：
   - 登录（平台管理员、租户管理员）
   - `/users` 与 `/tenants` 用户数一致
   - 店铺授权 / 大屏数据（按本次变更范围）
4. 验收通过后，方可进入 Production 发布评审。

## 5. 蓝绿 / 灰度（Staging 可选演练）

- **蓝绿**：维护 `APP_ROOT-blue` / `APP_ROOT-green` 两套目录，在非活跃槽构建，健康检查后切换流量。
- **灰度**：在网关层按 Header / Cookie / 比例分流（配置在 nginx/SLB 外，本项目模板仅文档化步骤）。

详见 `deploy-staging.example.sh` 中的步骤说明。

## 6. 脚本一览

| 文件 | 用途 |
|------|------|
| `scripts/deploy/deploy-staging.sh` | **可执行** Staging 部署 |
| `scripts/deploy/deploy-prod.sh` | **可执行** Production 部署（含自动备份） |
| `scripts/health/check-api.sh` | **可执行** API 探活 OK/FAIL |
| `scripts/rollback/rollback.sh` | **可执行** 从最新 backup 回滚 |
| `scripts/maintenance/fix-permissions.sh` | **可执行** root/admin 权限修复 |
| `scripts/deploy/init-prod.sh` | 首次从 staging 创建 prod |
| `scripts/deploy/deploy-prod.sh` | Staging → Prod 正式发布 |
| `scripts/deploy/deploy-staging.example.sh` | 模板（仅 echo） |
| `scripts/backup/create-deploy-backup.sh` | **可执行** 发布前 tar 备份 |
| `scripts/backup/backup-project.example.sh` | 备份模板（仅 echo） |

## 7. 回滚

验收失败时见 [rollback-guide.md](./rollback-guide.md)。
