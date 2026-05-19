# Phase2 Stable 发布说明

> **版本**：`phase2-saas-mysql-only-stable`（标签 `phase2-stable-v1`）  
> **稳定点日期**：2026-05-19

本文记录当前可回滚、可对照、可在此基础上继续开发的 **Phase2 稳定基线**。仅描述运维与验收，不包含业务功能变更说明。

---

## 1. 当前稳定点包含什么

| 能力 | 状态 |
|------|------|
| Staging 一键部署 + 发布前自动备份 | ✅ |
| Staging/Prod 回滚（临时目录解压 + rsync，无 chgrp/utime 问题） | ✅ |
| SaaS API 全部挂载（`mounted=15 failed=0`） | ✅ |
| SaaS 数据主源 MySQL-only（legacy cache/json 不进入 SaaS 主链） | ✅ |
| `operation-logs` / `logs` 路由 | ✅ |
| 前端 dist nginx 可读权限（deploy-staging 内自动 chmod） | ✅ |

**未纳入本稳定点承诺**：Prod 是否已同步到此版本、数据库迁移、TikTok 同步策略变更——以服务器实际部署为准。

---

## 2. 环境常量

| 项 | Staging | Production |
|----|---------|------------|
| 目录 | `/home/admin/daping-staging` | `/home/admin/daping-prod` |
| PM2 | `daping-staging` | `daping-prod` |
| 端口 | **3081** | **3080** |
| Health | `http://127.0.0.1:3081/api/health` | `http://127.0.0.1:3080/api/health` |

---

## 3. 发布到 Staging（日常）

```bash
cd /home/admin/daping-staging
bash scripts/deploy/deploy-staging.sh
```

成功标志：

```
[INFO] STAGING DEPLOY SUCCESS
[INFO] 发布前备份文件: backup_YYYYMMDD_HHmmss.tar.gz
```

---

## 4. 发布到 Production

**前提**：Staging 已验收通过，且代码已同步到 prod 目录（或从 staging rsync）。

```bash
cd /home/admin/daping-staging
bash scripts/deploy/deploy-prod.sh
```

首次若无 prod 目录：

```bash
bash scripts/deploy/init-prod.sh
```

详见 [prod-workflow.md](./prod-workflow.md)。

---

## 5. 回滚命令

**Staging：**

```bash
cd /home/admin/daping-staging
bash scripts/rollback/rollback.sh staging
```

**Production：**

```bash
cd /home/admin/daping-prod
bash scripts/rollback/rollback.sh prod
```

成功标志：`[INFO] ROLLBACK SUCCESS`  
自动使用 `backups/` 下最新 `backup_*.tar.gz`。

---

## 6. 验收命令

### 6.1 健康检查

```bash
curl -fsS http://127.0.0.1:3081/api/health | head
# 期望含: "saasDataSource":"mysql-only", "legacyFallbackBlocked":true
```

### 6.2 SaaS 路由冒烟（无需 JWT，404 为失败）

```bash
cd /home/admin/daping-staging/backend
npm run check:saas-routes
```

### 6.3 日志模块 ping

```bash
curl -s http://127.0.0.1:3081/api/operation-logs/ping
curl -s http://127.0.0.1:3081/api/logs/ping
```

### 6.4 前端（经 nginx）

```bash
curl -I 'http://stag.cqchic-cq.top/legacy?orderFilter=all'
# 期望: HTTP/1.1 200 OK（非 500）
```

### 6.5 PM2 启动日志

```bash
pm2 logs daping-staging --lines 50
# 期望: registerApiRoutes done: mounted=15 failed=0
# 不应: MODULE_NOT_FOUND、operation-logs mount failed、logs mount failed
```

---

## 7. 禁止事项（Stable 维护期）

1. **不要**在未备份、未在 Staging 验证的情况下直接改 Prod 业务代码。  
2. **不要**为排查问题而修改 `scripts/deploy/deploy-staging.sh`、`scripts/rollback/rollback.sh`（已验收的备份/rsync/chmod 逻辑）。  
3. **不要**在 SaaS API 中恢复 `orders-cache.json` / `gmv-cache.json` / `shops.json` 作为 silent fallback。  
4. **不要**手动 `chmod frontend/dist`、改 nginx、改 PM2 配置替代标准 deploy（除非独立运维工单）。  
5. **不要**在生产设置 `DASHBOARD_DATA_SOURCE=cache`（仅影响 legacy war-room，但易造成口径混乱）。

---

## 8. 回滚到本 Git 标签（开发机）

```bash
git checkout phase2-stable-v1
```

或查看标签说明：

```bash
git show phase2-stable-v1 --no-patch
```

---

## 9. 相关文档

- [STAGING_VERSION.md](../../STAGING_VERSION.md)
- [staging-workflow.md](./staging-workflow.md)
- [rollback-guide.md](./rollback-guide.md)
- [docs/audit/phase2-mysql-only.md](../audit/phase2-mysql-only.md)
