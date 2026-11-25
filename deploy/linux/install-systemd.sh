#!/usr/bin/env bash
# 在 Linux 上安装 traeplugin2api 为 systemd 服务（开机自启 + 崩溃自动重启）
#
# 用法：
#   sudo ./deploy/linux/install-systemd.sh                     # 装当前目录这个部署
#   sudo ./deploy/linux/install-systemd.sh --dir /opt/traeplugin2api --port 18790
#   sudo ./deploy/linux/install-systemd.sh --no-browser          # 跳过下载自带浏览器内核
#
# 会做：
#   1) 检查 node / data/config.json（没有口令就提示先跑一次 server.cjs 生成）
#   2) 从模板渲染 /etc/systemd/system/traeplugin2api.service
#   3) systemctl daemon-reload && enable --now
#
# 注意：本脚本尚未在真机 Linux 上验证过（见 docs/LINUX.md）。首次安装请盯一眼日志：
#   journalctl -u traeplugin2api -f
set -euo pipefail

DIR=""
PORT="${PORT:-18790}"
ROOT="${TRAE2API_ROOT:-}"
NAME="traeplugin2api"
WITH_BROWSER="${WITH_BROWSER:-1}"   # 默认拉一份自带浏览器内核（面板登录用），--no-browser 跳过

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dir)  DIR="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --root) ROOT="$2"; shift 2 ;;
    --no-browser) WITH_BROWSER="0"; shift ;;
    -h|--help) sed -n '2,18p' "$0"; exit 0 ;;
    *) echo "未知参数: $1"; exit 2 ;;
  esac
done

[[ -z "$DIR" ]] && DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DIR="$(cd "$DIR" && pwd)"
[[ -z "$ROOT" ]] && ROOT="$DIR/runtime"

NODE="$(command -v node || true)"
[[ -z "$NODE" ]] && { echo "❌ 找不到 node（建议 Node.js >= 20）"; exit 1; }

if [[ ! -f "$DIR/data/config.json" ]]; then
  echo "⚠ $DIR/data/config.json 不存在。"
  echo "  先手动跑一次（会自动生成随机口令并打印）："
  echo "    cd $DIR && PORT=$PORT node server.cjs"
  exit 1
fi

if ! grep -q '"panel_password"[[:space:]]*:[[:space:]]*"[^"]' "$DIR/data/config.json"; then
  echo "❌ data/config.json 里没有 panel_password：网关会拒绝启动（见 README 8.5）。"
  exit 1
fi

# 运行时 aha 目录：自举部署在 <root>/runtime/aha/aha，否则 <root>/aha/aha
AHA_DIR="$ROOT/aha/aha"
[[ -f "$ROOT/runtime/.deployed.json" ]] && AHA_DIR="$ROOT/runtime/aha/aha"
AHA_DIR="${TRAE2API_AHA_DIR:-$AHA_DIR}"

RUN_USER="${SUDO_USER:-$USER}"
HOME_DIR="$(getent passwd "$RUN_USER" | cut -d: -f6)"
TPL="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$NAME.service"
UNIT="/etc/systemd/system/$NAME.service"

echo "  部署目录 : $DIR"
echo "  运行时根 : $ROOT   (aha: $AHA_DIR)"
echo "  运行用户 : $RUN_USER"
echo "  node     : $NODE"
echo "  端口     : $PORT"

sed -e "s|@USER@|$RUN_USER|g" \
    -e "s|@DIR@|$DIR|g" \
    -e "s|@NODE@|$NODE|g" \
    -e "s|@HOME@|$HOME_DIR|g" \
    -e "s|@ROOT@|$ROOT|g" \
    -e "s|@AHA_DIR@|$AHA_DIR|g" \
    -e "s|@PORT@|$PORT|g" \
    "$TPL" > "$UNIT"

# ---------- 自带浏览器内核（面板登录用；失败不阻塞，回退系统 chromium）----------
if [[ "$WITH_BROWSER" == "1" && -f "$DIR/deploy/fetch-browser.cjs" ]]; then
  echo "  准备自带浏览器内核（chrome-headless-shell；约 126 MB，--no-browser 跳过）…"
  if node "$DIR/deploy/fetch-browser.cjs" --dir "$DIR/runtime/browser"; then
    echo "  内核就绪"
  else
    echo "  ⚠ 内核未就绪（会自动回退系统 chromium；Linux 还需要 NSS/ATK 等系统库，缺库时上面已列出 apt 命令）"
  fi
fi

systemctl daemon-reload
systemctl enable --now "$NAME"

sleep 3
if systemctl is-active --quiet "$NAME"; then
  echo "✅ 已启动：systemctl status $NAME / journalctl -u $NAME -f"
  curl -s --max-time 5 "http://127.0.0.1:$PORT/healthz" || true
  echo
else
  echo "❌ 启动失败，看：journalctl -u $NAME -n 50 --no-pager"
  exit 1
fi
