# Phase3｜日志中心 Token 认证修复

## 根因

`/logs` 页面使用裸 `apiFetch()` 手动拼接 `getAuthHeaders()`，未走项目统一的 `fetchWithAuth` / `services/api/client.apiGet`。

在 staging 构建与运行时环境下，该路径未稳定携带 `Authorization: Bearer <token>`，后端 `authRequired` 返回：

```json
{ "error": "missing_token" }
```

前端将非 2xx 简写为 `stats http 500` / `stats http 401`，用户无法判断真实原因。

## 修改文件

| 文件 | 变更 |
|------|------|
| `frontend/src/services/api/operationLogs.ts` | 新增；`apiGet` + `fetchWithAuth` 封装 stats / list / detail |
| `frontend/src/pages/Logs/OperationLogCenterPage.tsx` | 改用 service；可读错误 + 重试按钮 |
| `frontend/src/pages/Logs/logs-page.css` | 错误面板与重试样式 |
| `frontend/src/components/logs/LogDetailDrawer.tsx` | 详情加载失败提示（可选 `error`） |

## Token 修复方式

与 `users` / `tenants` / `sync` 一致：

1. `apiGet(path, query)` → `fetchWithAuth`
2. `fetchWithAuth` 从 `localStorage` 读取 `daping_auth_token`，设置 `Authorization: Bearer …`
3. 401 `missing_token` / `invalid_token` 等由 `apiClient` 统一跳转登录

禁止在本模块新增裸 `fetch`、`axios.create` 或手写 token 拼接。

## Staging 验收结果

> 部署后由人工填写。

| 项 | 结果 |
|----|------|
| `https://stag.cqchic-cq.top/logs` stats 卡片正常 | ☐ |
| 无 `stats http 500` | ☐ |
| Network 全部 200 | ☐ |
| Request Headers 含 `Authorization: Bearer` | ☐ |
| PM2 无 `missing_token` | ☐ |

验收命令示例：

```bash
# 需替换为有效 admin token
curl -s -H "Authorization: Bearer $TOKEN" \
  "http://127.0.0.1:3081/api/operation-logs/stats"
```
