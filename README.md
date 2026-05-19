# TK 数据大屏 · SaaS 稳定版

多租户 TikTok 店铺 GMV / 订单数据大屏。阶段十起进入**稳定维护期**。

**当前 Staging 锁定**：`staging-2026-05-18-stable-v1`（见 [发布快照](docs/releases/staging-2026-05-18-stable-v1.md)）

## 架构（三层）

| 层 | 说明 | 文档 |
|----|------|------|
| **SaaS** | `/dashboard` … `/users`，MySQL 主数据源 | [system-architecture.md](docs/system-architecture.md) |
| **Ops** | `/api/ops/*`，平台管理员运维 | [ops-boundary.md](docs/ops-boundary.md) |
| **Legacy** | `/legacy` + 旧 `/api/dashboard` | [deprecated-list.md](docs/deprecated-list.md) |

## 快速启动

```bash
# 后端
cd backend && npm install && cp .env.example .env
npm run dev

# 前端
cd frontend && npm install && npm run dev
```

## 文档

- [API 映射](docs/api-map.md)
- [数据源策略](docs/data-source-policy.md)
- [版本锁定](docs/version-lock.md)
- [Staging 稳定版 v1](docs/releases/staging-2026-05-18-stable-v1.md)

## 维护原则

新功能按模块开发；禁止扩展 Legacy；禁止 SaaS 读 cache/json 主链路。详见 `docs/version-lock.md`。
