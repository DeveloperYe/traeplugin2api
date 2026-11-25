#!/usr/bin/env bash
# 启动 trae2api 网关（Linux/macOS）——对应 Windows 的 start-trae2api.ps1
#
# 做的事：定位仓库与运行时 → 起运行时（可跳过）→ 后台起网关 → 等 /healthz 通过 → 打印地址与密钥
#
# 用法：
#   bash start.sh                  # 起运行时（如未跑）+ 起网关
#   bash start.sh --no-runtime     # 只起网关（运行时自己管）
#   bash start.sh --port 18790     # 指定端口（默认取 data/deploy.json，其次 18790）
#   bash start.sh --status         # 只看状态
#   bash start.sh --foreground     # 前台跑（调试用，Ctrl-C 结束）
set -u

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT=""
NO_RUNTIME=0
MODE=start

say() { printf '%s\n' "$*"; }
die() { printf '  ❌ %s\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --port)        PORT="${2:-}"; shift 2 ;;
    --port=*)      PORT="${1#*=}"; shift ;;
    --no-runtime)  NO_RUNTIME=1; shift ;;
    --status)      MODE=status; shift ;;
    --foreground)  MODE=foreground; shift ;;
    -h|--help)     sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)             die "未知参数：$1（--help 看用法）" ;;
  esac
done

# ---------- 1) node ----------
NODE="$(command -v node 2>/dev/null || true)"
[ -n "$NODE" ] || die "找不到 node（需要 Node 18+）"
NODE_MAJOR="$("$NODE" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
[ "$NODE_MAJOR" -ge 18 ] 2>/dev/null || die "node 版本过低：$("$NODE" -v)，需要 18+"

# ---------- 2) 部署信息 ----------
DEPLOY="$REPO/data/deploy.json"
RUNTIME_ROOT=""
if [ -f "$DEPLOY" ]; then
  RUNTIME_ROOT="$("$NODE" -e 'try{const j=require(process.argv[1]);process.stdout.write(j.root||"")}catch{}' "$DEPLOY" 2>/dev/null || true)"
  [ -n "$PORT" ] || PORT="$("$NODE" -e 'try{const j=require(process.argv[1]);process.stdout.write(String(j.port||""))}catch{}' "$DEPLOY" 2>/dev/null || true)"
fi
[ -n "$PORT" ] || PORT=18790

PIDF="$REPO/logs/gateway.pid"
mkdir -p "$REPO/logs"
GLOG="$REPO/logs/gateway.log"

health() {
  "$NODE" -e '
    fetch("http://127.0.0.1:" + process.argv[1] + "/healthz", { signal: AbortSignal.timeout(3000) })
      .then((r) => r.text().then((t) => { process.stdout.write(String(r.status) + " " + t); process.exit(0); }))
      .catch(() => process.exit(1));
  ' "$PORT" 2>/dev/null
}

gateway_pid() {
  local p=""
  [ -f "$PIDF" ] && p="$(tr -dc '0-9' <"$PIDF" 2>/dev/null)"
  if [ -n "$p" ] && kill -0 "$p" 2>/dev/null; then printf '%s' "$p"; return 0; fi
  pgrep -f "node .*server\.cjs" 2>/dev/null | head -1
}

show_status() {
  local p h
  p="$(gateway_pid)"
  say "仓库   : $REPO"
  say "端口   : $PORT"
  say "网关   : ${p:-未运行}$( [ -n "$p" ] && echo "（pid $p 活着）" )"
  h="$(health || true)"
  if [ -n "$h" ]; then say "healthz: $h"; else say "healthz: 不通"; fi
  if [ -f "$REPO/data/config.json" ]; then
    say "密钥   : 见 $REPO/data/config.json 的 api_key（面板同文件 panel_password）"
  fi
  say "日志   : $GLOG"
}

if [ "$MODE" = status ]; then show_status; exit 0; fi

# ---------- 3) 已在跑就不重复起 ----------
if [ -n "$(gateway_pid)" ] && [ -n "$(health || true)" ]; then
  say "  ✅ 网关已在跑，不重复启动"
  show_status
  exit 0
fi

# ---------- 4) 起运行时 ----------
if [ "$NO_RUNTIME" -eq 0 ]; then
  BOOT="$REPO/deploy/bootstrap-runtime.sh"
  if [ -f "$BOOT" ]; then
    args=()
    [ -n "$RUNTIME_ROOT" ] && args+=(--root "$RUNTIME_ROOT")
    say "== 运行时 =="
    bash "$BOOT" ${args[@]+"${args[@]}"} || say "  ⚠ 运行时没起来，网关仍会启动（面板里可以手动重试 /api/heal）"
  else
    say "  ⚠ 没有 deploy/bootstrap-runtime.sh，跳过运行时"
  fi
else
  say "== 跳过运行时（--no-runtime）=="
fi

# ---------- 5) 起网关 ----------
cd "$REPO" || die "进不去 $REPO"
say "== 网关 =="
if [ "$MODE" = foreground ]; then
  PORT="$PORT" exec "$NODE" server.cjs
fi

PORT="$PORT" setsid nohup "$NODE" server.cjs >>"$GLOG" 2>&1 </dev/null &
NEW=$!
printf '%s' "$NEW" >"$PIDF"

say "  等 /healthz（最长 30s）…"
i=0
while [ "$i" -lt 30 ]; do
  H="$(health || true)"
  if [ -n "$H" ]; then break; fi
  kill -0 "$NEW" 2>/dev/null || break
  i=$((i + 1)); sleep 1
done

if [ -z "${H:-}" ]; then
  say "  ❌ 网关没起来（${i}s）"
  tail -15 "$GLOG" 2>/dev/null
  exit 1
fi

say "  ✅ 网关已就绪：http://127.0.0.1:$PORT   （$H）"
say ""
show_status
