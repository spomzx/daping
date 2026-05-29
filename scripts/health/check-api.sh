#!/usr/bin/env bash
# API 健康检查（服务器专用）
# 用法:
#   bash scripts/health/check-api.sh [staging|prod]
#   AUTH_TOKEN=eyJ... bash scripts/health/check-api.sh staging
set -e

ENV_NAME="${1:-staging}"

case "${ENV_NAME}" in
  staging|stag|s)
    API_BASE="http://127.0.0.1:3081"
    ;;
  prod|production|p)
    API_BASE="http://127.0.0.1:3080"
    ;;
  *)
    echo "用法: $0 [staging|prod]"
    exit 1
    ;;
esac

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

ok()   { echo -e "${GREEN}OK${NC}   $*"; }
fail() { echo -e "${RED}FAIL${NC} $*"; }
skip() { echo -e "${YELLOW}SKIP${NC} $*"; }

check_get() {
  local name="$1"
  local url="$2"
  shift 2
  if curl -fsS --connect-timeout 10 --max-time 30 "$@" "${url}" >/dev/null; then
    ok "${name}  ${url}"
    return 0
  else
    fail "${name}  ${url}"
    return 1
  fi
}

echo "API_BASE=${API_BASE}  ENV=${ENV_NAME}"
echo "----------------------------------------------"

FAILED=0

check_get "GET /api/health" "${API_BASE}/api/health" || FAILED=$((FAILED + 1))

if [[ -n "${AUTH_TOKEN:-}" ]]; then
  AUTH_H=(-H "Authorization: Bearer ${AUTH_TOKEN}")
  check_get "GET /api/auth/me" "${API_BASE}/api/auth/me" "${AUTH_H[@]}" || FAILED=$((FAILED + 1))
  check_get "GET /api/tenants" "${API_BASE}/api/tenants?page=1&page_size=5" "${AUTH_H[@]}" || FAILED=$((FAILED + 1))
else
  skip "GET /api/auth/me     (未设置 AUTH_TOKEN)"
  skip "GET /api/tenants    (未设置 AUTH_TOKEN)"
fi

echo "----------------------------------------------"
if [[ "${FAILED}" -eq 0 ]]; then
  echo -e "${GREEN}ALL CHECKS PASSED${NC}"
  exit 0
else
  echo -e "${RED}${FAILED} CHECK(S) FAILED${NC}"
  exit 1
fi
