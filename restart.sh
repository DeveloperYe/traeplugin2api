#!/usr/bin/env bash
# 重启 trae2api（Linux/macOS）——对应 Windows 的 restart.ps1
#
# 用法：
#   bash restart.sh              # 重启网关（运行时保留）
#   bash restart.sh --all        # 网关 + 运行时一起重启
#   bash restart.sh --port 18791 # 换端口启动
set -u

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ALL=0
PASS=()

say() { printf '%s\n' "$*"; }

for a in "$@"; do
  case "$a" in
    --all) ALL=1 ;;
    -h|--help) sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) PASS+=("$a") ;;
  esac
done

PIDF="$REPO/logs/gateway.pid"
say "== 停网关 =="
P=""
[ -f "$PIDF" ] && P="$(tr -dc '0-9' <"$PIDF" 2>/dev/null)"
if [ -n "$P" ] && kill -0 "$P" 2>/dev/null; then
  kill "$P" 2>/dev/null; sleep 2; kill -9 "$P" 2>/dev/null; say "  已停（pid $P）"
else
  OTHER="$(pgrep -f "node .*server\.cjs" 2>/dev/null | head -1)"
  if [ -n "$OTHER" ]; then kill "$OTHER" 2>/dev/null; sleep 2; kill -9 "$OTHER" 2>/dev/null; say "  已停（pid $OTHER）"; else say "  本来就没在跑"; fi
fi
rm -f "$PIDF"

if [ "$ALL" -eq 1 ]; then
  say "== 停运行时 =="
  bash "$REPO/deploy/bootstrap-runtime.sh" --restart >/dev/null 2>&1 || true
  say "  已按 --restart 处理"
fi

say "== 启动 =="
if [ "$ALL" -eq 1 ]; then
  exec bash "$REPO/start.sh" ${PASS[@]+"${PASS[@]}"}
else
  exec bash "$REPO/start.sh" --no-runtime ${PASS[@]+"${PASS[@]}"}
fi
