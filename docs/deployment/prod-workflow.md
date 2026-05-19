# Production 正式环境工作流

正式环境目录：`/home/admin/daping-prod`  
开发测试环境：`/home/admin/daping-staging`（互不影响）

| 变量 | 值 |
|------|-----|
| `STAGING_ROOT` | `/home/admin/daping-staging` |
| `PROD_ROOT` | `/home/admin/daping-prod` |
| `PM2_STAGING` | `daping-staging` |
| `PM2_PROD` | `daping-prod` |
| Prod 健康检查 | `http://127.0.0.1:3080/api/health` |
| Staging 健康检查 | `http://127.0.0.1:3081/api/health` |

**说明**：`tiktok-openapi-sync` 全局只保留一个实例（通常在 staging 侧运维配置），`init-prod` / `deploy-prod` **不会**新建同步 worker。

---

## 1. 首次初始化 Prod（仅一次）

在 Staging 已可正常运行后执行：

```bash
bash /home/admin/daping-staging/scripts/deploy/init-prod.sh
```

脚本将：

1. 若 `daping-prod` 不存在：从 staging **rsync** 创建（排除 `node_modules`、`dist`、`.git`、`*.log`、`logs`、`backups`）
2. **不覆盖** `backend/.env`、`frontend/.env`（prod 需单独配置生产环境变量）
3. Prod 内 `frontend`：`npm install` + `npm run build`
4. Prod 内 `backend`：`npm install`
5. `pm2 start`（或 restart）**仅** `daping-prod` → `backend/server.js`
6. 健康检查 `3080/api/health`
7. 成功输出：**INIT PROD SUCCESS**

初始化后请确认：

```bash
pm2 list    # 应看到 daping-prod；daping-staging 仍独立运行
ls -ld /home/admin/daping-prod
curl -fsS http://127.0.0.1:3080/api/health
```

若缺少 `backend/.env`：

```bash
cp /home/admin/daping-staging/backend/.env /home/admin/daping-prod/backend/.env
# 编辑 PORT、数据库、域名等生产项后
pm2 restart daping-prod
```

---

## 2. 日常发布（Staging 验证通过后）

```bash
bash /home/admin/daping-prod/scripts/deploy/deploy-prod.sh
```

或：

```bash
bash /home/admin/daping-staging/scripts/deploy/deploy-prod.sh
```

流程：

1. 备份当前 prod → `/home/admin/daping-prod/backups/backup_yyyyMMdd_HHmmss.tar.gz`
2. **rsync** staging → prod（`--delete`，同样排除 `.env` / `node_modules` / `dist` / `logs` / `backups`）
3. Prod `frontend`：`npm install` + `npm run build`
4. Prod `backend`：`npm install`
5. `pm2 restart daping-prod`（**不** restart staging）
6. 健康检查
7. 失败时提示：`bash /home/admin/daping-prod/scripts/rollback/rollback.sh prod`

---

## 3. 回滚

```bash
bash /home/admin/daping-prod/scripts/rollback/rollback.sh prod
```

1. 在 `/home/admin/daping-prod/backups/` 取最新 `backup_*.tar.gz`
2. 解压覆盖到 prod 根目录
3. 重新 `npm install` / `npm run build`
4. `pm2 restart daping-prod`
5. 健康检查

Staging 回滚（若 staging 也有 backups）：

```bash
bash /home/admin/daping-staging/scripts/rollback/rollback.sh staging
```

---

## 4. 发布准入清单

- [ ] Staging 功能与回归通过（见 [staging-workflow.md](./staging-workflow.md)）
- [ ] 变更说明与回滚方案已记录
- [ ] 生产 `.env` 已核对（勿直接沿用 staging 密钥/库）
- [ ] 维护窗口与通知已安排

---

## 5. API 验收

```bash
bash /home/admin/daping-prod/scripts/health/check-api.sh prod
export AUTH_TOKEN="<平台管理员 JWT>"
bash /home/admin/daping-prod/scripts/health/check-api.sh prod
```

---

## 6. 权限与部署用户

- 使用 **admin** 用户执行 npm / pm2 / 部署脚本（勿 root `npm install`）
- 权限异常时见 [permission-guide.md](./permission-guide.md)

---

## 7. 相关脚本

| 脚本 | 用途 |
|------|------|
| `scripts/deploy/deploy-env.sh` | 路径与健康检查 URL 常量 |
| `scripts/deploy/init-prod.sh` | 首次创建 prod |
| `scripts/deploy/deploy-prod.sh` | Staging → Prod 发布 |
| `scripts/deploy/deploy-staging.sh` | 仅更新 staging |
| `scripts/rollback/rollback.sh` | `prod` / `staging` 回滚 |
| `scripts/health/check-api.sh` | API 探活 |
| `scripts/maintenance/fix-permissions.sh` | 修复 admin 属主 |

模板（仅 echo，非服务器执行）：`*.example.sh`
