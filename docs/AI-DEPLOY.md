# 让 AI 帮你部署/维护（可直接粘贴的指令）

> 用途：把这份文件整段发给你的 AI（Claude / GPT / Cursor / 任何能执行命令的助手），
> 让它按固定顺序部署、自检、排障，**不要自己发明步骤**。
>
> 本版对应 2026-11-25 的代码（README 4.0.70）：含运行时自愈（healer）、5 秒看护（watch-runtime）、
> 独立预热（warm-runtime）、版本自检（check-version）、模型名校验、凭据 ACL 加固，
> 以及 **空闲看门狗可配（`idle_timeout_ms`）、空帧保活（`stream_keepalive_ms`）、
> 按模型标注上下文/输出容量（四张 override 表）、打满上限标 `finish_reason=length`**。
>
> **完整配置清单见 [CONFIG.md](CONFIG.md)**（50 个键 + 17 个环境变量，逐条对过代码）。

---

## 0. 给 AI 的一句总要求

> 用仓库自带的脚本部署与排障，**不要手写解包/启动/下载逻辑**；
> 每步执行完贴出完整输出；失败最多重试 2 次，然后把日志贴回来；不要改仓库外的东西，不要 `git push`。

---

## 1. 可直接粘贴的提示词（把 `<...>` 换成你的路径）

```
环境：Windows + PowerShell 7，Node.js ≥ 20。
网关目录：<网关目录，例如 D:\apps\trae2api>
运行时根：<运行时根，例如 D:\apps\trae2api-runtime>

请严格按顺序执行，不要自创步骤、不要 git push、不要替我登录：

1) cd <网关目录>
   git pull                       # 没有 git 就跳过，改用我提供的最新代码包

2) 版本自检（先看缺什么，再决定更新哪些文件）：
   node deploy\check-version.cjs --dir <网关目录>

3) 部署/更新运行时（幂等，已部署会秒退）：
   pwsh -NoProfile -ExecutionPolicy Bypass -File deploy\bootstrap-runtime.ps1 -Root <运行时根>

4) 装自带浏览器内核（约 120 MB，失败不阻塞）：
   node deploy\fetch-browser.cjs --dir <运行时根>\runtime\browser
   node deploy\fetch-browser.cjs --dir <运行时根>\runtime\browser --status

5) 确认「只有一个监护人」，再启动运行时：
   Get-CimInstance Win32_Process | ? { $_.CommandLine -match 'watch-runtime|supervise\.ps1' } | select ProcessId,CommandLine
   Get-CimInstance Win32_Process -Filter "Name='node.exe'" | ? { $_.CommandLine -match 'aiServerMainV2' } | select ProcessId
   pwsh -NoProfile -File start-runtime.ps1 -Root <运行时根>
   # 若上面发现旧 supervise 计划任务在跑，先停用它，避免双看护打架：
   # Disable-ScheduledTask -TaskName 'trae-runtime-super'

6) 验收（全部贴给我）：
   - Get-ChildItem <运行时根>\runtime\aha\aha -Filter *.sock     → 至少一个 vscode_ai_agent_*.sock
   - curl.exe -s http://127.0.0.1:18790/healthz                  → 含 "connected":true
   - curl.exe -s -H "Authorization: Bearer <api_key>" http://127.0.0.1:18790/api/status
                                                                 → models 数量、heal 字段、creds.hasCreds
   - Get-Content <网关目录>\data\trae2api.log -Tail 30           → 出现「握持成功」/「[probe] … 启动」/「[warm] … 完成」

7) 把 1–6 的全部输出贴给我。不要执行登录（我自己在面板点）。
```

---

## 2. 脚本速查（都在仓库里，AI 直接用）

| 命令 | 作用 | 关键参数 |
|---|---|---|
| `node deploy/check-version.cjs --dir <部署目录>` | **版本自检**：54 项逐项 ✓/✗ 是否含最新修复（含 4.0.60–4.0.72 的全部能力） | `--json` 便于解析；退出码 0=全具备 |
| `node deploy/watch-runtime.cjs --dest <运行时目录>` | **常驻看护**（默认 5s）：崩了立刻拉起+预热；进程活着但链路挂死时让网关自愈 | `--interval 3`、`--no-warm`、`--no-heal`、`--dry-run` |
| `node deploy/warm-runtime.cjs --dest <运行时目录>` | **独立预热**（不依赖网关）：连 AHA 拉目录 + 一次极小 chat | `--model`、`--timeout-ms`、`--dry-run` |
| `node deploy/fetch-browser.cjs --dir <目录>` | 下载/裁剪 chrome-headless-shell | `--status`（只复查）、`--force` |
| `pwsh start-runtime.ps1 -Root <运行时根>` | 一条命令起运行时并等到 `connected:true` | `-Restart`（先停再起）、`-Foreground`、`-WatchInterval 3`、`-LegacySupervise` |
| `POST /api/heal` | 手动触发运行时自愈（网关执行，含 inflight 保护） | 需 `Authorization: Bearer <api_key>` |
| `pwsh deploy/bootstrap-runtime.ps1 -Root <根>` | 解包 VSIX 部署运行时 | `-Force`、`-NoBrowser` |
| `pwsh deploy/setup.ps1` | 一键部署网关（含内核） | `-NoBrowser`、`-DryRun` |

---

## 3. 铁律：只能有一个「监护人」

| 监护方式 | 说明 |
|---|---|
| `deploy/watch-runtime.cjs`（推荐） | 5 s 轮询：发现崩溃立刻拉起并**自动预热**；同时看网关 `heal` 状态 |
| `supervise.ps1`（旧） | 15 s 轮询，只保进程、不预热 |
| 计划任务 `trae-runtime-super`（旧） | 跑的就是 `supervise.ps1` |

**两种同时跑 = 互相拉起 = 2 个 aiserver + 2 个 agent**，症状是 `connected` 在 true/false 之间反复跳。
升级时务必先停旧的：

```powershell
Get-ScheduledTask -TaskName 'trae-runtime-super' | Select-Object TaskName,State
Disable-ScheduledTask -TaskName 'trae-runtime-super' -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process | ? { $_.CommandLine -match 'watch-runtime|supervise\.ps1' } | select ProcessId,CommandLine
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | ? { $_.CommandLine -match 'aiServerMainV2' } | select ProcessId
```

---

## 4. 配置速查（`data/config.json`，改完需要**重启网关**才生效）

> 只有面板「设置」页保存的那 8 项是即时生效的（`native_ban`、`tool_schema_depth`、`tool_block_budget`、
> `default_model`、`agent_type`+`default_agent_type`、`image_passthrough`、`workspace_folder`、`panel_password`+`api_key`）。
> 完整键表见 [CONFIG.md](CONFIG.md)。

| 键 | 默认 | 作用 |
|---|---|---|
| `api_key` / `panel_password` | 首次随机 | 面板与 `/v1` 鉴权 |
| `model_aliases` | `{}` | 把自定义模型名映射到真实 slug，例 `{"seed-2.1-turbo":"Doubao-Seed-2.0-Code"}` |
| `model_strict` | `true` | 未知模型名**拒绝**（避免上游静默用默认模型顶替）；`false` 则放行 |
| `tool_block_budget` | `24000` | 工具定义注入的字符预算；超了降级为「签名/仅名字」 |
| `tool_schema_depth` | `3` | 参数 schema 展开深度 |
| `native_ban` | `true` | 客户端带 tools 时，禁止模型自己用上游原生工具（Read/Grep/**WebSearch**…） |
| `creds_auto_renew_hours` | `24` | 凭据自动续期间隔；`0` 关闭 |
| `runtime_heal` | `true` | 运行时挂死自动自愈总开关 |
| `runtime_heal_threshold` | `2` | 失败**权重和**达此值触发；真实对话超时权重 2（单次即可）、后台探测权重 1 |
| `runtime_probe_sec` | `15` | 空闲期存活探测间隔（`model_list` 心跳） |
| `runtime_probe_timeout_ms` | `10000` | 探测超时；超时即记一次失败 |
| `runtime_probe_grace_sec` | `120` | 启动/重启后的宽限时间，期间不计失败 |
| `runtime_heal_cooldown_sec` | `120` | 两次自愈的最小间隔 |
| `runtime_heal_window_sec` | `300` | 失败计数窗口 |
| `runtime_warmup_after_restart` | `true` | 重启后自动预热（目录 + 极小 chat） |
| `runtime_restart_wait_sec` | `90` | 重启后等待可重连的最长时间 |
| **`idle_timeout_ms`** | `600000`（生产 240000） | **空闲看门狗**：连续这么久无任何上游事件才断开，有事件在流的长请求不受影响 |
| **`stream_keepalive_ms`** | `20000`（生产 15000） | 流式静默时发 `delta:{}` 空帧；**只有真正的 chunk 才能重置客户端空闲看门狗，SSE 注释不算** |
| **`reasoning_abort_chars`** | `0`（关闭） | 思考超阈值且无正文 → 掐断 + 纠偏重试一次 |
| **`warmup_chat`** | `true` | 启动后跑一次极小 chat 预热（`TRAE2API_WARMUP=0` 关闭；启动后已有真实请求会自动跳过） |
| **`context_window_override`** | `{}` | 按模型覆盖上下文窗口（上游一律标 116000，实测 1,048,576） |
| **`prompt_max_tokens_override`** | `{}` | 按模型覆盖输入预算（上游一律 100000） |
| **`max_tokens_override`** | `{}` | 按模型覆盖输出上限（上游一律 16000）；**同时决定截断判定** |
| **`max_tokens_note`** | `{}` | 按模型附加备注，随 `/v1/models` 下发 |
| `model_max_tokens` | `16000` | 兜底输出上限（目录里查不到该模型时用它） |
| `workspace_folder` | 空（自动建） | 上游项目锚点；**必须是存在的目录**，否则 `create_chat_session` 报 992501 |
| `image_passthrough` | `true` | 图片透传（落盘 + 告知路径） |
| `workspace_check` | `"error"` | 客户端声明的工作目录不存在时直接 400（`warn` 只告警、`off` 关闭） |
| `workspace_check_writable` | `false` | 还要求该目录可写 |
| `workspace_notice` | `true` | 提示词里声明「上游锚点不是工作目录，以调用方声明为准」（见 README 4.0.47/4.0.54） |
| `workspace_notice_tail` | `true` | 末尾软性提醒「记得用正确的工作区目录」 |
| `workspace_declare_scope` | `"all"` | 声明识别范围（`all`=system+user；`system`=只认 system） |
| `agent_type` / `default_agent_type` | `chat`（示例配置填 `builder`） | 上游 agent 类型 |
| `instruction_style` | `"aligned"` | 工具说明措辞；`legacy` 不含【通道事实】段 |
| **`undeclared_tool_mode`** | `"feedback"` | 模型调了未声明的工具名：回灌给上游让它改（默认）/ `strip` 丢弃 / `passthrough` 旧行为 |
| **`undeclared_tool_retries`** | `1` | 回灌次数上限 |
| **`tool_aliases`** | `{}` | 模型自造名 → 已声明名 |
| **`rate_limit_per_min`** | `0` | 每 key 每小时……每分钟上限（0=不限）；生产建议 240 |
| **`max_concurrent`** | `0` | 全局在飞上限（0=不限）；账号池实际并发约 3.3，生产建议 8 |
| `reasoning_context` | `"all"` | 历史思考回填：`off` / `last` / `all`（见 README 4.0.51） |
| `reasoning_context_max_chars` | `0` | 单轮思考截断上限（0=不限） |
| `reasoning_context_total_max_chars` | `0` | 思考总量上限（0=不限，超限时优先保留最近几轮） |

环境变量：`TRAE2API_AHA_DIR`（socket 目录）、`TRAE2API_AHA_ADDON`（zmq addon 路径，自包含部署可显式指定）、
`TRAE2API_AHA_PREFIX`（server-name 前缀）、`TRAE2API_AGENT_PREF`（优先 agent 通道）、`TRAE2API_BUNDLE`（运行时 bundle）、
`TRAE2API_BROWSER_DIR`（内核目录）、`TRAE2API_IDLE_TIMEOUT_MS`（覆盖 `idle_timeout_ms`，默认 600000）、
`TRAE2API_REQUEST_TIMEOUT_MS`（默认 0=不限）、`TRAE2API_WARMUP=0`（关启动预热）、`TRAE2API_AHA_DEBUG=1`、
`TRAE2API_DUMP_SSE=1`（打印每帧 SSE）、`TRAE2API_ALLOW_NO_AUTH=1`（无口令启动，仅本机调试）、
`TRAE2API_ANSWER_COMMANDS`（替 IDE 应答 aiserver 命令，默认关）、`TRAE2API_IMAGE_MAX_MB`（默认 20）。

---

## 5. 故障判定表（看到现象先查这里）

| 现象 | 首查 | 常见原因 / 处置 |
|---|---|---|
| 面板「IPC 断开 / 套接字 —」 | `GET /healthz` 的 `checks.runtime` | 运行时没起 → `start-runtime.ps1`；有旧 supervise 与 watcher 并存 → 停一个；死 socket → 重启运行时 |
| 一切看着正常但请求全空 | `GET /healthz` 的 `checks.workspace` / `checks.creds` | 这两项会直接给结论（目录不存在/不可写、凭据失效），比翻日志快 |
| `connected:false` 但进程都在 | `data/trae2api.log` 里 `[aha]`、`.sock.ready` 的 pid 是否存活 | 死 socket（agent 已退出但文件还在）→ 重启运行时；**双实例** → 只留一个 |
| 请求返回「上游返回空结果」 | 报错里的**输入 tokens 数**与日志 `[empty] … 上游状态=` | 输入远小于上下文上限 → 不是超限，看 IPC/白名单/重试 |
| `model not found: X` | `GET /v1/models` 的真实 slug | 用错名字（例如拿 display_name 当 id）；加 `model_aliases` |
| 面板「token-cache.json 缺失」+ `hasCreds:false` | 登录是否真的完成；`data/` 是否可写 | 登录没写缓存（旧版）→ 更新；ACL 只授了 Administrators → 新版会自愈 |
| 报「找不到 zmq addon」 | `node -e "console.log(require('./lib/aha.cjs').findAddon())"` | 自包含部署但没识别到 `<dest>/aiserver/prebuild/**/addon.node` → 更新；或设 `TRAE2API_AHA_ADDON` |
| `create_chat_session failed: Project folder does not exist (992501)` | `workspace_folder` 指向的目录 | 建目录；或改 `workspace_folder` |
| 重启后一直 `connected:false` | 日志 `[runtime] 网关已重连 …` / `⚠ 未能重连` | 看护没在跑 / 还在冷启；90 s 后仍失败看 aiserver 日志 |
| 模型答非所问、疑似换模型 | `[model]` 日志（别名/显示名映射）、`/v1/models` | 未知模型被上游用默认模型顶替（旧版）→ 更新（`model_strict`） |
| **客户端报 `pi-ai stream idle timeout after …ms`** | 该 provider 的 `streamIdleTimeoutMs`、`stream_keepalive_ms` | 客户端只认真 chunk，SSE 注释不算 → 靠 `stream_keepalive_ms`（默认 20 s）发空帧；或调大客户端阈值 |
| **界面长时间无字（像卡死）** | `[watchdog] 连续 …ms 无上游事件`；journal 的 `status` 与 `reasoningChars` | ① 零事件 = 上游流式失效，`idle_timeout_ms` 会兜底断开；② 一直有 reasoning 增量 = 正常长思考（实测 Pro 单轮 25.7 分钟、134,997 tokens） |
| **正文断在半句，`finish_reason:"length"`** | `completion_tokens` 是否恰好等于 `max_tokens` | 打满该模型在本通道的输出上限（Flash/qwen/glm/kimi/minimax 都是 16,000）；客户端按 `length` 续写 |
| **只出思考、正文 0 字（`status=empty_content`）** | journal `reasoningTokens` 是否 ≈ `completionTokens` | 思考与正文共享同一份输出预算被烧光 → 换模型 / 开 `reasoning_abort_chars` / 提示词要求先给结论 |
| **`/v1/models` 里上下文又是 116000** | 配置里四张 override 表是否存在 | 没配覆盖表，网关只能报上游声明值 → 按 [CONFIG.md](CONFIG.md) 第 1.4 节补齐 |

---

## 6. 验收标准（硬指标，别信「看起来成功」）

| 指标 | 期望 | 不满足说明 |
|---|---|---|
| `check-version.cjs` | 全部 ✓，退出码 0 | 部署落后，按缺失项更新文件 |
| `fetch-browser.cjs --status` | 打印 `自检: Google Chrome for Testing <版本>` | 内核没装好/缺系统库 |
| `<运行时根>\aha\aha\*.sock` | ≥1 个 `vscode_ai_agent_*.sock`（同名 `.ready` 里 pid 存活） | 运行时没起或 agent 已死 |
| `http://127.0.0.1:18790/healthz` | `"connected":true` **且 `checks.ok:true`** | 网关没接上运行时；`checks` 会指出是通道、工作区还是凭据的问题 |
| `/api/status` | `models` 非空、`creds.hasCreds:true`、`heal` 字段存在 | 目录/凭据/自愈未就绪 |
| 真实对话一次 | 有正文返回，耗时秒级 | 链路或模型配置问题 |
| `data/trae2api.log` | `[probe] 运行时存活探测已启动`、`[warm] … 预热完成`、`[aha] 握持成功` | 新代码没生效 |

---

## 7. 给 AI 的红线

1. **不要有两个监护人**：`watch-runtime.cjs` 与 `supervise.ps1` / 计划任务 `trae-runtime-super` 只能留一个；
2. **不要起第二个 aiserver**：`start-runtime.ps1` 会检测并告警，手工起前先查进程；
3. **不要用 `run-aiserver.cmd` 长期跑**：面板登录后网关会杀掉 aiserver 让它重启，没有看护就再也起不来；
4. **不要改 `deploy.json` 的 `root`**：它决定网关去哪个 `aha` 目录找 socket；
5. **不要删/覆盖 `data/`**：里面有 `config.json`、`token-cache.json`、`client-secret.txt`、请求日志；
6. **不要替用户登录**：面板「凭据」页要人扫码/收短信；
7. **不要为了「禁联网」去改 `native_ban`**：那是反方向（放开 CALL 协议）；想禁联网应给请求带 `tools`；
8. Linux 上以 root/容器运行时才需要 `--no-sandbox`（`TRAE_LOGIN_NO_SANDBOX=1`），普通用户不要开。

---

## 8. Linux 额外一步

自带内核仍需系统库，缺库时 `fetch-browser.cjs` 会把缺的 `.so` 与命令打出来：

```bash
sudo apt-get install -y libnss3 libnspr4 libasound2t64 libatk1.0-0t64 libatk-bridge2.0-0t64 \
  libatspi2.0-0t64 libcups2t64 libdrm2 libgbm1 libxkbcommon0 libxcomposite1 libxdamage1 \
  libxfixes3 libxrandr2 libpango-1.0-0 libcairo2
```

装完 `fetch-browser.cjs --status` 复查，`ldd` 无 `not found` 即可。Linux 的服务化脚本在 `feat/linux` 分支
（`deploy/linux/install-systemd.sh`，默认拉内核，`--no-browser` 跳过）。

---

## 9. 本版变更（给 AI 的上下文）

- 运行时自愈：`lib/healer.cjs`（失败带权重）+ 空闲探测 + `POST /api/heal`；
- 常驻 5 s 看护 `watch-runtime.cjs`（崩溃即拉起 + 自动预热）、独立预热 `warm-runtime.cjs`；
- 重启后**反复重连**（不要求 socket 名字变化）再预热；
- 模型名校验：别名 + display_name 匹配 + 未知模型 404（防上游静默替换）；
- 凭据 ACL：SYSTEM/Administrators/**当前用户**，收紧后回读自检，老坏文件读时自愈；
- `findAddon` 支持自包含运行时（`<dest>/aiserver/prebuild/**/addon.node`）与 `TRAE2API_AHA_ADDON`。

近期（4.0.60–4.0.70）与本文件相关的变化：

| 版本 | 变化 | 对你的影响 |
|---|---|---|
| 4.0.60 | 工具调用早公告（检测到 CALL 就先发 name-only `tool_calls`） | 工具调用的首帧延迟从 12.9 s 降到 0.2 s |
| 4.0.62 | 静默期发 `delta:{}` 空帧（`stream_keepalive_ms`） | 修客户端 `pi-ai stream idle timeout` |
| 4.0.63 | 空闲看门狗阈值可配（`idle_timeout_ms`），生产 240 s | 零事件的死等从 10 分钟缩到 4 分钟 |
| 4.0.64/4.0.66 | 打满模型上限标 `finish_reason=length`；判定改为**精确等于**上限 | 客户端能识别截断并续写，且不会把 Pro 的 16k~43k 误标 |
| 4.0.65 | `reasoning_abort_chars` 关闭（回 0） | 思考不再被网关主动掐断 |
| 4.0.67 | 上下文标注按官方输入上限（1M / 256K / 200K） | 客户端「获取可用模型」拿到真实窗口 |
| 4.0.68 | DeepSeek-V4-Pro 输出标注 128K + 备注（官方 384K） | 客户端按 128K 设 maxTokens |
| 4.0.69 | `/v1/models` 补兼容别名；面板显示容量 | Cline/Roo/LiteLLM 也能读到真实容量 |
| 4.0.70 | 面板模型表排版修复 | 表格不再溢出卡片 |
| 4.0.72 | `/healthz` 增加 `checks` 三项自检；断链时在飞 RPC 立即失败；`check-version` 补到 54 项 | 排障先看 `checks`，不用再猜；运行时崩了不会再有「卡住等超时」 |
| 4.0.73 | 未声明的工具调用回灌给上游让它自己改（`undeclared_tool_mode: feedback`） | 客户端不会再收到自己没声明的工具；模型偶尔写错名字能自愈 |
| 4.0.74 | 面板状态标签补全、错误汇总覆盖所有失败、客户端断开即中止上游、全局异常兜底、日志轮转、会话清理、`/v1` 限流 | 排障不再有盲区；客户端走了不再白烧 token；进程不会被漏 catch 带走 |
| 4.0.75 | 静默 catch 棘轮闸门；会话 Cookie 在 HTTPS 下加 `Secure`；自检补到 73 项；Linux 支持明确在 `feat/linux` | 新代码不再悄悄吞异常；反代 HTTPS 时 Cookie 更安全 |
| 4.0.76 | 清掉 5 处死代码（含整个 `lib/aiserver-client.cjs`）；流式异常路径补 `[DONE]`；`LOGIN_FAILS` 定期清理；新增死代码守卫测试 | 少一类「以为在跑其实没接线」的坑；流中断不再被客户端当成传输故障 |
