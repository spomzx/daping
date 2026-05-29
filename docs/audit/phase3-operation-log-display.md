# Phase3｜日志中心可读性优化（展示层）

## 范围

仅前端展示与映射，**不改 API / 数据库 / 写入逻辑**。

## 改动摘要

| 项 | 说明 |
|----|------|
| 去重标题 | 移除 `SaasPageFrame` 内 `title="日志中心"`，保留 `AdminLayout` 顶栏标题 |
| 映射工具 | `frontend/src/lib/operationLogDisplay.ts` |
| 表格列名 | 操作模块 / 操作内容 / 操作对象 / 结果 |
| 动作/模块/状态 | 中文展示；未知 action 用浅色 `code` |
| 操作对象 | `user:27` → `用户 ID：27`；有 `target_name` 或店铺名时优先显示名称 |
| 详情 Drawer | 主信息中文 +「技术字段」保留 module/action/target |

## 验收

- `/logs` 仅一处「日志中心」标题
- 表格少出现 `login_success` 等裸 code（已知动作已映射）
- 状态显示「成功/失败」且颜色不变
- `npm run build` 通过
- staging 人工打开 https://stag.cqchic-cq.top/logs
