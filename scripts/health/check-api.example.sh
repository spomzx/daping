#!/usr/bin/env bash
# =============================================================================
# API 健康检查模板（仅输出 curl 示例，默认不发起真实请求）
#
# 实际检查时请设置:
#   export API_BASE_URL="https://your-host.example"
#   export AUTH_TOKEN="eyJ..."   # 可选，用于 /api/auth/me 与 /api/tenants
#   export RUN_CURL=1            # 设为 1 时才执行 curl
# =============================================================================

set -euo pipefail

: "${API_BASE_URL:=http://127.0.0.1:3000}"

AUTH_HEADER=()
if [[ -n "${AUTH_TOKEN:-}" ]]; then
  AUTH_HEADER=(-H "Authorization: Bearer ${AUTH_TOKEN}")
fi

echo "=============================================="
echo " [TEMPLATE] API 健康检查"
echo " API_BASE_URL=${API_BASE_URL}"
echo " RUN_CURL=${RUN_CURL:-0}"
echo "=============================================="

run_or_echo() {
  local desc="$1"
  shift
  echo ""
  echo "--- ${desc} ---"
  printf '示例: curl -fsS'
  for arg in "$@"; do
    printf ' %q' "$arg"
  done
  echo ""
  if [[ "${RUN_CURL:-0}" == "1" ]]; then
    echo "(执行中...)"
    curl -fsS "$@" && echo " OK" || echo " FAILED (exit $?)"
  else
    echo "(未执行 — 设置 RUN_CURL=1 可自动请求)"
  fi
}

# 1. 健康探针（通常无需登录）
run_or_echo "GET /api/health" \
  "${API_BASE_URL}/api/health"

# 2. 当前登录用户（需 JWT）
run_or_echo "GET /api/auth/me" \
  "${AUTH_HEADER[@]}" \
  "${API_BASE_URL}/api/auth/me"

# 3. 租户列表（平台管理员；需 JWT）
run_or_echo "GET /api/tenants" \
  "${AUTH_HEADER[@]}" \
  "${API_BASE_URL}/api/tenants?page=1&page_size=5"

echo ""
echo "[TEMPLATE] 检查结束。"
echo "发布门禁建议: /api/health 返回 200；/api/auth/me 与 /api/tenants 在有效 token 下返回 200。"
