# 配置参考（`data/config.json` / 环境变量 / 面板设置）

> 本文是**唯一权威**的配置清单：每一行都对应代码里真实读取的位置，写完用脚本逐条校对过（见文末「校对方式」）。
> 对应版本：README 4.0.70（2026-11-25）。
>
> **生效方式**
> - 改 `data/config.json` → **重启网关**才生效（启动时 `loadConfig()` 读一次）。
> - 面板「设置」页保存 → 下列键**即时生效、自动写回 config.json**：
>   `native_ban`、`tool_schema_depth`、`tool_block_budget`、`default_model`、`agent_type`（同时写 `default_agent_type`）、
>   `image_passthrough`、`workspace_folder`、`panel_password`（同时写 `api_key`）。
> - 环境变量 → 进程级，优先级高于同名配置（见第 2 节）。

---

## 1. 配置文件键

### 1.1 鉴权（必填，缺了网关拒绝启动）

| 键 | 默认 | 说明 |
|---|---|---|
| `panel_password` | 首次随机 16 位 | 面板登录口令，**同时是 `/v1/*` 的 Bearer key**。为空或仍是 `CHANGE_ME` 占位值时网关退出码 2 |
| `api_key` | 同 `panel_password` | 单独指定 `/v1/*` 的 key；留空则等于口令 |

### 1.2 工作区（上游项目锚点）

| 键 | 默认 | 说明 |
|---|---|---|
| `workspace_folder` | 空（首次自动建 `~/trae2api-workspace`） | 写进 Trae 请求的**锚点目录**。它只用于让上游 `create_chat_session` 有合法项目，**不是**模型读写文件的工作目录 |
| `workspace_check` | `error`（代码默认；示例配置与生产用 `warn`） | 客户端在提示里声明的工作目录不存在时的行为：`error`=400 拒绝；`warn`=放行 + 响应头 + 日志；`off`=不校验 |
| `workspace_check_writable` | `false` | `true` 时还要求该目录可写 |
| `workspace_declare_scope` | `all` | 从哪里识别「调用方声明的工作目录」：`all`=system+user 消息；`system`=只认 system |
| `workspace_notice` | `true` | 在提示词里加【工作区归属】段，声明「网关锚点无效、以调用方声明为准」 |
| `workspace_notice_tail` | `true` | 在提示词末尾加【工作区提醒】段 |

### 1.3 模型与工具桥（提示词层 CALL 协议）

| 键 | 默认 | 说明 |
|---|---|---|
| `default_model` | 空 | 请求没带 `model` 时用哪个；空则取上游目录第一个 |
| `model_aliases` | `{}` | 自定义名 → 真实 slug，例 `{"seed-2.1-turbo":"Doubao-Seed-2.0-Code"}` |
| `model_strict` | `true` | 未知模型名直接 404（防止上游静默用默认模型顶替）；`false` 放行 |
| `native_ban` | `true` | 禁用上游原生工具（Read/Grep/WebSearch…），只允许走提示词层 `CALL` 协议 |
| `tool_schema_depth` | `3` | 工具参数 schema 展开深度（full → signature → names-only 降级链） |
| `tool_block_budget` | `24000` | 工具说明注入的字符预算；超预算自动降级 |
| `instruction_style` | `aligned` | 工具说明措辞：`aligned`（默认）/ `legacy`（老措辞，**不含【通道事实】段**） |
| `undeclared_tool_mode` | `feedback` | 模型写了**未声明**的工具名时怎么办：`feedback`=回灌给上游让它自己改（默认）／`strip`=丢弃该 CALL 按正文返回／`passthrough`=旧行为（原样转发，客户端会收到没声明的工具） |
| `undeclared_tool_retries` | `1` | `feedback` 模式下最多回灌几次（`0` 等同 `strip`） |
| `tool_aliases` | `{}` | 模型自造名 → 已声明名，例 `{"写文件":"write_file"}`；匹配顺序：完全相等 → 忽略大小写/下划线 → 别名 |
| `agent_type` | `chat`（示例配置填 `builder`） | 上游 agent 类型；`builder` 思考更短、重任务更快 |
| `default_agent_type` | 同 `agent_type` | 优先级更高：`default_agent_type` → `agent_type` → `chat` |

### 1.4 上下文 / 输出容量标注（`/v1/models` 与面板显示的值）

> 上游 `model_list` 对所有模型一律声明 `context_window=116000`、`prompt_max_tokens=100000`、`max_tokens=16000`，
> 三个数都不可信（实测上下文 1,048,576；DeepSeek-V4-Pro 单轮输出已到 134,997）。这四张表就是用来改成真实值的。

| 键 | 默认 | 说明 |
|---|---|---|
| `context_window_override` | `{}` | 按模型覆盖**上下文窗口**（同时作为 `context_length`、`max_input_tokens`、`limit.context` 下发） |
| `prompt_max_tokens_override` | `{}` | 按模型覆盖**输入预算**（`prompt_max_tokens`） |
| `max_tokens_override` | `{}` | 按模型覆盖**输出上限**（`max_tokens`、`max_output_tokens`、`limit.output`）；**同时是截断判定的上限值** |
| `max_tokens_note` | `{}` | 按模型附一句备注，随模型列表下发为 `max_tokens_note`（客户端可展示） |
| `model_max_tokens` | `16000` | 兜底值：某模型既不在 `max_tokens_override` 也不在上游目录里时用它判定截断 |

当前生产取值（依据官方文档 / 实测）：

| 模型 | 上下文 | 输出 | 依据 |
|---|---|---|---|
| DeepSeek-V4-Pro | 1,048,576 | 131,072 | 官方 CONTEXT LENGTH 1M / MAX OUTPUT 384K；实测单轮 134,997，故按已验证 128K 标注并加备注 |
| DeepSeek-V4-Flash | 1,048,576 | 16,000 | 官方 1M；本通道实测精确卡 16,000 |
| qwen-3.6-plus | 1,048,576 | 16,000 | 阿里云百炼 1M；本通道实测精确卡 16,000 |
| Doubao-Seed-Code / 2.0-Code | 262,144 | 16,000 | 火山方舟 256K（实测 258,861 tokens 通过） |
| glm-5 / glm-5.1 / glm-5v-turbo | 204,800 | 16,000 | 智谱 GLM-5 系列 200K |
| kimi-k2.6 | 256,144 | 16,000 | Moonshot Kimi K2.6 |
| minimax-m2.5 / m2.7 | 204,800 | 16,000 | MiniMax M2.x 204,800 |

### 1.5 流式 / 超时（长输出与「卡死」相关，重点看这里）

| 键 | 默认 | 说明 |
|---|---|---|
| `idle_timeout_ms` | `600000`（生产 `240000`） | **空闲看门狗**：连续这么久**没有任何上游事件**才断开（基于「连续无事件」，不是总时长，所以在流的长请求不会被它掐）。触发后返回 `upstream_timeout`。环境变量 `TRAE2API_IDLE_TIMEOUT_MS` 优先 |
| `stream_keepalive_ms` | `20000`（生产 `15000`） | **空帧保活**：流式静默超过该值就发一个 `delta: {}` 空 chunk（合法块，不污染内容）。用于重置客户端空闲看门狗——客户端只认真正的 chunk，**SSE 注释 `: ping` 不算** |
| `reasoning_abort_chars` | `0`（关闭） | 思考预算看门狗：思考字符超过该值且尚无正文 → 掐断并用纠偏提示重试一次。`0`=关闭；客户端 `max_tokens` 会把它压到 `min(配置值, max(4000, max_tokens×2))` |
| `reasoning_context` | `all` | 历史思考回填：`off` / `last` / `all` |
| `reasoning_context_max_chars` | `0` | 单轮思考回填截断上限（0=不限） |
| `reasoning_context_total_max_chars` | `0` | 思考回填总量上限（0=不限） |
| `warmup_chat` | `true` | 启动后跑一次极小 chat 预热链路；`false` 或 `TRAE2API_WARMUP=0` 关闭。启动后已有真实请求时自动跳过 |

### 1.6 图片

| 键 | 默认 | 说明 |
|---|---|---|
| `image_passthrough` | `true` | 图片落盘并把路径告知模型（远程 URL 拒内网地址） |

### 1.7 凭据

| 键 | 默认 | 说明 |
|---|---|---|
| `creds_auto_renew_hours` | `24` | 自动续期间隔；`0` 关闭 |

### 1.8 运行时自愈（healer）

| 键 | 默认 | 说明 |
|---|---|---|
| `runtime_heal` | `true` | 运行时挂死自动自愈总开关 |
| `runtime_heal_threshold` | `2` | 失败**权重和**达此值触发；真实对话超时权重 2、后台探测权重 1 |
| `runtime_heal_window_sec` | `300` | 失败计数窗口 |
| `runtime_heal_cooldown_sec` | `120` | 两次自愈最小间隔（下限 30 s） |
| `runtime_probe_sec` | `15` | 空闲期存活探测间隔（下限 5 s） |
| `runtime_probe_timeout_ms` | `10000` | 探测超时（下限 3000 ms） |
| `runtime_probe_grace_sec` | `120` | 启动/重启后多少秒内不算失败（宽限） |
| `runtime_restart_wait_sec` | `90` | 重启后等待重连的最长时间 |
| `runtime_warmup_after_restart` | `true` | 重启后自动预热（目录 + 极小 chat） |

### 1.9 网关自动维护（别手改）

`local_project_id`、`local_project_id_tag`、`icube_language`、`version_code`、`plugin_channel`、`device_id` ——
这些由网关按上游握手结果写入；手改可能让 `create_chat_session` 失败。

### 1.10 兼容/遗留键

| 键 | 说明 |
|---|---|
| `pwd` | 仅 `deploy/watch-runtime.cjs` 读它（`api_key` 的旧别名），正常无需设置 |

> `deploy.json` 里的 `root` / `port` / `taskName` **不是** config.json 的键，是 `start-runtime.ps1` / `restart.ps1` / `start-trae2api.ps1` 的参数来源。

---

## 2. 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `TRAE2API_ROOT` | 网关目录 | `start-runtime.ps1` / `start-trae2api.ps1` 的根目录 |
| `TRAE2API_AHA_DIR` | 自动探测 | aha IPC 目录（含 `*.sock` 的目录） |
| `TRAE2API_AHA_DIR_RAW` | — | 不做归一化的原始 aha 目录（`lib/creds.cjs`） |
| `TRAE2API_AHA_ADDON` | 自动探测 | zmq addon 路径（自包含部署可显式指定） |
| `TRAE2API_AHA_PREFIX` | `trae-standalone-` | aha server-name 前缀 |
| `TRAE2API_AHA_DEBUG` | 关 | `1` 打印 AHA 收发细节 |
| `TRAE2API_ANSWER_COMMANDS` | 关 | 由网关替 IDE 应答 aiserver 的 `execute_command`：`poll` / `all` / `1`（默认不答，见 README 4.0.5x） |
| `TRAE2API_IDLE_TIMEOUT_MS` | `600000` | 空闲看门狗阈值，优先于 `idle_timeout_ms` |
| `TRAE2API_REQUEST_TIMEOUT_MS` | `0` | 请求绝对时长上限（0=不限） |
| `TRAE2API_WARMUP` | — | `0` = 关启动预热 |
| `TRAE2API_ALLOW_NO_AUTH` | — | `1` = 无口令也启动（仅本机调试，持续告警） |
| `TRAE2API_DUMP_SSE` | — | `1` = 打印每帧 SSE（排障用，会很大） |
| `TRAE2API_AGENT_PREF` | — | 指定优先使用哪个 agent 通道（扩展通道/独立通道） |
| `TRAE2API_BUNDLE` | — | 指定 VSIX 解包出来的运行时 bundle 路径 |
| `TRAE2API_BROWSER_DIR` | 运行时内 | 登录浏览器内核目录 |
| `TRAE2API_BROWSER_VERSION` | 固定版本 | `deploy/fetch-browser.cjs` 下载的 chrome-headless-shell 版本 |
| `TRAE2API_IMAGE_MAX_MB` | `20` | 单张图片上限（MB） |

---

## 3. 面板设置页能改什么

设置页只暴露**常用**子集（保存即时生效）：`agent_type`、`native_ban`、`tool_schema_depth`、
`tool_block_budget`、`default_model`、`image_passthrough`、`workspace_folder`、`panel_password`。

其余键（容量覆盖、超时、自愈、工作区校验策略…）请直接编辑 `data/config.json` 后重启网关。

---

## 4. 校对方式（可复现）

```bash
# 1) 文档里提到的每个 config 键，代码里真的在读
node -e "const fs=require('fs');const s=fs.readFileSync('server.cjs','utf8')+fs.readdirSync('lib').map(f=>fs.readFileSync('lib/'+f,'utf8')).join('');const doc=fs.readFileSync('docs/CONFIG.md','utf8');const keys=[...doc.matchAll(/`([a-z_][a-z0-9_]{3,})`/g)].map(m=>m[1]);const miss=[...new Set(keys)].filter(k=>!/cfg/i.test(k)&&!s.includes(k)&&!doc.includes('doc'));console.log('代码里找不到的键:',miss)"

# 2) 面板显示值与接口一致
curl -s -H "Authorization: Bearer <api_key>" http://127.0.0.1:18790/v1/models | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{for(const m of JSON.parse(s).data)console.log(m.id, m.context_window, m.max_tokens, m.max_tokens_note||'')})"
curl -s -H "Authorization: Bearer <api_key>" http://127.0.0.1:18790/api/status | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{for(const m of JSON.parse(s).models)console.log(m.name, m.context_window, m.max_tokens)})"
```

两处输出必须逐行一致——它们共用 `modelCapacity()`（`server.cjs`）。

## 限流

| 键 | 默认 | 说明 |
|---|---|---|
| `rate_limit_per_min` | `0` | 每个 key（Bearer token，无 token 时用客户端 IP）每分钟最多多少次 `/v1/chat/completions`；`0` = 不限 |
| `max_concurrent` | `0` | 全局同时在飞上限；`0` = 不限。实测上游账号池并行约 **3.3**，设 6~10 比较合适 |

超限返回 `429` + `Retry-After`（秒），并记一条 `status=error / error=ratelimit:rate|concurrency` 的审计；
两档都默认关闭，行为与以前完全一致。
