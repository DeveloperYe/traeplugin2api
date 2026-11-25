# Linux 支持（分支 `feat/linux`）

目标：在 Linux（x86_64 / arm64）上把网关 + 自包含运行时跑起来，功能与 Windows 版对齐：
`/v1/models`、`/v1/chat/completions`（SSE + tools）、面板、面板内登录（扫码 / 手机号验证码）、凭据 24h 自动续期。

> 状态：**平台适配已完成，Linux 实跑待验证**（需要一份 VSIX 才能解出 Linux 运行时）。
> Windows 行为未受影响：同一套代码在本机 8/8 + 23/23 + 21/21 + 10/10 全过（见文末）。

---

## 1. 为什么 Linux 版工作量不大

| 层面 | 结论 |
|---|---|
| 网关主链路（`server.cjs`、`lib/trae.cjs`、`tools-bridge`、`call-parse`、`attachments`、面板） | 纯 Node，**零平台依赖** |
| 运行时通讯 | ZeroMQ `ipc://` → Linux 原生 Unix domain socket |
| 运行时二进制 | VSIX 里**本来就带** `resources/binaries/linux-*`（安装器当前主动丢弃，约 88–92 MB） |
| 凭据 | Linux 不需要 DPAPI：已有 `data/token-cache.json` 退路，面板登录正好写它 → 依赖更少 |
| 浏览器登录 | 需要 chromium（`apt install chromium` 约 100 MB） |

---

## 2. 本分支已完成的平台适配

| # | 文件 | 改动 |
|---|---|---|
| 1 | `lib/aha.cjs` | `findAddon()` 重写为平台感知，新增 `addonCandidates(explicit, platform, arch)`：<br>① `TRAE2API_AHA_ADDON` → ② 运行时根 `<root>/aiserver/(zmq\|index).<平台>-<arch>.node`（VSIX 的 linux/darwin 包布局）→ ③ `<root>/aiserver/prebuild/<os>/<arch>/node/<toolchain>/addon.node` → ④ `~/.vscode{,-server}/extensions/marscode.*`（按版本倒序） |
| 2 | `lib/creds.cjs` | 用户数据目录按平台推导（`%APPDATA%` / `~/Library/Application Support` / `$XDG_CONFIG_HOME`），**不再因 `APPDATA` 缺失在加载时崩溃**；非 Windows 上 `_safeKey()` 直接给出「请走 token-cache 或面板登录」的可读错误；`icacls` 仅在 Windows 执行，Linux 改 `chmod 600` |
| 3 | `lib/cdp.cjs` | 浏览器探测按平台分组：Windows 保留 Edge/Chrome，Linux/macOS 增加 `chromium`/`chromium-browser`/`google-chrome`/`/snap/bin/chromium`/macOS app 路径；`CDP_EXE` 仍可覆盖；导出 `pickBrowser` 供测试 |
| 4 | `server.cjs` | 面板登录后「重启运行时」不再写死 `powershell.exe`：Windows 用 CIM，Linux/macOS 用 `pgrep -f aiServerMainV2`（退路 `ps \| grep`） |
| 5 | `test-platform-paths.cjs` | 新增 8 个用例：平台候选隔离、arm64 路径、显式/env 覆盖、本机真实命中、creds 可加载、非 Windows 无 DPAPI 的可读报错、浏览器探测 |

---

## 3. 还差的部分（需要 VSIX 才能验证）

| # | 事项 | 位置 | 说明 |
|---|---|---|---|
| A | 安装器平台化 | `deploy/install-from-vsix.cjs` | 解 `resources/binaries/<os>-<arch>.7z`（Linux 用 VSIX 自带 `resources/tools/7z/linux-x64/7za` 或系统 `7z`）；生成 `run-aiserver.sh` 而不是 `.cmd`（`HOME`/`XDG_*` 代替 `USERPROFILE`/`APPDATA`） |
| B | 保活与自启 | `deploy/linux/` | **已给出** `traeplugin2api.service` 模板 + `install-systemd.sh`（渲染占位符、校验口令、`enable --now`、健康检查）；bash 语法与 `--help` 已在 WSL 验证，**未在真机装过** |
| C | 启动/重启脚本 | `start.sh`、`restart.sh`、`deploy/bootstrap-runtime.sh` | ✅ **已完成（2026-11-23）**：目录自适应、`kill -0` 判活、socket 就绪判定、起后 8 秒存活复查、崩溃循环诊断；用法见 §4.5 |
| D | 面板内登录 | `lib/trae-login.cjs` | 需要 chromium；`--headless=new` 在 Linux 上的行为要实测 |
| E | 文档 | `README.md` | 合并到 main 时增加 Linux 一节（依赖、systemd、目录规则）；本分支先看本文 |

**关键未知（必须实测）**

1. VSIX 的 Linux 运行时是否完整可用（`ai-agent` + `ckg`，是否依赖 X11/glibc 版本）；
2. 启动参数 `--machine-id` / `--region` / `--pluginHomePathName` / `--aha-ipc-runtime-dir` 在 Linux 是否同样接受；
3. Linux `ai-agent` 的 socket 命名是否仍是 `vscode_ai_agent_*`（通道发现依赖此前缀）；
4. `ai-agent` 在 Linux 是否需要额外的 `vsce`/扩展宿主环境变量。

---

## 3.5 首轮 Linux 实跑结果（2026-11-22，WSL Ubuntu2604）

拿到 VSIX 后在 WSL 里原生跑了一遍，**运行时能起来**，卡点已定位：

| 步骤 | 结果 |
|---|---|
| 解 VSIX（linux-x64） | ✅ aiserver 6688 文件 / 220 MB；`linux-x64.7z` 解出 555 MB（`ai-agent` 433 MB + `ckg_server` 37 MB） |
| 补丁 | ✅ `$Ur=0x3c*0x3e8` → `0x7fffffff`（1 处） |
| 启动 aiserver | ✅ 起来了（Linux 用 `node aiServerMainV2.js ...` 即可，参数与 Windows 相同） |
| zeromq 原生模块 | ✅ `prebuild/linux/x64/node/glibc-127-Release/addon.node` 加载成功（导出 Context/Socket/Dealer） |
| **socket** | ✅ **`trae-linux-1.sock` + `vscode_ai_agent_1.7.16_xxxxx.sock` 都出现了** |
| ai-agent 进程 | ⚠ 起来了但**几秒后自己退出** → **已定案（2026-11-23）：缺 `trae_plugin_boot_config.json`，见 §3.7** |
| 网关连 Linux 运行时 | ⚠ `connected:false`——因为 `.sock.ready` 里的 pid 已退出（pidAlive 判死是对的） |
| 网关本身在 Linux | ✅ 面板 200、`/healthz` ok、`/api/status` 正常；`creds` 报「读不到 SecretStorage 也没有本地缓存」= **符合设计**（Linux 上没有 DPAPI，走面板登录写 token-cache） |

**踩到并修掉的两个坑**

1. **`prebuild/manifest.json` 被平台过滤误删** → aiserver 的 zeromq 加载器靠它索引，缺了就报
   `Failed to load zeromq. Ensure it is installed and supported on your platform`，
   随后 `TypeError: _0xfecbcc is not a constructor` 崩掉 `createAhaServer`。
   （对照实验：Windows 上用同一份过滤产物同样复现，补回 manifest 后两边都好了）
   → 过滤规则改为「prebuild 下只按平台丢 `*.node`，其余文件一律保留」。
2. 7zz 从 VSIX 解出来默认没有可执行位 → 安装器在非 Windows 上补 `chmod 755`。

**下一步**

1. 查 ai-agent 为何退出（看 `$HOME/.icube/ai-agent/` 与 aiserver 日志里的 agent 退出原因）；
2. 面板内登录需要在 WSL 装 chromium（`apt install chromium`），否则只能手工把 `token-cache.json` 拷进去；
3. 补 `start.sh` / `restart.sh` / `bootstrap-runtime.sh`，把 `.ps1` 那套逻辑移植成 bash；
4. systemd unit 真机装一次（脚本已就绪）。

## 3.6 自带浏览器内核（已实现并双端验证，2026-11-22）

Linux 上不再需要 `apt install chromium`——改成按需下载 `chrome-headless-shell`：

```bash
node deploy/fetch-browser.cjs           # 装到 <仓库>/runtime/browser/158.x/linux64/
node deploy/fetch-browser.cjs --status  # 自检
```

| 项 | 实测值（WSL Ubuntu2604） |
|---|---|
| 下载 | 126 MB（npmmirror，5 MB/s 级别） |
| 解压 → 裁剪后 | 282 MB → **228 MB**（locales 只留 en-US、删 SwiftShader：删掉 222 个文件 / 53.7 MB） |
| `--version` | `Google Chrome for Testing 158.0.8127.36` |
| 启动 | **1.2 s**（对比：系统 Edge 首启约 20 s） |
| 真实登录页 | 跳转 `accounts.doubao.com` SSO，标题「登录豆包飞书账号」 |
| 二维码截图 | **23.2 KB PNG / 324×324**，选择器 `img[alt*="扫码"]` 第 1 轮命中 |

**Linux 上仍需系统库**（自带内核 ≠ 零依赖）：

```bash
sudo apt-get install -y libnss3 libnspr4 libasound2t64 libatk1.0-0t64 libatk-bridge2.0-0t64 \
  libatspi2.0-0t64 libcups2t64 libdrm2 libgbm1 libxkbcommon0 libxcomposite1 libxdamage1 \
  libxfixes3 libxrandr2 libpango-1.0-0 libcairo2
```

缺库时 `fetch-browser.cjs` 会打印缺哪些 `.so` 与对应安装命令，文件保留在磁盘，装完 `--status` 复查即可。

实现要点：`lib/cdp.cjs` 新增 `bundledCandidates()` / `isHeadlessShell()` / `launchArgs()`；
headless shell **不传 `--headless=new`**（它本身无头）、额外带 `--disable-dev-shm-usage`；
Linux root/容器自动加 `--no-sandbox`（`TRAE_LOGIN_NO_SANDBOX=1` 可强制）。

## 4. 验证环境（本机已具备）

```
WSL 发行版   Ubuntu2604（systemd 作为 init，可直接测 unit）
node        v22.22.1        npm 9.2.0
glibc       2.43            arch x86_64
待装        chromium（面板内登录）   p7zip-full + unzip（解包）
```

验证步骤（拿到 VSIX 之后）：

```bash
# 0) 准备
sudo apt update && sudo apt install -y chromium p7zip-full unzip
# 1) 克隆分支并放 VSIX
git clone -b feat/linux <repo> && cd traeplugin2api && mkdir -p vsix && cp /mnt/c/.../marscode.*.vsix vsix/
# 2) 解包运行时（待 A 完成；先手工验证 7z 能否解出 linux 二进制）
7z l vsix/*.vsix | grep -E 'binaries/(linux|darwin)'
# 3) 起运行时 → 看 socket
ls runtime/aha/aha/*.sock
# 4) 起网关
node server.cjs    # 首跑会生成 data/config.json 并打印随机口令
# 5) 打开 panel → 面板内登录（扫码 / 手机号）→ 对话 + 工具调用
```

---

## 3.7 ai-agent 为什么 `exit 1`（2026-11-23 定案）

**结论：不是平台不兼容，是缺 `trae_plugin_boot_config.json`（云端下发的应用配置）。**

排查链路（全部有回执）：

| 步骤 | 现象 | 证据 |
|---|---|---|
| 1 | aiserver 起 ~0 秒就退，`exit(15)`，日志只有两行 | `node --trace-exit` 打出 `process.exit(15)`；`--require` 一个 shim 后抓到 `path.join` 收到 `["/home/ubuntu", null]` |
| 2 | 原因：`HOME/<pluginHomePathName>` 目录不存在时，`start()` 里 `path.join(homedir, <null>)` 崩掉 | 把该目录造出来（或让 HOME 指对）后不再崩 |
| 3 | aiserver 活了，但 ai-agent 每 3 秒 `exit with code 1`，**stdout/stderr 都是 0 字节** | `server-main-*.log`：`ai-agent process exit with code 1, description:` + 反复 `restarting...`（30 分钟 48 次） |
| 4 | 绕过 aiserver 直接跑 agent（不设 `ICUBE_MANAGER_LOG_DIR`，日志就打到 stdout） | `BOOT_CONFIG_FILE not set`；给 `{}` 则是 `deserialize BootConfig failed: Error("missing field 'agent'")`；3 次重试后 `boot config fetch failed` 并退出 |
| 5 | 放入一份**有效**的 boot config 后重启 | `spawned=1 exit=0`，同一个 pid 稳定存活 30 秒以上 |

**boot config 在哪、长什么样**：`<运行时>/profile/<pluginHome>/ai-chat/AppData/vscode/trae_plugin_boot_config.json`，
顶层键 `agent{domain,appId,misc{ideCn,ideUs,bytegate,iac}}`、`ckg`、`tea`、`slardar`、`ttnet`、`ws`、`isNetworkBytedance`。
它是**云端应用配置**（不含用户 token），aiserver 不会自己生成，正常由登录/握手阶段落盘。

**首跑解锁办法（二选一）**：

1. 面板里登录（扫码 / 手机号）→ 正常会生成该文件；
2. 从任意已登录的 Trae 运行时复制这个 json 进来（内容与账号无关）。

**已写进工具**：`deploy/bootstrap-runtime.sh` 会检测「agent 未运行 + 本轮退出 ≥2 次 + boot config 缺失」，
直接打印上面这段处置说明，不用再翻日志。

---

## 4.5 三个脚本怎么用（Linux）

三个脚本都在仓库根，都支持 `--help`，逻辑与 Windows 的 `.ps1` 对齐。

```bash
# 1) 运行时：起 / 看待 / 重启
bash deploy/bootstrap-runtime.sh                     # 自动找运行时目录
bash deploy/bootstrap-runtime.sh --root ~/trae-rt     # 指定目录
bash deploy/bootstrap-runtime.sh --status             # 只看状态（含 boot config 检查）
bash deploy/bootstrap-runtime.sh --restart --wait 120

# 2) 网关
bash start.sh                 # 确保运行时在跑 + 起网关
bash start.sh --no-runtime    # 只起网关
bash start.sh --status        # 状态 + /healthz
bash start.sh --foreground    # 前台调试

# 3) 重启
bash restart.sh          # 只重启网关
bash restart.sh --all    # 网关 + 运行时一起重启
```

脚本约定：后台进程一律 `setsid nohup … </dev/null &`（脱离 ssh/wsl 会话也能活），
pid 落在 `<运行时>/aiserver.pid` 与 `logs/gateway.pid`，日志落在 `logs/`。

## 5. 当前回归（Windows，本分支）

```
test-call-parse      23/23
test-tools-bridge    21/21
test-panel-escape    10/10
test-platform-paths   8/8
```

`findAddon()` 在本机仍命中与改动前**同一个**文件
（`~/.vscode/extensions/marscode.marscode-extension-1.7.16/resource/aiserver/prebuild/win32/x64/node/msvc-115-Release/addon.node`），
`pickBrowser()` 仍返回 Edge —— 即 Windows 行为零变化。
