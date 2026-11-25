#!/usr/bin/env bash
# 启动/检查 Trae 运行时（Linux/macOS）——对应 Windows 的 start-runtime.ps1
#
# 做的事：定位运行时目录 → 判活（同一时刻只允许一个实例）→ 后台起 aiserver
#         → 等 aha socket 出现且 .ready 里的 pid 活着 → 再等几秒复查，确认没有「起几秒就退」
#
# 用法：
#   bash deploy/bootstrap-runtime.sh                 # 起（已在跑则只报告）
#   bash deploy/bootstrap-runtime.sh --status        # 只看状态
#   bash deploy/bootstrap-runtime.sh --restart       # 先停再起
#   bash deploy/bootstrap-runtime.sh --root DIR      # 指定运行时目录
#   bash deploy/bootstrap-runtime.sh --wait 120      # 等 socket 的最长秒数（默认 90）
#
# 目录解析顺序：--root → $TRAE2API_ROOT → <脚本目录>/runtime → <脚本目录> → ~/.local/share/trae2api/runtime
set -u

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT=""
WAIT=90
MODE=start

say() { printf '%s\n' "$*"; }
die() { printf '  ❌ %s\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --root)     ROOT="${2:-}"; shift 2 ;;
    --root=*)   ROOT="${1#*=}"; shift ;;
    --wait)     WAIT="${2:-90}"; shift 2 ;;
    --wait=*)   WAIT="${1#*=}"; shift ;;
    --status)   MODE=status; shift ;;
    --restart)  MODE=restart; shift ;;
    --start)    MODE=start; shift ;;
    -h|--help)  sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)          die "未知参数：$1（--help 看用法）" ;;
  esac
done

# ---------- 1) 定位运行时目录 ----------
has_runtime() {
  local p="$1"
  [ -f "$p/run-aiserver.sh" ] || [ -f "$p/runtime/run-aiserver.sh" ]
}

if [ -z "$ROOT" ]; then
  for cand in "${TRAE2API_ROOT:-}" "$SELF_DIR/../trae2api-runtime" "$SELF_DIR/runtime" "$SELF_DIR/.." "$HOME/.local/share/trae2api/runtime"; do
    [ -n "$cand" ] && has_runtime "$cand" && { ROOT="$cand"; break; }
  done
fi
[ -n "$ROOT" ] || die "找不到运行时（没有 run-aiserver.sh）。用 --root 指定，或先跑 deploy/install-from-vsix.cjs"

# 允许 root 指到外层目录
[ -f "$ROOT/runtime/run-aiserver.sh" ] && ROOT="$ROOT/runtime"
ROOT="$(cd "$ROOT" && pwd)"
RUN="$ROOT/run-aiserver.sh"
AHA="$ROOT/aha/aha"
PIDF="$ROOT/aiserver.pid"
LOGD="$ROOT/logs"
mkdir -p "$LOGD" "$AHA"

# ---------- 2) 判活 ----------
pid_alive() { [ -n "${1:-}" ] && kill -0 "$1" 2>/dev/null; }

current_pid() {
  # 优先 pidfile；否则从进程表里找（排除本脚本自身）
  local p=""
  [ -f "$PIDF" ] && p="$(tr -dc '0-9' <"$PIDF" 2>/dev/null)"
  if pid_alive "$p"; then printf '%s' "$p"; return 0; fi
  pgrep -f "node .*aiServerMainV2\.js" 2>/dev/null | head -1
}

agent_sock() { ls "$AHA"/vscode_ai_agent_*.sock 2>/dev/null | head -1; }
server_sock() { ls "$AHA"/trae-*.sock 2>/dev/null | head -1; }

ready_pid() {
  # agent socket 旁边的 .ready 里记的是 ai-agent 的 pid（不是 aiserver 的）
  local f
  f="$(agent_sock)"
  [ -n "$f" ] && [ -f "$f.ready" ] && tr -dc '0-9' <"$f.ready" 2>/dev/null
}

agent_proc() { pgrep -f 'modules/ai-agent/ai-agent' 2>/dev/null | head -1; }
bootcfg_file() {
  find "$ROOT" -maxdepth 8 -name 'trae_plugin_boot_config.json' 2>/dev/null | head -1
}

agent_restarts() {
  local p
  p="$(find "$ROOT" -maxdepth 8 -name 'server-main-*.log' -printf '%T@ %p\n' 2>/dev/null | sort -n | tail -1 | sed 's/^[^ ]* //')"
  [ -n "$p" ] && grep -ac 'ai-agent process exit' "$p" 2>/dev/null
}

show_status() {
  local p ss as ap
  p="$(current_pid)"
  ss="$(server_sock)"
  as="$(agent_sock)"
  ap="$(agent_proc)"
  say "运行时目录 : $ROOT"
  say "aiserver   : ${p:-未运行}$( [ -n "$p" ] && echo "（pid $p 活着）" )"
  if [ -n "$ss" ]; then say "服务端 socket: $(basename "$ss")"; else say "服务端 socket: 无（trae-standalone-*.sock 未出现）"; fi
  if [ -n "$as" ]; then
    say "agent socket : $(basename "$as")"
  else
    say "agent socket : 无（vscode_ai_agent_*.sock 未出现，agent 还没起；一般要等第一次对话）"
  fi
  if [ -n "$ap" ]; then say "ai-agent 进程: pid $ap（活着）"
  else say "ai-agent 进程: 未运行"; fi

  local bc rs
  bc="$(bootcfg_file)"
  if [ -n "$bc" ]; then
    say "boot config : 有（$(stat -c%s "$bc" 2>/dev/null) 字节）"
  else
    say "boot config : ❌ 缺失（trae_plugin_boot_config.json）"
  fi

  rs="$(agent_restarts)"
  if [ -z "$ap" ] && [ -n "$rs" ] && [ "$rs" -ge 2 ]; then
    say ""
    say "  ⚠ 检测到 ai-agent 崩溃循环（本轮已退出 $rs 次）——Linux 上的头号卡点"
    say "    直接原因：ai-agent 启动要读 BOOT_CONFIG_FILE；缺文件或 JSON 里没有 agent 字段就 exit 1，且不往 stderr 打印"
    say "    该文件是云端下发的应用配置，aiserver 不会自己生成"
    say "    处置：① 在面板登录（正常会生成该文件）；② 从任一已登录运行时复制 trae_plugin_boot_config.json 到"
    say "          <运行时>/profile/<pluginHome>/ai-chat/AppData/vscode/"
  fi
  say "日志       : $LOGD/aiserver.log  $LOGD/runtime.out"
}

if [ "$MODE" = status ]; then show_status; exit 0; fi

stop_runtime() {
  local p
  p="$(current_pid)"
  if [ -n "$p" ]; then say "  停 aiserver（pid $p）"; kill "$p" 2>/dev/null; sleep 1; kill -9 "$p" 2>/dev/null; fi
  pkill -f "supervise\.sh" 2>/dev/null
  pkill -f "ai-agent" 2>/dev/null
  rm -f "$PIDF"
  # 清掉上一轮残留的 socket，避免后面误判
  rm -f "$AHA"/*.sock "$AHA"/*.sock.ready 2>/dev/null
  say "  已停（socket 已清理）"
}

if [ "$MODE" = restart ]; then stop_runtime; fi

# ---------- 3) 已在跑就不重复起 ----------
P="$(current_pid)"
if [ -n "$P" ]; then
  say "  ✅ 运行时已在跑（pid $P），不会再起第二个"
  show_status
  exit 0
fi

# ---------- 4) 后台起 aiserver ----------
say "  启动：$RUN"
say "  日志：$LOGD/runtime.out"
cd "$ROOT" || die "进不去 $ROOT"
setsid nohup bash "$RUN" >>"$LOGD/runtime.out" 2>&1 </dev/null &
NEWPID=$!
printf '%s' "$NEWPID" >"$PIDF"

# ---------- 5) 等 socket ----------
say "  等 aha socket（最长 ${WAIT}s）…"
i=0
SOCK=""
while [ "$i" -lt "$WAIT" ]; do
  SOCK="$(agent_sock)"; [ -n "$SOCK" ] || SOCK="$(server_sock)"
  if [ -n "$SOCK" ]; then
    A="$(ready_pid)"
    if [ -n "$A" ] && pid_alive "$A"; then break; fi
    # agent 还没起也算运行时起来了，稍后再看
    break
  fi
  pid_alive "$NEWPID" || break
  i=$((i + 3)); sleep 3
done

if [ -z "$SOCK" ]; then
  say "  ❌ 没等到 socket（${i}s）"
  say "  ---- aiserver.log 末尾 ----"
  tail -12 "$LOGD/aiserver.log" 2>/dev/null
  say "  ---- runtime.out 末尾 ----"
  tail -12 "$LOGD/runtime.out" 2>/dev/null
  exit 1
fi

# ---------- 6) 复查：防止「起几秒就退」 ----------
say "  socket 已出现，复查 8s 存活…"
sleep 8
if ! pid_alive "$NEWPID"; then
  say "  ❌ aiserver 起来后又退出了（这是已知的 Linux 坑）"
  say "  排查要点："
  say "    1) run-aiserver.sh 里 --log-level 必须是数字（3），写 info 会报 Invalid '--log-level NaN'"
  say "    2) --pluginHomePathName 解析出的目录必须真实存在（缺失时 aiserver 会 exit(15)，且不打印原因）"
  say "    3) aha 目录权限必须当前用户可写：$AHA"
  say "  ---- runtime.out 末尾 ----"
  tail -15 "$LOGD/runtime.out" 2>/dev/null
  exit 1
fi

say "  ✅ 运行时已就绪（aiserver pid $NEWPID，socket $(basename "$SOCK")）"
if [ -z "$(bootcfg_file)" ]; then
  say "  ⚠ 注意：还没看到 trae_plugin_boot_config.json —— ai-agent 会因读不到它而 exit 1 循环重启"
  say "    先登录（面板扫码/手机号），或从已登录运行时复制该文件进来；详见 docs/LINUX.md"
fi
show_status
