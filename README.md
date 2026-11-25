# traeplugin2api

把 Trae / MarsCode 的桌面 Agent 通道（aiserver + ai-agent）反向代理成 **OpenAI 兼容接口** 的网关：
`/v1/models`、`/v1/chat/completions`（含 SSE 流式与工具调用），自带一个中文管理面板。

> **命名说明**：仓库名是 `traeplugin2api`；代码里的内部标识**仍是 `trae2api`**
> （环境变量前缀 `TRAE2API_*`、计划任务默认名 `trae2api`、日志前缀、目录示例），
> 这样从旧版本升级过来的机器不用改动任何已部署的东西。
> 想统一改名：`deploy\setup.ps1 -TaskName traeplugin2api`，或直接改 `deploy.json` 的 `taskName`。

- 不需要在本机安装 VS Code 或 code-server —— 运行时从**你自己下载的 VSIX** 里解包出来，完全自包含。
- 凭据（JWT / refresh token）由网关注入并 **每 24 小时自动续期**，登录支持扫码与手机号验证码。
- 目录、端口、运行时根目录全部自适应，整个文件夹放到任意位置都能跑。

---

## 0. 运行环境

| 项 | 要求 | 说明 |
|---|---|---|
| 系统 | Windows 10 / 11 / Server 2019+ | 运行时是 `ai-agent.exe`，并用 Windows 计划任务保活 |
| Node.js | **≥ 20**（实测 v24） | 用到 `fetch` / `AbortSignal.timeout` |
| PowerShell | **PowerShell 7（`pwsh`）** | 脚本与计划任务都用 `pwsh`。Windows 自带的 5.1 按 ANSI 读 UTF-8，中文脚本会乱码 |
| 浏览器 | Edge 或 Chrome | 面板内登录要用无头浏览器打开真实登录页 |

装 PowerShell 7：`winget install --id Microsoft.PowerShell -e`

---

## 1. 目录结构

```
traeplugin2api/
├─ server.cjs                 # 网关主程序（HTTP、/v1/*、面板与面板 API）
├─ start-trae2api.ps1         # 保活启动脚本（自举运行时 → 拉起网关；-ResolveOnly 可自查路径）
├─ start-runtime.ps1          # 只起运行时并等到 connected:true（-Restart 先停再起）
├─ restart.ps1                # 优雅重启（端口与任务名读 deploy.json）
├─ config.example.json        # 配置模板（带注释，网关支持 JSONC；不建也会自动生成）
├─ lib/
│  ├─ aha.cjs                 # aha IPC（ZeroMQ）客户端：连 aiserver/ai-agent，含握手与 45s 心跳看护

│  ├─ trae.cjs                # 业务流：建会话 → 发消息 → 收流 → 工具调用（含 loadConfig/JSONC 容错）
│  ├─ creds.cjs               # 凭据：读 VS Code SecretStorage / 本地缓存 → 续期 → 写回
│  ├─ trae-login.cjs          # 面板内登录（扫码 / 手机号验证码），成功后写运行时 profile
│  ├─ cdp.cjs                 # 无头浏览器（Chrome DevTools Protocol）控制
│  ├─ healer.cjs              # 运行时自愈（失败权重 / 窗口 / 冷却 / inflight 保护）
│  ├─ models.cjs              # 模型目录缓存与别名解析
│  ├─ tools-bridge.cjs        # OpenAI tools ↔ 提示词 CALL 协议桥（schema 渲染、通道事实段）
│  ├─ call-parse.cjs          # CALL 解析 / JSON 修复 / 截断识别
│  ├─ workspace-check.cjs     # 客户端声明的工作目录校验（error/warn/off）
│  ├─ workspace-declare.cjs   # 从 messages 里识别调用方声明的工作目录
│  ├─ workspace-notice.cjs    # 【工作区归属】/【工作区提醒】两段提示词
│  └─ attachments.cjs         # 图片落盘（data URL 或公网 URL，拒内网地址，默认 20 MB 上限）
├─ public/
│  ├─ index.html              # 管理面板（总览含模型容量列）
│  └─ login.html              # 面板登录页
├─ deploy/
│  ├─ setup.ps1               # 一键部署/迁移（人用入口）
│  ├─ bootstrap-runtime.ps1   # 启动时自举：发现 VSIX → 解包部署 → 接管为生产运行时
│  ├─ install-from-vsix.cjs   # VSIX → 自包含运行时（解 aiserver，再调 VSIX 内置 7za 解二进制包）
│  ├─ watch-runtime.cjs       # 常驻看护（崩溃即拉起 + 预热；含 shouldHeal 判定与宽限期）
│  ├─ warm-runtime.cjs        # 独立预热（不依赖网关）
│  ├─ check-version.cjs       # 部署版本自检（逐项功能特征）
│  └─ lib/unzip.cjs           # 纯 JS 解 zip（stored/deflate 两种压缩方式，无外部依赖）
├─ docs/
│  ├─ CONFIG.md                # 配置权威清单（50 键 + 17 个环境变量 + 校对脚本）
│  ├─ AI-DEPLOY.md             # 给 AI 的部署/排障指令（可整段粘贴）
│  ├─ MODEL-MAPPING.md         # 模型名来源、目录值 vs 官方值对照
│  ├─ REASONING-EFFORT.md      # 思考强度实测（含「思考算在输出预算里」）
│  ├─ REVIEW.md                # 代码审查报告（问题清单与修复记录）
│  └─ trae-web-login-api.json  # 站点登录接口参考
├─ tools/verify-e2e.cjs        # 端到端验收脚本（流式 + 面板鉴权 + 防爆破）
├─ tools/verify-docs.cjs       # 文档校对：文档里提到的键/路由/文件必须真实存在
├─ test-*.cjs                  # 17 个单测文件、314 个用例（清单见第 7 节）
└─ data/                       # 运行期数据（config.json、凭据缓存、日志、请求记录）
```


**仓库内不含 VSIX / 二进制 / 证书**：VSIX 需要使用者自行下载（见第 2 步），运行时由它现场解包。

---

## 2. 准备：自己下载 VSIX

从 Trae / MarsCode 官方渠道获取扩展安装包（形如 `marscode.marscode-extension-<version>.vsix`），
**放到部署目录的 `vsix/` 子目录**（也支持 `extensions/` 或部署目录根下）：

```
<部署目录>/vsix/marscode.marscode-extension-1.7.16.vsix
```

> VSIX 里包含 `resource/aiserver/`（Node 服务）与 `resources/binaries/win32-x64.7z`（约 88 MB，
> 解开后约 600 MB 的 `ai-agent.exe` 等运行时），另自带 `7za.exe`。只要这一个文件，就能在没有 VS Code 的机器上跑起来。

---

## 3. 部署

### 3.1 一键部署（推荐）

```powershell
# 把网关部署到 D:\apps\trae2api，运行时根目录 D:\apps\trae2api-runtime，端口 18791
pwsh -NoProfile -File deploy\setup.ps1 -Dir D:\apps\trae2api -Root D:\apps\trae2api-runtime -Port 18791

# 顺带把已下载的 VSIX 一起放进去并当场解包
pwsh -NoProfile -File deploy\setup.ps1 -Dir D:\apps\trae2api -VsixPath D:\downloads\marscode.vsix

# 只看计划而不动手
pwsh -NoProfile -File deploy\setup.ps1 -Dir D:\apps\trae2api -DryRun
```

`setup.ps1` 依次完成：复制网关 → 写 `deploy.json`（root / port / taskName）→ 建 `<Root>\vsix`、`<Root>\logs` →
放 VSIX → 跑 `bootstrap-runtime.ps1` 解包运行时 → 注册计划任务 → 启动 → 健康检查。

计划任务用 **当前用户 + S4U**（开机与登录双触发）：凭据来自该用户的
`%APPDATA%\Code\User\globalStorage\state.vscdb` 与 `~\.marscode`，**不能用 SYSTEM**（它的 homedir/APPDATA 指向 `systemprofile`，读不到凭据）。

### 3.2 就地运行

```powershell
# 1) 配置：直接启动即可 —— 首次运行会自动生成 data\config.json，
#    面板口令与 api_key 是随机 16 位，打印在启动日志里（想固定就照 config.example.json 复制一份再改）
# 2) 把 VSIX 放进 vsix\ 目录
# 3) 启动（首次会自动解包运行时，约 3–5 分钟）
pwsh -NoProfile -File start-trae2api.ps1
```

### 3.3 目录自适应规则（无需手改）

| 项 | 解析顺序 |
|---|---|
| 网关目录 | 启动脚本所在目录 |
| 运行时根 | `TRAE2API_ROOT` → `deploy.json` 的 `root` → `runtime/` → `runtime-root/` → `.runtime/` → 默认 `runtime/`（自动创建） |
| VSIX 搜索 | `vsix/` → `extensions/` → 部署目录根 → `<root>\vsix` → `<root>\extensions` → `<root>`（取最新一份） |
| 端口 / 主机 | `PORT` / `HOST` 环境变量 → `deploy.json` 的 `port` → 默认 `0.0.0.0:18790` |

> 端口与主机**不写在 `config.json` 里**（那是网关业务配置），它们属于 `deploy.json` 或环境变量。

自查命令：

```powershell
pwsh -NoProfile -File start-trae2api.ps1 -ResolveOnly
# 输出：网关目录 / 运行时根（含来源）/ 端口 / aha 目录 / 找到的 VSIX
```

---

## 4. 登录与续期

> 让 AI 帮你部署/装内核：见 [docs/AI-DEPLOY.md](docs/AI-DEPLOY.md)（可直接粘贴给 AI 的指令、验收硬指标、红线清单）。

### 4.0.44 模型名怎么填（slug 与显示名不一致）

上游目录里**slug 与 display_name 常常不同**，例如：

| slug（API 名） | display_name（界面名） |
|---|---|
| `Doubao-Seed-2.0-Code` | `Seed-2.1-Turbo` |
| `Doubao-Seed-Code` | `Seed-Code`（默认模型） |
| `qwen-3.6-plus` | `Qwen3.6-Plus` |

**两个名字都能用**：网关先查 `model_aliases`，再匹配 slug，再匹配 display_name（忽略大小写与 `-_ .` 空格），
命中后统一按 slug 发给上游，日志打 `[model] 显示名 "Seed-2.1-Turbo" → Doubao-Seed-2.0-Code`。
都不匹配才返回 404 并列出近似模型（不会静默用默认模型顶替）。

想把自定义叫法固定映射，就写 `data/config.json` 的 `model_aliases`。

### 4.0.45 模型身份能验证到什么程度（实测结论）

以 `Doubao-Seed-2.0-Code`（显示名 `Seed-2.1-Turbo`）为例，2026-11-22 在真机上做了三类探测，
结论是：**能确认路由到哪个 slug，不能确认 slug 背后是哪一代权重。**

| 方法 | 结果 | 可用性 |
|---|---|---|
| 目录元数据 | 51 个字段里**没有任何版本/日期字段**（无 `version`/`released_at`/`checkpoint`）；只有 `is_beta`、`tags`、`max_tokens:16000`、`reasoning_effort_config` 之类配置差异 | 只能证明"两个 slug 是不同条目" |
| usage 原始字段 | 上游 `token_usage` 里有 `max_tokens:116000`、`prompt_tokens`、`cache_read_input_tokens`、金额等，**无模型版本** | 无版本信息 |
| 确定性输出指纹（temperature=0） | `Doubao-Seed-2.0-Code` 答 `0 1 2`（纯文本）；`Doubao-Seed-Code` 答带代码围栏的 ```0 1 2```；`glm-5` 同前者 | **有效**：可区分是否为同一模型 |
| 自报知识截止 | 2.0-Code：「不包含 2026 上半年」/拒绝编造年月；Seed-Code：「2024-06」或「不确定」；glm-5：「2024-07」 | 弱，且**被上游联网污染** |
| 发布事件探测 | 两个模型都答出「Seed 2.1」系列，且开头写「根据搜索到的公开信息」→ 上游 agent 带联网检索 | **不可用**：回答来自检索而非权重 |

要点：
1. 上游 agent 会联网（回答里引用"搜索到的公开信息"），所以"知识库日期"类问题测的是**检索**，不是模型记忆；
2. 因此 slug 背后的权重世代，从网关侧**无法自证**。要确认只能看官方文档，或等账号目录里出现新的独立 slug；
3. 我们能保证的是：名字 → slug 的映射确定（见 4.0.35），请求哪个 slug 就是哪个路由。

### 4.0.47 模型名从哪来（VSIX 内嵌映射表 vs 服务端目录）

`Seed-2.1-Turbo` 有两种来源，别混：

- **展示名**来自服务端 `model_list` 的 `display_name`（动态，账号绑定）；
- **路由键** `Doubao-Seed-2.1-Turbo` 写死在 VSIX 的 `ai-agent.exe` 内嵌 `manifests/mapping.json` 里，
  按 `design / code / work / trae` 四节给每个模型指定「后端族」（`doutops/seed/default/…`）。

实测：带引号的 `"Seed-2.1-Turbo"` 在二进制里 **0 命中**；`"Doubao-Seed-2.1-Turbo"` 5 命中，全在那张表里。
详见 [docs/MODEL-MAPPING.md](docs/MODEL-MAPPING.md)（含四节对照表与复现方法）。

### 4.0.49 思考强度（reasoning_effort）不生效

- **目录侧**：11 个模型的 `thinking_enable` 与 `reasoning_effort_options` **全为 null**（`Doubao-Seed-Code` 还明确 `support_thinking: false`）；
- **行为侧**（`Doubao-Seed-2.0-Code`，同题多次）：baseline 中位 843 / `none` 1169 / `low` 986 / `high` 1200 —— `none` 没压下去反而更高；复核 919.5 vs 1063（+15.6%）；
- **⚠️ 别用单次数据判断**：同一 baseline 5 次在 414~1453 之间波动（3.5 倍）。

替代：**换模型**（qwen-3.6-plus 约 200 vs Doubao 约 900）、`reasoning_abort_chars` 掐断重试、提示词软控。
详见 [docs/REASONING-EFFORT.md](docs/REASONING-EFFORT.md)。

### 4.0.48 知识截止实测：能排除 2.0-Code，方向上更像 2.1-Turbo

方法：**结果型**探针（问赛果/颁奖结果，不问日期——日期可由旧知识推测），请求带一个无害 `tools`
触发网关「禁用原生工具」禁令，掐掉上游自带检索；每事件问 2 次；答对关键词 = 训练数据覆盖该月份。
（有效性自检：2026 年的事件全部答「不知道」——若检索没被掐掉，这些全网报道级事件不可能答不出。）

**对照基准（用户从火山官网读到的官方口径）**：`Doubao-Seed-2.0-Code` 知识截止 **2023-10**；
`Seed-2.1-Turbo` 知识截止 **2024-07**。

| 探针（事件月份） | 真值 | Trae 的 `Doubao-Seed-2.0-Code`（显示名 Seed-2.1-Turbo） | 默认 `Doubao-Seed-Code` |
|---|---|---|---|
| 超级碗 LVIII（2024-02） | 酋长 | ✅ | ✅ |
| 第 96 届奥斯卡（2024-03） | 奥本海默 | ✅ | ✅ |
| NBA 总决赛（2024-06） | 凯尔特人 | ✅ | ✅ |
| 欧洲杯（2024-07） | 西班牙 | ✅ | ✅ |
| 巴黎奥运男 100 米（2024-08） | Noah Lyles | ✅ | ✅ |
| MLB 世界大赛（2024-10） | 道奇 | ✅ | ✅ |
| ATP 年终总决赛（2024-11） | 辛纳 | ⚠️ 一次德约 / 一次辛纳 | ✅ |
| TGA 年度游戏（2024-12） | Astro Bot | ✅ | ⚠️ 一次黑神话 / 一次 Astro Bot |
| 超级碗 LIX（2025-02） | 老鹰 | ❌ 答酋长（上一届冠军） | ✅ |
| 超级碗 LX / 奥斯卡 98 / WWDC26（2026） | — | ❌ | ❌ |

**判读**：

1. **可以排除 `Doubao-Seed-2.0-Code`（2023-10）**：这条 slug 知道 2024-02 之后一连串结果，
   最晚到 2024-12，比 2023-10 晚了整整 14 个月 —— 这不可能用「边界模糊」解释。
2. **与 `Seed-2.1-Turbo`（2024-07）方向一致**，但实测比它再靠后约 5 个月（知道 2024-10、2024-12），
   而 2025-02 不知道 ⇒ 实际数据约到 **2024 年底 / 2025 年初**。
3. 默认 `Doubao-Seed-Code` 更靠后（知道 2025-02），是这三个里最新的。

**修正说明**：本节早期版本（2026-11-23 初）曾据「它不知道 2025-02」推出「展示名名不副实」，
在拿到官方 cutoff 后**该结论已撤回**：它不只是不知道 2025 的事，而是**知道 2024 全年**，
这与 2.1-Turbo 吻合、与 2.0-Code（2023-10）明显不符。

**别直接问它「你的知识截止是哪天」**：实测同一模型三种问法给出「不知道 / 2024-01 / 2024-04」互斥答案，
带不带 tools 还会变（自述不可用实证见 [docs/MODEL-MAPPING.md](docs/MODEL-MAPPING.md) 第 10 节）。

**边界**：① 厂商标注的 cutoff 常是保守值，实测可超出数月；② 个别探针不稳定（ATP 一错一对），
需重复采样；③ 本方法只能做「版本排除」与「方向判断」，要精确到某一版仍需官方 API 的 A/B 指纹（见 4.0.45）。

### 4.0.46 上游自带搜索与模型标识（实测归属）

**结论：联网检索是上游 Trae agent 自带的 `WebSearch` 干的，不是本网关、也不是客户端的工具。**

证据一（代码）：`lib/tools-bridge.cjs:92-98` 的 `NATIVE_TOOLS` 明确列出
`Read / Write / Edit / Grep / Glob / RunCommand / WebSearch / WebFetch …`，注释写明「实测可用：Read/Grep/WebSearch 都能真读真搜」。

证据二（谁在拦）：网关**只在客户端带了 `tools` 时**才注入「禁止自用原生工具 + 必须走 CALL 协议」的指令；
不带 `tools` 的纯对话请求完全没有这道禁令，上游可以自由联网。

证据三（A/B 实测，同一 prompt、temperature=0、同一网关）：

| 情形 | 耗时 | 回答风格 |
|---|---|---|
| 不带 tools | **26.6 s** | 「根据**检索到**的信息，回答如下：…」（联网了） |
| 带 1 个假工具（禁令生效） | **14.5 s** | 「我能确定和不能确定的信息如下…」（改用自身知识，不再声称检索） |

**顺带拿到更硬的模型标识证据**：问「你的模型标识是什么？只输出那串标识」，
不带 tools / 带 tools 两种情形都答 **`Seed-2.1-Turbo`** —— 说明上游 **system prompt 里注入的标识就是 Seed-2.1-Turbo**，
而路由 slug 仍是 `Doubao-Seed-2.0-Code`。即：**上游口径把它当 2.1-Turbo**（权重世代仍无法从外部验证，见 4.0.36）。

实用影响：
1. **隐私/可预测性**：不带 tools 的请求，你的 prompt 可能被上游拿去检索；
2. 想让纯对话也禁联网，可给请求带任意 `tools`（触发禁令），或改网关加 `native_ban_always`（当前未实现）；
3. 「知识库截止」类测试在这条链路上无效（见 4.0.36）。

### 4.0.38 运行时挂死（握手成功但 model_list 永远超时）与自动自愈

**故障形态（另一个 agent 在真机上定位到的，和代码一致）**：

1. 网关 ↔ agent 的握手、`execute_command` 都正常，只有 `model/model_list` 拿不到结果 → 卡在 aiserver 提供模型目录这一层；
2. aiserver 进程没崩（`ProcessMonitorAhaService` 每分钟打点连续、`[error]` 计数 0）；
3. 真正的断点是 aiserver 自己的 AHA 客户端与 agent 断开后**再没恢复**（日志 `[AhaIPC]` 一条），
   而网关的重连只重建了「网关→agent」，修不了「aiserver→agent」。

**为什么必须重启 aiserver**：这条链路是 aiserver 内部维护的，外部无法重建；看护器（`deploy/watch-runtime.cjs`；旧的 `supervise.ps1` 已从仓库移除）
一杀 aiserver 就会把 aiserver + ai-agent 一起重建，socket 换新，链路恢复。实测历史：`model_list` 超时 → 杀 aiserver
→ 40 秒内新 agent 起来 → 冷启 37.7s、热 2.4s。

**网关侧的自动自愈（本版新增）**：

- 统计 `model_list` / 聊天的 RPC 超时；**成功一次即清零**（避免偶发超时误杀）；
- 10 分钟窗口内累计 **3 次** 且距上次自愈 ≥5 分钟 → 自动重启 aiserver；
- **有请求在跑时暂缓**（`inflightChats > 0` 不杀，避免掐断正在生成的回答）；
- 开关与阈值都在 `data/config.json`：`runtime_heal`（默认 true）、`runtime_heal_threshold`、
  `runtime_heal_window_sec`、`runtime_heal_cooldown_sec`；
- 状态在 `GET /api/status` 的 `heal` 字段；手动触发：`POST /api/heal`（需 api_key）。

日志形态：

```
[heal] 触发运行时重启：model_list 连续失败 3 次（aiserver 会由看护器在 ~15s 内拉起）
[heal] 重启动作已下发
```

手动恢复（不依赖网关逻辑）：

```powershell
pwsh -NoProfile -File start-runtime.ps1 -Root <运行时根> -Restart
```

### 4.0.39 aiserver 能不能一直跑（能常驻，但不能"永不重启"）

**结论**：进程可以常驻（看护器已经在做），但**"永不重启"做不到** —— 因为 aiserver 内部那条到
ai-agent 的 AHA 客户端断链后不会自愈，这是上游 VSIX 里的代码行为，网关侧没有任何协议手段能重建它（见 4.0.38）。

当前是三层保障：

| 层 | 机制 | 覆盖面 |
|---|---|---|
| 1. 进程级 | `deploy/watch-runtime.cjs` 看护：aiserver 退出即拉起（旧 `supervise.ps1` 已从仓库移除；旧机器上若还留着它或计划任务 `trae-runtime-super`，必须停用，否则双看护互相拉起） | 崩溃 / 被杀 |
| 2. 链路级 | `lib/healer.cjs`：10 分钟 3 次超时 → 自动重启 aiserver | 进程活着但链路挂死（本次故障） |
| 3. 手动 | `POST /api/heal`、`start-runtime.ps1 -Restart` | 立刻恢复 |

**本版新增：重启后自动预热**（`runtime_warmup_after_restart`，默认开）

```
[runtime] 已停止 aiserver pid 1234（model_list 连续失败 3 次），等待看护重启
[runtime] 新 socket 就绪 ipc://…vscode_ai_agent_1.7.16_ab12.sock（18400ms）
[runtime] 网关已重连新 socket
[warm] after-restart(model_list 连续失败 3 次) 预热完成：模型目录 11 个 4300ms，聊天 2100ms
```

不预热的话，重启后第一个用户请求要自己承担 agent 侧的首次初始化（实测 37–50 秒）；
预热后中断窗口从 ~40s 降到 **5–10s**，且用户在面板看到的是「短暂失败」而不是「长时间卡死」。

**想更彻底的三条路（按可行性排序）**：

1. ✅ **已做**：重启 + 预热（成本最低，收益最大）；
2. ⚠️ **双实例热备**：两个 aiserver 各接一个 agent，主链路挂时切备。**需要先验证同账号能否并存**
   —— 我们已知「一个网关只接一个运行时」「双跑会互抢并导致 model_list 超时」，大概率不可行；
3. ❌ **改上游 bundle 的 AHA 重连**：治本，但 `aiServerMainV2.js` 是混淆代码，
   且每次升级 VSIX 会被覆盖，风险与维护成本都高。

### 4.0.40 最坏情况要卡多少秒（全部按代码里的真实超时算）

| 场景 | 最坏时长 | 构成 |
|---|---|---|
| **单次对话请求，上游既不吐字也不报错** | **600 s（10 分钟）** | 空闲看门狗 `TRAE2API_IDLE_TIMEOUT_MS` 默认 600000ms；绝对上限默认 0=不限 |
| 单次请求卡在会话创建 | 45 s | `create_chat_session` 超时 45000 |
| 单次请求卡在发送 | 90 s | `send_message` 超时 90000 |
| 单次请求卡在订阅/收流 | 60 s | `subscribe_events` 超时 60000 |
| **链路挂死 → 自动自愈完成** | **≈ 40+40 = 80–140 s** | 探测 2 次 ×（间隔 30 s + 超时 10 s）≈ 80 s ＋ 恢复 41–61 s |
| aiserver 进程崩溃（看护器接管） | **41–61 s** | 看护轮询 ≤15 s ＋ 冷启 20–40 s ＋ 预热 ~6 s |
| 手动 `POST /api/heal` | 41–61 s | 无检测等待 |

恢复侧的 41–61 s 构成：看护器轮询 ≤15 s → aiserver+agent 冷启 20–40 s → 网关等新 socket（0.5 s 粒度）→ 重连 → 预热（model_list ~4 s ＋ 极小 chat ~2 s）。

**为什么需要主动探测（本版新增）**：`model_list` 有 30 分钟目录缓存，缓存命中时根本不发 RPC，
healer 会拿不到失败样本、永远不自愈。所以空闲期每 `runtime_probe_sec`（默认 30 s）用
`runtime_probe_timeout_ms`（默认 10 s）强制拉一次目录当心跳；失败即计入自愈阈值（默认 2 次）。

**还能再压**（改 `data/config.json`，改完即时生效）：

| 想达到 | 设置 | 代价 |
|---|---|---|
| 自愈窗口 ~60 s | `runtime_probe_sec: 20` + `runtime_heal_threshold: 2` | 每秒多一次小 RPC（可忽略） |
| 单次请求不再等 10 分钟 | `TRAE2API_IDLE_TIMEOUT_MS=180000`（环境变量） | 上游长时间不吐事件（超长思考）会被判超时 |

### 4.0.41 常驻短周期看护（5 秒一轮，崩了立刻拉起 + 自动预热）

旧的 `supervise.ps1` 是 15 秒轮询、只负责「进程在不在」，拉起后不预热，所以崩溃恢复要
41–61 秒（15s 发现 + 20–40s 冷启 + 首个请求自己承担初始化）。

新增两个脚本，把这条链做完整：

| 脚本 | 作用 |
|---|---|
| `deploy/watch-runtime.cjs` | **常驻看护**：默认 5s 一轮。① aiserver 不在 → 立刻拉起 → 2.5s 后自动预热；② 进程活着但链路挂死（网关 `/api/status` 的 `modelsError` / `heal.recentFailures`）→ 调 `POST /api/heal` 让网关自己重启（网关知道有没有请求在跑，不会掐断回答） |
| `deploy/warm-runtime.cjs` | **独立预热**：不依赖网关，直接连 AHA 拉模型目录 + 发一次极小 chat，打印各阶段耗时 |

用法：

```powershell
# 常驻（推荐由 start-runtime.ps1 自动拉起，默认就是它）
pwsh -NoProfile -File start-runtime.ps1 -Root <运行时根>

# 手动跑看护 / 加急周期
node deploy\watch-runtime.cjs --dest <运行时目录> --interval 3
node deploy\watch-runtime.cjs --dest <运行时目录> --dry-run     # 一次性自检，不常驻

# 只预热（例如手工重启过 aiserver）
node deploy\warm-runtime.cjs --dest <运行时目录>
```

日志：`<运行时目录>\logs\watch.log`（超过 2 MB 自动轮转一次），形态：

```
看护启动：dest=D:\apps\trae2api-runtime interval=5s gateway=http://127.0.0.1:18790 warm=true heal=true
检测到 aiserver 不在运行（pid=无），立即拉起
启动运行时：D:\…\run-aiserver.cmd
拉起后 aiserver pid=2312
预热开始（crash-restart）
✅ 预热完成 [warm 01:44:09] 模型目录 11 个（4300ms） | 聊天预热完成（2100ms…）
心跳：aiserver pid=2312 存活，网关 connected=true 模型 11 个｜累计拉起 1 次，触发自愈 0 次
```

**效果对比**（崩溃场景）：

| | 旧 supervise.ps1 | 新 watch-runtime.cjs |
|---|---|---|
| 发现崩溃 | ≤15 s | **≤5 s** |
| 拉起后预热 | 无（首个请求自己撞冷启 37–50 s） | **自动**（目录 4.3 s + chat 2.1 s） |
| 链路挂死 | 不管 | 让网关 `/api/heal`（含 inflight 保护） |
| 用户可见中断 | 41–61 s，且首个请求可能再卡 40 s | **≈15–20 s**，之后立即可用 |

`start-runtime.ps1` 默认优先起 watcher；想退回旧行为用 `-LegacySupervise`。

### 4.0.42 复盘：为什么 `findAddon` 只认扩展目录这个 bug 一直没被发现

bug 本身：`lib/aha.cjs` 的 `findAddon()` 只在 `<HOME>/.vscode/extensions/marscode.marscode-extension-*` 里找
`addon.node`（zmq 原生模块）。自包含部署（VSIX 解包到 `<dest>/aiserver`、机器上没装 Trae 扩展）必然失败，
报「找不到 zmq addon，请检查 Trae 扩展安装路径」。

**为什么没暴露（按贡献大小排序）**：

| # | 原因 | 具体证据 |
|---|---|---|
| 1 | **测试环境其实是"扩展式"**：bg1 上所谓自包含运行时，`C:\trae-ide\run-aiserver.cmd` 里 `cd` 到的仍是 `%USERPROFILE%\.vscode\extensions\marscode.marscode-extension-1.7.16\resource\aiserver`，所以每次跑都能命中扩展目录 | 该 cmd 文件逐行可查 |
| 2 | **网关从不显式传 addonPath**（`server.cjs:224` `new AhaClient({ log })`），全靠兜底；只要机器上有扩展就永远成功，缺陷被"刚好能用"掩盖 | 代码可查 |
| 3 | **部署形态变了，老假设没回溯**：自包含/免 VS Code 是 2026-11-22 才主推的（运行时自举 + 自带内核），`findAddon` 是更早写的，没人回头审"必须装扩展"这个前提 | 时间线 |
| 4 | **Linux 那次失败修的是另一个点**：WSL 报 `Failed to load zeromq` 的根因是 `prebuild/manifest.json` 被平台过滤误删，修完就通，没有顺手补"自包含时 addon 从哪来" | 2026-11-22 记录 |
| 5 | **没有针对"没有 .vscode 的机器"的测试**：`test-platform-paths.cjs` 只测路径归一化，没测 addon 候选顺序 | 测试清单 |

**防复发**：

1. 新增 `test-addon-resolve.cjs`（5 项，子进程隔离 HOME）：自包含 prebuild / 扩展目录 / 显式 `TRAE2API_AHA_ADDON` / 三者都没有时**必须报错并给出可操作提示**；
2. `findAddon` 现在的候选顺序：`TRAE2API_AHA_ADDON` → 运行时自带 `<dest>/aiserver/prebuild/<os>/<arch>/node/<toolchain>/addon.node`（feat/linux 版还扫 `zmq.<os>-<arch>.node`、`.vscode-server`）→ 桌面扩展目录；
3. `deploy/warm-runtime.cjs --dry-run` 会打印解析到的运行时/aha 目录，部署时先自检；
4. `check-version` 增 `aha.addonCandidates` 与 `test.addonResolve`。

**教训（写进流程）**：部署形态新增一种（自包含/无 VS Code/容器）时，必须为"资源定位"类代码补一条**同形态的测试**，
而不是继续在"手边那台刚好有扩展/刚好有 SDK"的机器上验证。

### 4.0.43 失败即拉起：谁在判断、第一次失败就动吗

**有，分两条路，粒度不同**：

| 失效 | 谁发现 | 多快动 | 依据 |
|---|---|---|---|
| **进程崩了/被杀** | 常驻看护 `watch-runtime.cjs`（5 s 一轮） | **≤5 s 立刻拉起 + 自动预热** | `isAlive(pid)` 失败即 `launch()` |
| **进程活着但链路挂死** | 网关主动探测（每 `runtime_probe_sec`=15 s，超时 10 s）→ 看护 5 s 内发现 `recentFailures>0` | **首次失败即 `POST /api/heal`**（不等内部阈值） | `heal` 字段对外暴露，看护按 `recentFailures>0` 触发 |
| 同上，但**看护没在跑** | 网关自己的 healer | 失败**权重**≥阈值(2) 即触发 | 见下 |

**失败权重（本版新增）**：

- **真实对话**的 RPC 超时 → 权重 **2** ⇒ 单次即达阈值，立刻自愈（用户已经受影响了，不用再等第二次）；
- 后台探测 / `/v1/models` 失败 → 权重 **1** ⇒ 需要 2 次，避免单次抖动误杀；
- 成功一次即清零；有请求在跑（`inflightChats>0`）暂缓；冷却 `runtime_heal_cooldown_sec` 默认从 300 s 降到 **120 s**。

**最坏/最好时延（链路挂死）**：

| | 检测 | 恢复（杀+看护 15s 轮询+冷启+预热） | 合计 |
|---|---|---|---|
| 最好（故障正好在探测前） | 10 s 超时 + ≤5 s 看护 | 41–61 s | **≈56–76 s** |
| 最坏（刚探完就坏） | 15 s 间隔 + 10 s + ≤5 s | 41–61 s | **≈71–91 s** |

想更快（`data/config.json`，改完即时生效）：

```json
{ "runtime_probe_sec": 5, "runtime_probe_timeout_ms": 5000, "runtime_heal_threshold": 2 }
```

代价：每秒一次 `model_list` 心跳（健康时 ~200 ms，很轻）；超时设 5 s 时，上游偶发慢会更容易被判死。

### 4.0.44b 重启后重连的两个坑（2026-11-23 真机踩到）

**坑一：不能要求「socket 名字变了」才算就绪。**
原来 `restartRuntime()` 用 `waitForFreshSocket()` 等 `latestSocket()` 返回**不同**地址；
但只重启 aiserver 时，ai-agent 往往没死、socket 还是原来那个 → 等满 90 s 超时 → 之后 `connected` 永远 false。
现改为 `reconnectAha(timeoutMs)`：反复 `close()` + `connect()` 直到 `connected`，不看地址是否变化。

**坑二：只能有一个「监护人」。**
旧计划任务 `trae-runtime-super`（15 s `supervise.ps1`）和新的 5 s `watch-runtime.cjs` 同时跑会互相拉起，
产生 2 个 aiserver + 2 个 agent，表现就是 `connected` 反复 true/false。
处理：**停用旧任务/旧看护，只保留一个**（本机 2026-11-23 04:21 停用 `trae-runtime-super`，改由 watcher 负责）。

升级到本版时的检查清单：

```powershell
# 1) 只能有一个监护进程
Get-CimInstance Win32_Process | ? { $_.CommandLine -match 'watch-runtime|supervise\.ps1' } | select ProcessId,CommandLine
# 2) 只能有一个 aiserver
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | ? { $_.CommandLine -match 'aiServerMainV2' } | select ProcessId
# 3) 旧任务应处于 Disabled
Get-ScheduledTask -TaskName 'trae-runtime-super' | select TaskName,State
```

### 4.0.45b 提示词可配置：`data/prompt.md`（默认不启用）

网关注入的 CALL 协议说明原本硬编码在 `lib/tools-bridge.cjs:buildInstructionText()`，改措辞得改代码。
现在支持**模板文件**：

- 放 `data/prompt.md` → **整段替换**内置说明；删掉 → 立刻回到内置文本（逐字节与原来一致）；
- 两个占位符：`{{TOOLS}}`（或 `__TOOLS__`）→ 渲染好的工具清单（full/signature/names-only 由 `tool_block_budget` 决定）；
  `{{NATIVE_BAN}}`（或 `__NATIVE_BAN__`）→ 内置工具禁令段（`native_ban:false` 时替换为空）；
- 按 **mtime+size** 热重载，改完下一次请求即生效，**不用重启网关**。

最小可用模板：

```markdown
你现在可以使用【外部工具】。
可用工具：
{{TOOLS}}
{{NATIVE_BAN}}
【调用格式】需要工具时单独写一行：CALL <工具名> <参数JSON>
- 不要在正文里声称"已读取/已执行"却没有 CALL 行。
```

注意：模板里**没写 `{{NATIVE_BAN}}`** 就不会注入禁令（尊重模板作者意图）；`tool_choice: required` 的强制行仍会追加在模板之后。
回归测试 `test-prompt-template.cjs`（13 项）：无模板=内置文本、`native_ban=false` 不注入、模板生效、两占位符替换、热重载。

### 4.0.46b 工作区目录校验：传了个假目录直接告诉你

> 背景：早前做过「声明工作区 → 自动切上游锚点」的一套改动，因为要"猜"（从自然语言里推断目录）不够保险，
> 已整体回滚（备份分支 `backup/ws-series-main` / `backup/ws-series-linux`）。现在只保留**校验**：
> 不猜、不切、不改行为，只在你声明的目录不真实时明确报错。

**规则**

| 情况 | 行为 |
|---|---|
| 消息里同一行出现「工作区 / 工作目录 / workspace / cwd / project root」**且**带绝对路径 | 校验该目录 |
| 目录不存在 | **HTTP 400** + `x-trae-workspace-check: not-found`，正文见下 |
| 路径指向文件 | 400 + `not-a-dir` |
| 目录存在 | 200，响应头 `x-trae-workspace-check: ok`，照常转发 |
| 只有路径没有关键词 / 相对路径 / 没提工作区 | 视为"没声明"，不做任何事 |

报错样例：

```json
{ "error": {
    "message": "客户端声明的工作目录不存在：D:/tmp/definitely-not-exist-1234（请检查路径拼写，或先在机器上创建该目录）",
    "type": "invalid_workspace", "code": "workspace_not_found",
    "workspace": "D:/tmp/definitely-not-exist-1234" } }
```

**配置**（`data/config.json`，**改完要重启网关**——配置在启动时读入内存）

| 键 | 默认 | 说明 |
|---|---|---|
| `workspace_check` | `"error"` | `error`=400 拦截；`warn`=放行 + 响应头 + 日志；`off`=不校验 |
| `workspace_check_writable` | `false` | 额外要求可写（`not-writable`） |

**实测（bg1 生产网关）**

```
A 假目录（有关键词）      HTTP400  header=not-found   客户端声明的工作目录不存在：D:/tmp/definitely-not-exist-1234…
B 真实目录                HTTP200  header=ok          正文「收到」
C 只有路径无关键词        HTTP200  header=-           正文「收到」（不校验）
D 指向文件                HTTP400  header=not-a-dir   客户端声明的工作目录不是目录：D:/tmp/ws-file.txt
E 相对路径「工作目录：github/foo」 HTTP200 header=-     正文「收到」（不当声明）
F 完全没提工作区          HTTP200  header=-           正文「收到」
warn 模式（重启后生效）    HTTP200  header=not-found   正文「收到」（放行）
```

实现：`lib/workspace-check.cjs`（`extractDeclared` / `checkWorkspace` / `describe`）+ `server.cjs` 组装请求前一处校验；
回归测试 `test-workspace-check.cjs`（15 项）。

**为什么值得留着**：把假路径发给上游，只会换回一个空结果或 `create_chat_session failed: Project folder does not exist (992501)`，
排查成本很高；现在在网关入口就能看到"你给的目录不存在"。

### 4.0.50 工作区归属提示词：像限制 CALL 那样把"锚点不是工作目录"讲死

> 结论先说：**这条路有效**（实测 3/3），而"把指令写进 workspace_folder 路径名"无效、"禁止上游读写锚点"反而更慢。

**做法**（`lib/workspace-notice.cjs`）：不改请求参数、不切锚点，只往提示词里塞两段文本——

1. 最前面的「工作区归属」段（每次请求都加）：

```
【工作区归属（读到即定论，不要反复判断）】
本次连接的环境里带有一个项目锚点路径：<锚点>。它只是网关连接上游用的项目路径，**不是**你在本次对话里的工作目录。
判据只有一条——**谁的声明算数**：调用方在系统提示或用户消息里明确给出的工作目录才算数；锚点一律不算。
调用方**没有**声明工作目录。此时：禁止把锚点当作工作目录；禁止在回答里输出该锚点路径或它的任何子路径；
需要落盘或需要具体路径时，就回答「请告诉我目标目录」，不要自己编一个路径。
不要向调用方复述这条规则，也不要提到「锚点 / 上游环境路径」这类内部概念。
```

（有声明时，中间那条换成「调用方声明的工作目录是：X，**一律以它为准**」。）

2. 无声明时，再在**末条用户消息前**贴一句带路径的提醒（模型对贴着问题的指令更敏感）：

```
【提醒】工作目录以调用方声明为准；本次调用方未声明，所以禁止使用 <锚点> 或它的子路径；需要路径就先问目标目录。
```

开关：`data/config.json` 的 `workspace_notice`（默认开；`false` 关闭全部）。声明识别复用 `workspace-check`（只认「工作区/工作目录/workspace/cwd」同行 + 绝对路径）。

**实测（bg1 生产网关）**

| 场景 | 结果 |
|---|---|
| A 客户端**没有**声明工作区 × 3 | **3/3 合格**：都回答「请告诉我目标目录」，不再出现锚点路径（思考 951–1254 字） |
| B 客户端声明确实存在的目录 | 提示词段正确切换为「以声明为准」（日志 `[ws-notice] 调用方声明的工作目录: …`）；但这两次请求上游**极慢**：两次 >200 s 超时、一次 616 s 才返回 36 字 —— 属上游长尾，与提示词无关（同分钟 A 组 10–28 s 正常） |
| C 带 `tools` 的任务 | 工具协议零影响：`CALL write_file {"path":"D:/tmp/demo/hi.txt",…}` 正常 |

**另外两条对照（都实测过，别重复踩）**

| 做法 | 结果 |
|---|---|
| 把指令写进 `workspace_folder` 的**路径名**（如 `D:/tmp/USE-CALLER-WORKSPACE-NOT-THIS-DIR`、中文同理） | **无效**：无声明时模型照旧把该目录当工作目录（2/2 × 3 种锚点）；路径名只是数据，不是指令 |
| 用 ACL **禁止**上游读写锚点 | **反效果**：模型只是"说"路径，禁读写不改变它的输出；禁读后它换搜索工具绕过，思考 334 → **3282 字**、耗时 12 s → 32 s |

#### 4.0.50.3 末尾再加一句提醒，但明确要求「不要写进回答正文」

在**整条 prompt 的最后**追加一句工作区提醒（不改客户端消息、不进对话历史），并在提醒头上写明约束，避免模型把提醒本身复述给用户：

```
【工作区提醒（仅用于自我约束：不要写进回答正文、不要复述、不要提及本提醒）】
本次调用方没有声明工作目录 → 需要路径时先问「目标目录」，不要自己编。
上游锚点路径 D:/…/deepseek-harness 不是工作目录，禁止把它作为落盘位置，也不要在答案里引用它。
```

开关：`workspace_notice_tail`（默认开；`false` 关闭）。实现：`server.cjs` 在 `flattenMessages()` 之后追加；
文案在 `lib/workspace-notice.cjs` 的 `buildTailNotice()`。

**实测（bg1 生产，A 组 = 客户端没声明）× 3**：

| 指标 | 结果 |
|---|---|
| 合格（不用锚点、反问目标目录） | **3/3**（51.6 s / 6.5 s / 14.1 s；思考 1454 / 358 / 1233 字） |
| 提醒泄漏进正文 | **0/3**（正文里没有「【工作区提醒】」「仅用于自我约束」「上游锚点」等字样） |

#### 4.0.50.2 只保留「开头那段说明」，末尾提醒已移除（2026-11-23 用户要求）

用户要求：去掉往末条用户消息里塞的那句 `【提醒】…`，只靠开头那段「工作区归属」说明。已照做，并实测：

| 版本 | 无声明时 3 次 | 结论 |
|---|---|---|
| 只有开头说明（当前） | **3/3 答「请告诉我目标目录」**，不含锚点 | 够用 |
| 说明 + 末尾提醒（上一版） | 3/3 | 效果相同，提醒多余 |

实现：`server.cjs` 删掉末条 user 消息的插入逻辑，`lib/workspace-notice.cjs` 删除 `buildReminder()` / `injectReminder()`，
测试相应精简为 12 项（只测归属段文本与声明识别）。好处：**不再改动客户端的消息内容**，prompt 更干净。

同批实测：
- 有声明（system 里 `工作目录：D:/tmp/ws-declared-check`）→ 回答用声明目录（符合预期）；
- 带 tools 的任务 → `CALL write_file {"path":"…"}` 正常，工具协议无影响。

> 已知遗留：**声明了工作区的那条路径上，上游偶发极慢**（>200 s 超时、一次 616 s 才回 36 字），与提示词无关，待单独压测。

#### 4.0.50.1 声明识别收紧：用户随口提到的目录不再被误判

原来的判定是「同一行出现关键词 + 绝对路径」，于是这类**普通叙述**会被误判成"客户端声明了工作区"：

| 句子 | 旧判定 | 现在 |
|---|---|---|
| 我在调试另一个项目，这个项目目录在 D:/proj/other 下 | ❌ 命中 `D:/proj/other` | ✅ 未声明 |
| 这个项目目录在 D:/proj/x 下 | ❌ 命中 | ✅ 未声明 |
| 我在 D:/proj/c 里干活，这个目录是工作目录 | ❌ 命中 | ✅ 未声明 |
| 参考一下 /home/u/other 那个仓库怎么做的 | ❌ 可能命中 | ✅ 未声明 |
| 工作目录：D:/proj/a | ✅ 命中 | ✅ 命中 |
| 当前工作目录是 D:/proj/a | ✅ | ✅ |
| workspace: /home/u/demo / working directory is D:\proj\b / 工作区为 D:/proj/c | ✅ | ✅ |

**新规则（`lib/workspace-declare.cjs`）**：

1. 关键词必须**紧跟分隔符**（`: ： = 是 为 is`），再跟**同一行**的绝对路径；「关键词后跟 '在/位于'」这类叙述不算；
2. **默认只看 `system`/`developer` 消息**——用户聊天内容一律不参与（`workspace_declare_scope: "all"` 才放开到 user）；
3. 相对路径、尾斜杠、反斜杠照旧归一化处理。

`workspace-check.cjs` 的 `extractDeclared` 已改为委托这个严格实现（只有一份规则，避免两套漂移）。
回归测试 `test-workspace-declare.cjs` **21 项**（7 条「不能命中」+ 6 条「必须命中」+ 作用域 + 归一化）。

**实测（bg1 生产，部署后）**：

```
用户：我在调试另一个项目，这个项目目录在 D:/tmp/proj-x 下，帮我把分析结果写成报告，给出完整路径。只输出路径。
回答：请告诉我目标目录，并提供要写入报告的分析结果内容。
→ 没有把 D:/tmp/proj-x 当成工作区（旧规则会）
```





### 4.0.76 第二遍代码复审：死代码清理、流式异常补 `[DONE]`、鉴权复核（2026-11-26）

**复审方法**：先静态查「定义了没人用」的符号（上一轮 `loadJournal()` 就是这么漏的），再实测鉴权矩阵与流式收尾。

**清掉的死代码（5 处）**

| 位置 | 情况 |
|---|---|
| `lib/aiserver-client.cjs` | **整个模块没人 require**（README 说「用于诊断/登录辅助」，实际登录走 `trae-login.cjs` + `cdp.cjs`）→ 删除，文件树同步 |
| `lib/workspace-check.cjs` 的 `_legacyExtractDeclared_unused` | 名字就写着 unused，全仓库只有定义处 → 删除 |
| `server.cjs` 导入 `STATUS` | 导入了没用 → 换成真正要用的 `shouldPing` |
| `handleModels` 的四个别名字段 | 与 `lib/caps.cjs` 的 `modelAliasFields()` 重复实现 → 改用 `...modelAliasFields(cap)` |
| 心跳里的 `pingTick % 15` | 与 `lib/stream-meta.cjs` 的 `shouldPing()` 重复 → 改用它 |

**补一处流式收尾漏洞**：`handleChatInner` 的 `catch` 分支（流已开始后抛异常）只发了 error 帧就 `res.end()`，
**没发 `[DONE]`**，客户端会报「stream ended without finish」并可能原样重试。现在所有流式错误路径都先补 `[DONE]`。

**登录失败表纳入定期清理**：`LOGIN_FAILS` 原来只在新失败时覆盖旧记录，唯一 IP 会一直留在 Map 里；
现在跟 `SESSIONS` 一起每 10 分钟清理过期条目。

**鉴权矩阵实测**（本机回环 vs 局域网 IP，生产 172.16.0.59:18790）

| 请求 | 回环 127.0.0.1 | LAN IP |
|---|---|---|
| `GET /v1/models` 无 key | 200（回环免密，设计如此） | **401** |
| `GET /v1/models` 错误 key | 200（同上） | **401** |
| `GET /v1/models` 正确 key | 200 | 200 |
| `POST /v1/chat/completions` 无 key | 200（回环） | **401** |
| `GET /api/status`、`/api/requests` 无会话 | 200（回环） | **401** |
| `GET /healthz` | 200 | 200（监控用，故意开放） |

结论：远程访问的鉴权是成立的；「本机免密」是既定设计（README 已写明），不是漏洞——但也意味着**同机的任何进程都能免密调用**。

**新增守卫 `test-no-dead-code.cjs`（4 例）**：①`server.cjs` 导入的名字必须被用到；②顶层函数必须被引用；
③`lib` 导出必须被非测试代码用到（常量豁免，只被测试用的需登记理由）；④`lib/*.cjs` 模块本身必须被 require。

### 4.0.75 P4 收尾：静默 catch 闸门、Cookie Secure、自检补项、Linux 分支说明（2026-11-26）

**P4-13 静默 catch 加闸门**

全仓库曾有 **101 处空 `catch {}`**（`server.cjs` 19、`lib/aha.cjs` 18、`lib/creds.cjs` 13……）。逐个改造既费时又容易在容错路径上引入新崩溃，
所以改成**棘轮（ratchet）**：`test-silent-catch.cjs` 把每个文件的「空 catch 数 / 未注解数」钉在 `tools/silent-catch-baseline.json` 里，
**新增一处就失败**；确实要静默的必须写 `catch (e) { /* 有意静默：原因 */ }` 并在同一次提交里调高基线。

同时把 3 处「吞掉真故障」的静默改成留痕：

| 位置 | 以前 | 现在 |
|---|---|---|
| 工具块参数读取（`data/config.json`） | 读失败静默用默认值 | 记 `[config] 读取工具块参数失败，按默认值继续: …` |
| `healthSnapshot()` 的 `creds.status()` | 静默返回 `{}`（`/healthz` 少一项检查） | 记 `[health] creds.status() 失败: …` |
| 日志轮转 | 磁盘满/权限问题完全无声 | 首次失败提示一次 `[log] 轮转失败（只提示一次）: …` |

**P4-14 会话 Cookie 按协议加 `Secure`**

新增 `lib/cookie.cjs`：`isSecureRequest()`（认 `req.socket.encrypted` 与 `X-Forwarded-Proto`）决定是否加 `Secure`。
局域网 HTTP 部署行为不变，反向代理到 HTTPS 时自动加 `Secure`（此前一律没有，等于在 HTTPS 下少了一层保护）。

**P4-15 `check-version` 补 6 项**

`cookie.secure`（`lib/cookie.cjs`）、`config.limitKeys`、`config.toolAliasKeys`、`panel.newStatus`（面板标签含 `undeclared_tool`）、
`test.silentCatch`、`test.cookie`。自检从 67 → **73 项**。

**P4-16 Linux 支持在 `feat/linux` 分支**

systemd 单元、平台路径归一化、zmq addon 候选顺序只在 `feat/linux`；`main` 保持 Windows 形态，不混入 Linux 文件。
需要 Linux 部署时用该分支（README §7 的 `test-platform-paths.cjs` 也在那条分支上）。

**新增测试 24 例**：`test-cookie.cjs` 21 例（协议判定、属性拼装、登录/登出一致性）、`test-silent-catch.cjs` 3 例（棘轮闸门）。

### 4.0.74 P1 全修 + 限流/会话清理 + 可观测性测试（2026-11-26）

按代码审查清单修完 **P1 全部 5 项**、**P2 的 #9/#10**，并补齐 **P3 测试**。

**P1-1 面板状态标签补全**（`public/index.html`）

`STATUS_LABEL` 增加 `undeclared_tool`（未声明工具，warn）、`truncated_output`（打满输出上限，warn）、`agent_offline`（运行时离线，err）、
`truncated_call`（CALL 被截断，err）、`client_gone`（客户端已断开，warn）；删掉代码里早已不存在的 `truncated`。
此前这些状态会显示成英文原名并统一套红色。

**P1-2 错误汇总覆盖所有失败**（`server.cjs`）

`/api/errors` 以前只统计 `status==="error"`，于是 `idle_timeout / undeclared_tool / empty_content / truncated_output / upstream_timeout / truncated_call` 全看不见。
现在按 `lib/stream-meta.cjs` 的 `levelOf()` 聚合**所有非正常状态**，并给每条带 `level`（err/warn）与 `status`；面板错误表新增「等级」列。
`/api/requests?status=` 也扩展了：`error`（任何 err 级）/ `fail`（任何失败含 warn）/ `warn` / `tool` / 精确状态名。

**P1-3 客户端断开立刻中止上游**（`server.cjs`）

以前 `res.on("close")` 只把连接从 `activeStreams` 里删掉，上游继续生成（长思考/长输出能白烧几分钟并占账号池）。
现在断开即 `abort` 当前上游请求，`status=client_gone` 记入审计，并跳过后续的回灌/纠偏重试。

**P1-4 全局异常兜底**（`server.cjs`）

补 `process.on("unhandledRejection" / "uncaughtException")`：记 `[fatal]` 日志后继续运行。
以前一个漏 catch 的异步异常会直接把进程带走，在途请求全断（只能靠看护器拉起）。

**P1-5 日志与请求记录轮转**

`trae2api.log` 超过 `TRAE2API_LOG_MAX_MB`（默认 10MB）滚成 `.1`；`requests.jsonl` 超过 5MB 滚成 `.1`。
以前两者都只追加，实测已分别长到 6.12 MB / 0.28 MB。

**P2-9 面板会话过期清理**：每 10 分钟扫一次 `SESSIONS`，删掉过期 token（以前只在被访问/登出时删）。

**P2-10 `/v1` 限流**：新增 `rate_limit_per_min`（按 Bearer/IP 每分钟上限）与 `max_concurrent`（全局在飞上限），
超限返回 `429` + `Retry-After` 并记审计。两档默认 `0`（不限），生产设为 **240/min、并发 8**。

**顺手抓到的第 6 个 P1 级缺陷：`loadJournal()` 定义了却从没被调用**

`data/requests.jsonl` 一直在写，但**启动时从不回读**，所以每次重启面板「请求日志 / 错误汇总」都是空的
（实测重启后 `/api/requests` 返回 `total:0`，而磁盘上有 938 行有效记录）。补上 `loadJournal()` 调用后
重启即恢复：`total=500`（内存环上限），`?status=error` 16 条、`fail` 29 条、`warn` 13 条。

**顺带让参数在网关上可见**：`/api/status` 的 `config` 段新增 `undeclared_tool_mode`、`undeclared_tool_retries`、
`rate_limit_per_min`、`max_concurrent`、`stream_keepalive_ms`、`idle_timeout_ms`、`reasoning_abort_chars` 七项，
不用再翻 `data/config.json` 才知道当前生效值。

**P3 新增测试（45 例）**

| 文件 | 用例 | 覆盖 |
|---|---|---|
| `test-panel-tables.cjs` | 10 | 面板表头列数 == 行内单元格数；**代码里写出的每个 status 都要有面板标签**且级别一致 |
| `test-caps.cjs` | 16 | 容量覆盖优先级、三个别名一致性、`capHit` 只在「恰好等于」时成立 |
| `test-keepalive.cjs` | 21 | 空帧保活阈值判定（含 12.9s 静默的真实场景）、SSE 注释兜底、状态词表与失败级别 |
| `test-ratelimit.cjs` | 18 | 每分钟窗口、并发上限、release、配置热切换、非法配置降级 |

**顺带的重构**（为可测性，行为不变）：容量口径移到 `lib/caps.cjs`，保活判定与状态词表移到 `lib/stream-meta.cjs`，
限流器在 `lib/ratelimit.cjs`，`server.cjs` 只做接线。
### 4.0.73 未声明的工具调用回灌给上游（A4 落地，2026-11-26）

**问题**：模型在正文里手写 `CALL <名字> {json}`，网关以前**不和请求的 `tools` 比对**就直接转成 `tool_calls`。
实测过请求只声明 `write_file`、模型却写 `CALL get_weather`，客户端收到一个自己没声明的工具（轻则报错，重则误执行）。

**做法**（用户选定）：不要静默丢弃，而是**把「这个名字不合法」当成一次失败的调用回灌给上游**，让模型在同一轮里自己改。
网关是无状态代理，所以「回灌」在本链路上等于**内部再发一次上游请求**（客户端看不到这次失败）。

```
第 1 轮  上游 → 网关：CALL get_weather {"city":"北京"}
         网关判定：get_weather ∉ {write_file}
第 2 轮  网关 → 上游：原 prompt ＋「你调的名字不在已声明列表里，二选一：换个已声明的工具，或用正文回答」
         上游 → 网关：CALL write_file {...}        ← 自愈
最终     网关 → 客户端：只发这一个合法 tool_call
```

| 键 | 默认 | 说明 |
|---|---|---|
| `undeclared_tool_mode` | `feedback` | `feedback` 回灌自愈 / `strip` 丢弃 / `passthrough` 旧行为 |
| `undeclared_tool_retries` | `1` | 回灌次数上限 |
| `tool_aliases` | `{}` | 模型自造名 → 已声明名（先别名再判未声明） |

**匹配顺序**：完全相等 → 忽略大小写与下划线（`WRITE_FILE` / `writefile` / `read-file` 都算命中）→ `tool_aliases` → 才判未声明。

**几个关键细节**

- **不再复述工具清单**：工具说明本来就在本轮 prompt 里，回灌文案只点名「你写的这个名字不合法」，省 token 也避免两份清单打架。
- **早公告只发已声明名字**：否则客户端先收到非法工具名，回灌后又拿不到对应 id，会把两轮拼在一起。
- **回灌不叠加**：只在「没有早公告过」时回灌，避免与 `tool_choice=required` 的纠偏重试叠加成 2×2 次上游调用。
- **失败兜底**：回灌后仍无合法调用 → 把非法 CALL 行（含多行 JSON 参数）从正文里剔掉，按正文返回，审计记 `status=undeclared_tool`、`undeclared:["get_weather"]`。
- **统计**：`/api/status` 的 `stats` 增 `undeclaredCalls` / `undeclaredRetries` / `undeclaredFixed`，能直接看出这机制救回多少。

**验证**：`test-tool-whitelist.cjs` 28/28（归一化、别名、分流、回灌文案、正文剔除、多行参数）；
声明 `write_file` 却要求查天气时，客户端收到的**不是** `get_weather`；正常写文件流程仍然 `tool_calls`。
### 4.0.72 自检补强：check-version 覆盖新功能、/healthz 三项自检、断链立即失败（2026-11-25）

代码审查（「还剩下什么没做」）确认的三个缺口，本轮全部修掉；A4（未声明工具名拦截）只出方案未动代码。

**1. `check-version` 补 12 项**（原 43 项）

此前它完全不知道 4.0.60–4.0.71 加过什么，部署目录里跑一遍会报「全具备」——属于**假信心**。新增：

| 新项 | 检查内容 |
|---|---|
| `toolcall.early` | 工具调用早公告（`earlyCall`） |
| `stream.keepalive` | 空帧保活（`stream_keepalive_ms`） |
| `idle.timeoutCfg` | 空闲看门狗可配（`idle_timeout_ms`） |
| `cap.lengthMark` | 打满上限标 `length`（`capHit`） |
| `models.capacity` | 容量覆盖（`modelCapacity`） |
| `models.aliasFields` | 兼容别名（`max_input_tokens` 等） |
| `config.jsonc` | 配置 JSONC 容错（`stripJsonc`） |
| `health.checks` | `/healthz` 三项自检（`computeChecks`） |
| `test.configJsonc` / `docs.config` / `tools.verifyDocs` | 配置测试 / 配置文档 / 文档校对工具 |

现在自检共 **54 项**，仓库根跑 `node deploy/check-version.cjs --dir .` → `合计 54 项：具备 54，缺 0`。
（同一份脚本此前在生产目录只认 35 项，说明那份部署连自检脚本本身都是旧的——已随本轮一起更新。）

**2. `/healthz` 增加 `checks`（`lib/health.cjs`）**

`ok` 仍只表示「网关进程在跑」，新增三项结构化自检，让外部监控能直接区分**运行时没起 / 工作区没了 / 凭据失效**。
判定抽成纯函数 `computeChecks()`，由 `test-health-drop.cjs` 覆盖 18 例（14 种自检组合 + 4 项断链行为）（全绿、无 socket、死 socket、未配工作区、目录不存在、不可写、无凭据、有凭据但续期报错、空输入等）。

**3. 断链时立刻让在飞 RPC 失败（`lib/aha.cjs`）**

`_dropConnection()` 原来只关 socket、清 `connected`，`pending` 表里的请求要各自等满 RPC 超时才报错（表现为「卡住」）。
现在会遍历 `pending` 逐个 `clearTimeout` + `reject`，并记一行 `[aha] 已让 N 个在飞 RPC 立即失败`。

**验证**：`test-health-drop.cjs` 18/18；全量单测 19 文件 349 例全过；`check-version` 54 项全具备；
`tools/verify-docs.cjs` 6/6；生产部署后 `/healthz` 返回 `checks.runtime/workspace/creds` 三项且全绿。
### 4.0.71 文档全面对齐代码 + 修配置模板的隐形坑（2026-11-25）

用户要求「README 和别的部署帮助文档全部更新一遍」。本轮以代码为准逐条校对，改了三类东西。

**1. 新增配置权威文档**

| 文件 | 内容 |
|---|---|
| `docs/CONFIG.md`（新） | 50 个配置键 + 17 个环境变量 + 生效方式 + 面板可改子集 + 校对脚本 |

**2. 修掉一个「照着示例配却不生效」的隐形坑**

`config.example.json` 带 `//` 注释与尾逗号（JSONC 风格），而 `loadConfig()` 只做 `JSON.parse`，
**解析失败会被静默吞掉**、直接用默认值——表现成「我明明配了口令/容量，网关却当没配」。

- `lib/trae.cjs` 新增 `stripJsonc()`：严格 JSON 失败后剥注释/尾逗号重试，**两次都失败就抛出明确报错**（不再静默）；
- `config.example.json` 补全到 45 个键（含 4 张容量覆盖表、`idle_timeout_ms`、`stream_keepalive_ms`、自愈参数等）；
- 新增 `test-config-jsonc.cjs`（14 例）：行/块注释、尾逗号、字符串内 `//` 不误删、坏 JSON 仍抛错、示例文件完整性。

**3. 文档口径全面校正**

| 文档 | 改动 |
|---|---|
| `README.md` | 第 1 节目录树补齐 8 个 lib 模块与 4 个 deploy 脚本、新增 `docs/CONFIG.md`；第 5 节补 `/v1/models` 字段表（含三种别名）与 4 个漏写路由（`/api/heal`、`/login.html` 等）；第 6 节改指向 CONFIG.md 并补容量四键/流式三键；第 7 节改成 18 个测试文件、328 用例的实测表；第 8 节新增 4 条排障（客户端 idle timeout、静默看着像卡死、`finish_reason=length`、只思考无正文）；修正键名写错（`tool_instruction_style` → `instruction_style`）；`supervise.ps1` 三处改注「已从仓库移除」 |
| `docs/AI-DEPLOY.md` | 头部版本日期；第 4 节配置表补 12 个新键并标注「改完需重启」；环境变量补 8 个；第 5 节故障表新增 5 行（idle timeout / 静默 / length / empty_content / 116000 回潮）；第 9 节新增 4.0.60–4.0.70 变更表 |
| `docs/MODEL-MAPPING.md` | 新增第 11 节「目录值 vs 官方值」：说明上游 116000/100000/16000 三值不可信、网关按官方值下发哪些字段 |
| `docs/REASONING-EFFORT.md` | 新增第 5 节「思考算在输出预算里」（含 Pro 134,997 / 其它精确 16,000 的实测）；`reasoning_abort_chars` 标注当前为 0（关闭） |
| `docs/REVIEW.md` | 新增第 6 节「2026-11-25 复核补充」：S5（我引入的 TDZ 崩溃）、S6（capHit 误标）、M8（注释心跳无效）、M9（600 s 硬编码）、M10（面板排版）、L7（README 重复段落）、L8（版本号重复） |
| 版本号 | README 里三处历史重号（`4.0.44/45/46` 各出现两次、内容不同）第二处改为 `4.0.44b/45b/46b` |

**4. 新增可复跑的校对工具**

`node tools/verify-docs.cjs` —— 六项硬检查（全部通过才退出码 0）：

```
✓ CONFIG.md 声明的 41 个配置键，代码里全部读取
✓ 文档提到的 17 个环境变量，代码里全部出现
✓ 文档提到的 19 个路由，代码里全部注册
✓ 文档引用的仓库文件都存在（运行期/已删除/其他分支的单独归类）
✓ README 第 7 节：18 个测试文件、328 个用例，逐行与实际一致
✓ 文档正文没有过期键（版本历史里的历史键允许保留）
```

**验证**：`test-config-jsonc.cjs` 14/14；`tools/verify-docs.cjs` 6/6；全量单测 18 文件 328 例全过；
生产已部署 `lib/trae.cjs`（JSONC 容错）并重启，`healthz` `connected:true`。

### 4.0.70 修面板排版：模型表撑出卡片并压到相邻卡片（2026-11-25）

4.0.69 给「模型（实时目录）」加了容量列后，表格比所在栅格单元还宽（`th, td { white-space:nowrap }`，不换行），表格直接溢出卡片、压到右边的「接入信息」上。

**修法**

| 改动 | 说明 |
|---|---|
| 模型卡片改为整行 | `<div class="card" style="grid-column:1/-1">`，独占一整行，不再和「接入信息」并排 |
| 表格外套横向滚动 | `<div style="overflow-x:auto">`，窄屏时只出滚动条，不溢出卡片 |
| 列减为 8 列 | 去掉与「上下文（输入）」同值的「输入预算」列（`prompt_max_tokens` 移到表下说明里） |
| 备注列允许换行 | `class="wrap"` + `max-width:320px`，长备注在单元格内折行 |
| 容量改成简写 | `1M / 128K / 256K / 200K / 16K / 250.1K`，完整 token 数放到 `title`（悬停可见），不再把表格撑爆 |

**格式化规则**（`capText`）

```
1048576 → 1M      131072 → 128K     262144 → 256K
204800  → 200K    16000  → 16K      256144 → 250.1K      0/null → —
```

**验证**：`test-panel-escape.cjs` 10/10 通过；浏览器实测（`http://36.138.189.24:18790/`）模型表独占一行、无溢出，11 个模型的上下文/输出/备注均正常显示。

修复后截图：`D:/Users/Administrator/Documents/deepseek-harness/work/trae2api-panel-after-fix.png`

### 4.0.69 面板显示容量参数 + /v1/models 补兼容别名（客户端「获取可用模型」自动填入）（2026-11-25）

用户要求：网关面板上也要显示这些参数；并且客户端获取模型时自动填入，而不是 116K。

**1. `/v1/models` 补兼容别名**

先核对了 DSH 的解析代码：`dsh-llm-pi-ai/lib/index.js:2393-2394`

```js
const contextWindow = capacity(entry?.contextWindow, entry?.context_window, entry?.context_length, entry?.max_input_tokens, entry?.limit?.context);
const maxTokens = capacity(entry?.maxOutputTokens, entry?.max_output_tokens, entry?.maxTokens, entry?.max_tokens, entry?.limit?.output, entry?.top_provider?.max_completion_tokens);
```

DSH 认 `context_window` / `context_length` / `max_input_tokens` / `max_tokens` / `max_output_tokens` / `limit.*`。所以每个模型现在同时下发：

| 字段 | 值（DeepSeek-V4-Pro 为例） |
|---|---|
| `context_window` / `context_length` / `max_input_tokens` | 1,048,576 |
| `max_tokens` / `max_output_tokens` | 131,072 |
| `limit` | `{ context: 1048576, output: 131072 }` |
| `prompt_max_tokens` | 1,048,576 |
| `max_tokens_note` | 官方标称 MAX OUTPUT 384K（含思维链）；此处按已验证可达的 128K 标注，实测可能更高 |

这样 Cline/Roo（读 `context_length`）、LiteLLM 风格（读 `limit.*`）也不会再退回默认值。

**2. 面板新增容量三列**

`public/index.html` 的「模型（实时目录）」表新增 **上下文（输入） / 输出上限 / 输入预算 / 备注** 四列，容量做人类可读格式化（`1048576 → 1,048,576（1M）`、`131072 → 131,072（128K）`），并在表下注明这些值就是 `/v1/models` 下发的字段、改哪里能调。

**3. 数据同源**

`server.cjs` 抽出 `modelCapacity(m)` 统一算容量（覆盖表优先，其次上游声明），`/v1/models` 与 `/api/status`（面板数据源）共用，避免面板和接口显示的数值打架。

**验证**

```
/v1/models     Pro: context_window=1048576 max_tokens=131072 limit={context:1048576,output:131072} + note ✅
/api/status    11 个模型均带 context_window / prompt_max_tokens / max_tokens / max_tokens_note ✅
面板首页       含「上下文（输入）」「输出上限」「输入预算」列与 capText 格式化函数 ✅
test-panel-escape.cjs  10/10 通过
```

### 4.0.68 DeepSeek-V4-Pro 输出上限标注 128K（并注明可能更高）（2026-11-25）

承接 4.0.67（上下文标注已按官方输入上限改好）。输出侧 `max_tokens` 仍沿用上游统一的 16,000，对 Pro 明显失真——官方标称 **MAX OUTPUT 384K**，我们已实测单轮到 **134,997**。

**按用户要求**：Pro 标 **128K（131,072）**，并加一条备注说明可能更高。

**改动**

| 位置 | 内容 |
|---|---|
| `server.cjs` | `/v1/models` 的 `max_tokens` 支持 `max_tokens_override`；新增可选字段 `max_tokens_note`（有配置才输出） |
| `server.cjs` | 截断判定 `modelCap` 优先取 `max_tokens_override`（原取模型缓存声明值） |
| `data/config.json` | `max_tokens_override: { "DeepSeek-V4-Pro": 131072 }`；`max_tokens_note: { "DeepSeek-V4-Pro": "官方标称 MAX OUTPUT 384K（含思维链）；此处按已验证可达的 128K 标注，实测可能更高" }` |

**验证**（重启后 `GET /v1/models`）

```
DeepSeek-V4-Pro   context=1048576  prompt=1048576  max_tokens=131072
                  max_tokens_note=官方标称 MAX OUTPUT 384K（含思维链）；此处按已验证可达的 128K 标注，实测可能更高
其余 10 个模型     max_tokens 仍为 16000（这条通道上 Flash/qwen/glm 确实精确卡 16,000）

冒烟：DeepSeek-V4-Pro 小请求 HTTP200 finish=stop
```

**注意**：`max_tokens_override` 同时参与截断判定——Pro 若恰好打到 131,072 会被标 `finish_reason=length`（这正是期望行为）；其余模型仍按 16,000 判定。

**留待观察**：Pro 的真实上限仍未知（官方 384K、已实测 135K）。若后续跑出 >131,072 的样本，把 `max_tokens_override` 的数值往上调即可。

### 4.0.67 模型上下文标注改为各模型官方输入上限（2026-11-25 用户要求）

**问题**：上游 `model_list` 给所有模型都标 `context_window = 116000`、`prompt_max_tokens = 100000`，而实测可容纳 1,048,576 tokens。116k 完全不可信，DSH 点「获取可用模型」时还会把窗口冲回 116k。

**改动**

| 位置 | 内容 |
|---|---|
| `server.cjs` | `/v1/models` 的 `prompt_max_tokens` 也支持覆盖（此前只有 `context_window` 可覆盖） |
| `data/config.json` | `context_window_override` / `prompt_max_tokens_override` 写入 11 个模型的**官方输入上限** |

覆盖表（依据官方文档 / 可查证资料）：

| 模型 | 输入上限 | 依据 |
|---|---|---|
| DeepSeek-V4-Pro | 1,048,576 | DeepSeek 官方 docs：CONTEXT LENGTH 1M |
| DeepSeek-V4-Flash | 1,048,576 | 同上 |
| qwen-3.6-plus | 1,048,576 | 阿里云百炼：1M |
| Doubao-Seed-Code | 262,144 | 火山方舟 Seed-Code 256K（我们实测 258,861 tokens 通过） |
| Doubao-Seed-2.0-Code | 262,144 | 同代 256K |
| glm-5 / glm-5.1 / glm-5v-turbo | 204,800 | 智谱 GLM-5 系列 200K |
| kimi-k2.6 | 256,144 | Moonshot Kimi K2.6 |
| minimax-m2.5 / m2.7 | 204,800 | MiniMax M2.x 204,800 |

**验证**（重启后 `GET /v1/models`）

```
DeepSeek-V4-Flash / V4-Pro / qwen-3.6-plus   context_window=1048576  prompt_max_tokens=1048576
Doubao-Seed-Code / 2.0-Code                  context_window=262144   prompt_max_tokens=262144
glm-5 / 5.1 / 5v-turbo, minimax-m2.5 / m2.7  context_window=204800   prompt_max_tokens=204800
kimi-k2.6                                    context_window=256144   prompt_max_tokens=256144
max_tokens（输出）仍为上游声明的 16000      ← 未改，见下
```

**未改**：`max_tokens`（输出上限标注）仍是上游统一的 16,000。它同样失真——DeepSeek 官方给 V4-Pro 的 MAX OUTPUT 是 **384K**，我们实测单轮已到 **134,997**；但 Flash/qwen/glm 在这条通道上确实精确卡 16,000。要不要按模型分别标注，等用户确认。

**副作用（正面）**：DSH 用 `context_window` 决定何时压缩上下文，标注变大后不会再在 116k 就急着压缩。

### 4.0.66 追查 DeepSeek-V4-Pro 的真实输出上限 + 修正 cap 判定（2026-11-25 凌晨）

**问**：Pro 的输出上限是 48K、64K 还是更高？

**查证**

1. **声明值**：`data/models-cache.json` 里 11 个模型（含 Pro）都是 `max_tokens: 16000`，**没有**单独的"输出上限"字段；`context_window_size.default = 116000`、`features.context_windows.data.dev_context = 116000` 只是客户端显示口径。上游 `usage` 里也只有一个 `max_tokens: 116000`（那是上下文，不是输出）。
2. **实测（journal）**：

| 时间 | 场景 | 耗时 | 完成 tok | 思考 tok | finish |
|---|---|---|---|---|---|
| 19:32:32（11-24） | 用户真实任务，write 工具 | 548 s | **43,049** | 38,048 | tool_calls |
| 02:22:12（11-25） | 探针：write_file 写 20 章手册 | 322 s | 19,797 | 6,078 | tool_calls（4 次 write_file） |
| 02:22:59（11-25） | 探针：长文（20 章×2000 字） | 1,290 s | 16,709 | 708 | stop（模型自己收尾） |

⇒ **Pro 不是 16K**：单轮实测到过 **43,049**，即 **> 43K**。48K 未验证、64K 未验证——两次新探针都是**模型主动停笔**（finish=stop / tool_calls），没有撞上限。

**顺带修掉一个我自己引入的误判**：`capHit` 原用 `completion >= modelCap`，会把 Pro 的 16,709 / 19,797 / 43,049 全部误标成 `finish_reason=length`。已改为**精确等于**声明值才算截断：

```js
// 只有「恰好打到声明值」才算截断：DeepSeek-V4-Pro 实测能到 43,049，用 >= 会把它误标成 length。
const capHit = !!(usage && modelCap > 0 && Number(usage.completion_tokens || 0) === modelCap);
```

**验证**：生产日志出现 `[cap] DeepSeek-V4-Flash completion=16000 达到声明上限 16000，标记 length`，journal 该条 `finishReason=length`、状态 `empty_content`；Pro 的 16,709/19,797 两条未被标记。

**探针期间的临时改动均已回滚**：`idle_timeout_ms` 曾临时抬到 1,800,000 便于长文跑完，现已回到 **240000**；`reasoning_abort_chars` 保持 **0（关闭）**。

### 4.0.65 关闭思考看门狗（reasoning_abort_chars = 0）（2026-11-25 用户要求）

用户要求先关掉 4.0.64 里打开的思考掐断重试。

- `data/config.json`：`reasoning_abort_chars` 由 `12000` → **0**（0 或未配置即关闭；代码里阈值 `<= 0` 时直接不启用，且不会被 `max_tokens` 反推回来）。
- 4.0.64 的另一半改动 **保留**：打满模型声明上限时 `finish_reason='length'` + 审计状态 `truncated_output` + 日志 `[cap]`。

**复核**

```
reasoning_abort_chars = 0（关闭）
idle_timeout_ms       = 240000
stream_keepalive_ms   = 15000
warmup_chat           = true
healthz               connected=true
流式冒烟 qwen-3.6-plus 10 s finish=stop 正文 206 字符 思考 414 字符
日志无 reasoning-abort 记录
```

### 4.0.64 glm / qwen 输出截断的两个成因与处置（2026-11-24 深夜）

**现象**：用户切到 glm 与 qwen 后，两条都因输出过长被截断。

**证据**（`/api/requests` 实录）

| 时间 | 模型 | 耗时 | 完成 tok | 思考 tok | 状态 | finish |
|---|---|---|---|---|---|---|
| 00:31:20 | glm-5v-turbo | 771.5 s | 16,000 | **16,000** | `empty_content` | stop |
| 00:19:33 | glm-5v-turbo | 744.5 s | 16,000 | **16,000** | `empty_content` | stop |
| 00:09:40 | glm-5v-turbo | 644.1 s | 16,000 | **16,000** | `empty_content` | stop |
| 23:54:14 | qwen-3.6-plus | 392.7 s | 16,000 | **16,000** | `empty_content` | stop |
| 23:13:38 | qwen-3.6-plus | 456.2 s | 16,000 | 645 | ok ← **正文被截在 16k 上限，却报 ok** |

两个成因：

1. **思考与正文共享 16k 预算**：glm/qwen 在长任务上把 16,000 全用于 reasoning（16,000/16,000）→ 正文 0 字符，客户端看到"什么都没有"。
2. **打满上限仍报 `ok`**：23:13 那条 reasoning 只用了 645，正文吃满 16,000 后平台正常 stop，网关照原样报 `finish_reason: stop` —— 客户端不知道这是截断，不会续写。

**处置**

| 改动 | 位置 | 说明 |
|---|---|---|
| `reasoning_abort_chars: 12000`（生产已设） | `data/config.json` | 思考超 12,000 字符且尚无正文 → 掐断并用"禁止长篇推理、立刻产出"的纠偏提示重试一次（代码早已实现，此前默认 0 关闭） |
| 打满上限标 `length` | `server.cjs` | `modelCap` 取自模型缓存里的 `max_tokens`（11 个模型均 16000）；`completion_tokens >= modelCap` 时 `finish_reason='length'`、审计状态 `truncated_output`、日志 `[cap] …` |

**过程事故（已修复）**：首次打补丁把 `capHit` 放在 `const usage` 之前，触发 `Cannot access 'usage' before initialization`，16:39 那条流式请求失败；已把该段移到 `usage` 之后，并实测两条路径：

```
json    Doubao-Seed-Code  HTTP200 finish=stop
stream  glm-5v-turbo      11 s  finish=stop  正文 600 字符  思考 1,290 字符  完成 553 tok
```

**未做**：`reasoning_abort` 与 `capHit` 都还没有在"真打满 16k"的请求上复现验证（需要先把预算烧到 16,000）；下次命中时日志会分别出现 `[reasoning-abort]` 与 `[cap]`。

### 4.0.63 空闲看门狗阈值改为可配置（默认仍 600s，生产用 240s）（2026-11-24）

**触发**：用户反馈 22:37 左右的请求"又卡死了"。查证结果：

| 时间 | 模型 | 耗时 | 状态 | 完成/思考 token | 思考字符事件 | 工具 |
|---|---|---|---|---|---|---|
| 22:42:43 | Doubao-Seed-2.0-Code | **689,950 ms（11.5 分钟）** | `idle_timeout` | 6,187 / **6,062** | **0（一条都没有）** | 无 |
| 22:22:37 | DeepSeek-V4-Pro | 60,523 ms | ok | 910 / 678 | 8,327 | 无 |
| 22:21:01 | DeepSeek-V4-Pro | 188,342 ms | tool_calls | 4,673 / 4,481 | 51,976 | grep |
| 22:17:07 | DeepSeek-V4-Pro | 392,957 ms | tool_calls | 324 / 298 | 80,144 | read |

网关日志：

```
[14:42:09] [toolcall] 早公告 working_directory（265827ms）      ← 另一条流沉默 4.4 分钟后才出第一个 CALL
[14:42:43] [watchdog] 连续 600000ms 无上游事件，判空闲超时（已收到过事件的时间跨度 689948ms）
[14:42:43] [timeout] 上游连续无输出已超过看门狗阈值，连接已断开
```

**结论**：这次不是 CALL 参数太长，而是**上游整条请求零事件**——usage 显示生成了 6,062 个思考 token，但 aiserver 从未推送 `plan_item`，网关没有可转发的内容；4.0.62 的空帧保活让客户端不再报 300 秒空闲超时，所以表现成"静默卡死"，最后被网关看门狗兜底断开。

**改动**：`lib/trae.cjs` 的空闲阈值从硬编码 600000 改为
`process.env.TRAE2API_IDLE_TIMEOUT_MS || cfg.idle_timeout_ms || 600000`；
生产 `data/config.json` 设 `idle_timeout_ms: 240000`（4 分钟）。

**效果**：零事件的死等从 11.5 分钟缩短到 4 分钟；有事件在流的长请求不受影响（阈值基于"连续无事件"，不是总时长）。

**验证**：重启后 healthz connected=true，自检请求 HTTP200。

### 4.0.62 修客户端 `pi-ai stream idle timeout`：静默期发空 delta 真帧（2026-11-24）

**报错**：客户端（DSH/pi-ai）报 `pi-ai stream idle timeout after 300000ms`。

**根因定位**（代码级）：

| 环节 | 事实 |
|---|---|
| 报错出处 | `@deepseek-ai/dsh-llm-pi-ai/lib/index.js:2051`：`if (timeoutOf(watchdog.signal, "LLM_STREAM_IDLE_TIMEOUT") !== void 0) throw new LlmError('pi-ai stream idle timeout after …')` |
| 看门狗实现 | `@deepseek-ai/dsh-timeout` 的 `idleWatchdog`：每次 `next(iterator)` 重新计时，**只有解析到 chunk 才重置** |
| 关键结论 | 网关原来发的 SSE 注释 `: ping` **不会**产生 chunk → 对 pi-ai 的看门狗完全无效 |
| 300000 的来源 | pi-ai 适配层默认 `DEFAULT_STREAM_IDLE_TIMEOUT_MS = 3e5`；本机 profile 只给 `trae2api` 设了 `streamIdleTimeoutMs: 900000`，所以报 300000 的那次请求走的是**没有覆盖**的 provider |

**与 CALL 的关系**：CALL 生成期网关按设计丢弃正文（`toolMode`），若模型生成很长的参数（写大文件）或长时间思考且没有 reasoning 增量，这段时间就是**零 chunk**；超过客户端阈值（300s）即报错。4.0.60 的早公告把这段从 12.9s 降到 0.2s，但参数生成本身仍可能很长。

**改动**（`server.cjs`）：流式心跳由「15s 注释」改为「每秒检查、静默超 `stream_keepalive_ms`（默认 20000，生产设 15000）就发一个 `delta: {}` 空 chunk」。
空 delta 是合法 chunk，客户端忽略内容但会重置看门狗；原注释心跳保留为低频兜底。

**实测**（把阈值临时调到 2000ms 便于观测）：

```
事件总数 30：空delta=13  思考=13  正文=1  tool_calls=1
最大帧间隔 2,803ms（改前同类静默 12,864ms 内零帧）
工具调用完整性：arguments 合法 JSON、finish=tool_calls，空帧被正确忽略
```

**配置**：`stream_keepalive_ms`（默认 20000，生产 15000）。

### 4.0.61 工具提示词加【通道事实】：CALL 是正文文本协议，不是原生工具（2026-11-24）

**由来**：模型自述「之前我把 CALL 当成了可调用的工具，实际上 CALL 行是要写在我回答正文里的文本协议」。这说明原提示词「你现在可以使用【外部工具】…需要工具时，在回答里写一行」留有歧义：没讲清"本通道没有原生工具通道"。

**改动**（`lib/tools-bridge.cjs`，`style !== legacy` 时注入，紧跟首句之后）：

```
【通道事实（先读这条，避免误判）】
本通道**没有原生工具调用能力**：你不会收到原生 tools 通道，也不能"直接点击/调用"任何工具。
工具在这里是一份**文本协议**：你在**回答正文里**写一行 `CALL 工具名 {参数JSON}`，
网关读到这一行才会真的替你执行，并把结果作为下一条消息返回。
也就是说：CALL 不是"调用工具的动作"，而是"你写在正文里的申请文本"；不写出这行文本，就什么都不会发生。
```

**改前基线（实测，客户端视角看是否返回 tool_calls）**

| 场景 | 模型 | 结果 |
|---|---|---|
| 普通请求（要读一个文件） | Doubao-Seed-Code | **5/5** 发 CALL，参数合法 |
| 普通请求 | qwen-3.6-plus | **5/5** |
| 对抗系统提示（`You are in Chat Mode (read-only). You have no tools…`） | qwen-3.6-plus | **5/5**（原「指令优先关系」段已生效） |
| 同上 | Doubao-Seed-Code | **3/3** |

**改后回归**：普通请求 3/3、对抗系统提示 3/3，未出现"我无法调用工具"类表述。
说明：现有提示词在这些场景本来就没问题，本段是**给模型的显式定论**，减少它每轮重新裁定（省思考、降低跑偏概率）。

**默认行为**：无需任何配置，只要请求带 `tools` 就注入（实测默认/`aligned` 都含，长度 1579 字符）；只有把 `instruction_style` 设成 `legacy`，或提供 `data/prompt.md` 整体替换内置文本时才不含这一段。

**给用户的话术（可直接粘进对话）**

> 提醒：本通道没有原生工具调用能力。CALL 不是"点击工具"，而是你要写在回答正文里的文本申请：
> `CALL <工具名> {参数JSON}`
> 网关读到这一行才会执行。请直接把 CALL 写出来，不要声明"我无法调用工具"，也不要只在正文里描述你要做什么。

### 4.0.60 修「生成 CALL 期间完全没输出」：工具调用提前公告（2026-11-24）

**现象**：用户反馈流式对话中途会"卡住没有输出"。

**定位**：不是网络、不是思考，而是**正在生成 CALL 行**。网关照设计在检测到行首 CALL 后把正文全部丢弃，等工具参数生成完才在流尾一次性发 `tool_calls`：

```js
// 改前：检测到 CALL → 丢弃后续正文，直到流尾才发 tool_calls
if (m >= 0) { ...; toolMode = true; holdBuf = ''; return; }
// 之后所有 content 增量：if (toolMode) return;
```

**实测（同一 prompt：让模型用 write_file 写约 1200 字）**：

| 指标 | 改前 | 改后 |
|---|---|---|
| 最后一条可见内容 | 3,649 ms | 3,339 ms |
| 首个 `tool_calls` 帧 | **16,513 ms** | **3,573 ms** |
| **静默时长** | **12,864 ms** | **234 ms** |
| 心跳 | 15 秒一次 `: ping`（12.9 秒静默里最多一条） | 同左 |

**改动**（`server.cjs`）：

1. 检测到 CALL 行时立即发一个**只含 name** 的 `tool_calls` 块（`arguments: ''`、独立 id），并把工具名写进日志 `[toolcall] 早公告 <name>（<ms>）`；
2. 流尾补发完整 `arguments`，沿用同一 id；**已公告过的调用不再重复发 name**（避免朴素客户端把 name 拼成两遍）；
3. 未检测到 CALL 的路径完全不变。

**验证**：

```
run1  首帧 tool_calls 28,834ms / 静默 0ms      name="write_file"  arguments 合法
run2  首帧 tool_calls  3,573ms / 静默 234ms    name="RunCommand"  arguments 合法
日志  [toolcall] 早公告 write_file（2052ms） / RunCommand（3565ms）
```

`arguments` 仍一次性整帧发送（历史教训：分片会让客户端拼出半截 JSON）。

**副作用**：客户端会先看到"正在调用 <工具名>"，随后参数到齐才真正执行——观感上从"卡死"变成"在调工具"。

### 4.0.59 恢复启动预热，并改成「有真实请求就不预热」（2026-11-24）

4.0.58 已撤回「预热致 agent 被杀」的归因，因此**预热恢复启用**（`warmup_chat` 默认 `true`，生产同值）。同时做两点收敛：

| 改动 | 说明 |
|---|---|
| 空闲判断 | 预热 chat 启动前检查 `trae.stats.requests > 0`：启动后已经有真实对话，就不再重复焐热（日志 `[boot] 聊天预热跳过：启动后已有真实请求，链路已被焐热`） |
| 注释更正 | 原注释写「健康检查超时后会重启 ai-agent」，已按 4.0.58 的结论改正 |

**实测**（生产 16:49 重启后）：
```
[08:49:36.264] [boot] 模型目录预热…
[08:49:36.981] [timing] create_chat_session 41ms        ← 预热 chat 建会话
[08:50:07.199] [timing] send_message 30259ms            ← 预热 chat 完成（本次 30.3s；历史样本 55.6~55.8s）
[08:50:10.551] [timing] send_message 32042ms            ← 同时段的真实请求，未受影响
```
→ 预热与真实请求可并发，预热耗时在 30–56 秒区间波动。

### 4.0.58 更正 4.0.57：「预热导致 ai-agent 被杀」不成立（2026-11-24）

4.0.57 曾把 agent 退出归因于「启动预热的 55 秒长任务 → aiserver 健康检查超时 → 重启 agent」。**复查后这条因果链被推翻**，此处更正。

把 aiserver 全部日志里的 agent 生命周期事件按时间排出来后：

```
2026-11-23 04:14:36  spawned, pid 9292
2026-11-23 04:14:57  health check failed: Error: Timeout
2026-11-23 04:15:14  health check failed: Error: Timeout
2026-11-23 04:15:26  is healthy and ready        ← 同一个 pid，超时后自己恢复了
2026-11-23 04:18:42  [新实例 15136] spawned, pid 2540
```

→ **健康检查超时不会杀 agent**。

修正后的模型：

| 事实 | 证据 |
|---|---|
| agent 与所属 aiserver 实例**同生命周期** | 每次 `ai-agent process spawned, pid: N` 都对应一个新的 aiserver 实例（日志目录名即实例启动时刻）；agent pid 在 15:36 / 15:40 / 15:48 / 15:52 各变一次，全部对应新实例 |
| 唯一一条退出记录伴随**重启** | `15:52:34 ai-agent process exit with code 4294967295, restarting...` 紧接着 `15:52:34 spawned, pid 9644`；而触发那次 kill 的是人工清理半死进程 |
| 长任务只让 ping 变慢，不致死 | 11-23 04:15 两次超时后，ping 响应 `cost: 26571ms / 9570ms / 43574ms` 才回来，随后 `is healthy and ready` |
| 15:46:18 那次**无定论** | aiserver（实例 14060）的日志在 **15:45:35** 就停止写入，比 agent 消失早 43 秒 —— 先坏的是 aiserver 侧；随后网关自愈杀掉 aiserver，日志丢失 |

`warmup_chat` 开关保留（运维旋钮），生产恢复默认 `true`（预热用于避免重启后第一句话撞 49 秒冷启动）。
仍未解决：15:46 那次「aiserver 先停止写日志、随后整条链路失能」的根因；`work\agent-exit-monitor.cjs` 会持续记录下次现场。

### 4.0.57 启动预热做成配置项 warmup_chat（2026-11-24）

- `server.cjs`：只有 `TRAE2API_WARMUP !== '0' && trae.cfg.warmup_chat !== false` 时才做 `model_list` + 一次极小 chat 的启动预热。
- 实测预热耗时：`[boot] 聊天链路预热完成 55605ms / 55755ms`（冷启动首次请求约 49 秒，预热就是为了让用户第一句话不打在冷启动上）。
- 归因结论见 4.0.58（本开关**不是**为了规避 agent 死亡）。

### 4.0.56 自愈门控（宽限期 + 连续坏次数）+ /api/status 暴露 uptime（2026-11-24）

原 `deploy/watch-runtime.cjs` 是「首次失败就动手」：网关刚起或链路抖一下，看护器立刻调 `/api/heal`，网关随即杀掉 aiserver；若新 aiserver 的 agent 没能马上绑上 socket，就进入反复重启。

| 文件 | 改动 |
|---|---|
| `server.cjs` | `/api/status` 新增 `bootedAt`、`uptimeMs` |
| `deploy/watch-runtime.cjs` | 新增纯函数 `shouldHeal({uptimeMs, badStreak, graceMs, minStreak, cooldownOk})`：**宽限期 90 秒内不自愈**、**连续 2 次异常**才自愈；被门控时日志写 `[heal] 暂缓（…）`；新增 `--grace-heal`、`--bad-streak`；主循环改 `main()` + `require.main` 守卫并导出 `shouldHeal` |
| `test-watcher-grace.cjs` | 新增，14 项 |

代价：真挂死时最多晚约 2 个探测周期（默认 2×5s）才自愈。

### 4.0.55 删掉 prompt token 估算与预算守卫（2026-11-24 用户决定）

用户选择「彻底去掉」：`estimatePromptTokens()` 及其全部派生逻辑删除。

**删掉的东西**

| 位置 | 内容 |
|---|---|
| `server.cjs` | `estimatePromptTokens()`（汉字 1 token/字 + 其它 4 字符/token + 8272 固定开销） |
| `server.cjs` | prompt 预算守卫整段：`prompt_budget_tokens` / `prompt_budget_action` / `prompt_overhead_tokens` 三个配置、`[guard]` 日志、`x-trae-prompt-estimated-tokens` / `x-trae-prompt-budget` 响应头、`block` 模式下的 413 |
| `server.cjs` | `diagnoseEmpty()` 里基于估算的两档归因（≥90 万「接近上限」/ 低于「可排除超限」），只保留「上游明确报错」与一个通用兜底 |
| `server.cjs` | 请求审计里的 `estPromptTokens` / `overBudget` 字段（journal 与 `/api/requests`） |
| `public/index.html` | 请求表里的「⚠️ 超预算」标记（tokens 列仍是上游**真实** usage） |
| `config.example.json` | 上面三个预算键 |

**不受影响**：请求内容、模型解析、锚点、CALL 桥、思考回填、上下文压缩，以及 token 计费（真实 usage 一直来自上游并原样透传）。

**代价（已与用户确认过）**：失去三样可观测性 —— 面板 ⚠️ 标记、journal 的估算字段、日志里的 `[guard]`/`[empty] … estPromptTokens=…`；空回答不再区分「接近上限」与「远低于上限」，统一给三条常见原因。

删前实测（同一公式与上游真实 usage 对比）：纯中文 +12%、纯英文 +2%、中英混合 −4%，说明删掉的不是精度问题，而是「阈值按 1M 设、对 26 万就撞墙的模型永远来不及触发」这个设计问题；真需要提前预警时应改成**按模型设阈值**。
### 4.0.54 锚点改为专用空目录 + workspace_check 改 warn（2026-11-24）

用户决定做两件事：

1. **上游锚点换成部署目录下的专用空目录**，不再指向整个工作区根：

```json
// data/config.json（本机，未入库）
"workspace_folder": "D:/Users/Administrator/Documents/deepseek-harness/work/trae2api-workspace"
```

- 网关启动时自动 `mkdir -p`（`server.cjs:236`），实测目录存在且**为空**；
- 换锚点等于换上游项目（`biz_project_id = md5(path)`），因此同时清掉旧的 `local_project_id` / `probe_project_id`，
  重启后自动重建：`[trae] local_project_id=6b05320a7c7e738251327cbe`；
- 留了回退键：`_prev_workspace_folder`、`_prev_local_project_id`（配置备份 `data/config.json.bak-ws-anchor-20261124`）。

2. **`workspace_check` 从 `error` 改成 `warn`**：客户端声明的目录不存在时不再返回 400，只在响应头与日志留痕。

**实测（bg1 生产，改完即验）**：

| 情形 | 改前（error） | 改后（warn） |
|---|---|---|
| 声明不存在的目录 `D:/tmp/no-such-dir-xyz-9911` | **HTTP 400** `invalid_workspace` / `not-found` | **HTTP 200**，响应头 `x-trae-workspace-check: not-found`，日志 `[ws-check] not-found: … action=warn` |
| 声明真实目录 `…/github` | 200 `ok` | 200 `ok` |
| 没有声明 | 200（不校验） | 200（不校验） |
| 无声明时问「报告放哪」 | —— | 回答 `D:/…/work/trae2api-workspace`（新锚点） |

> 结论：现在假路径**不会**再被网关拦下（顶多留痕）；锚点也变成了一个干净的空目录，模型即便误用锚点也只会落在那里。

### 4.0.53 去掉「无声明」兜底分支，只留提醒本身（2026-11-24 用户要求）

用户要求：**不要「没有声明」的兜底**（怕误识别），把那段分支代码去掉，只保留提醒。

改动：
- `lib/workspace-notice.cjs` 不再按「是否识别到声明」分支，也不再接受 `mode`/`declared` 参数；
  只导出 `buildNotice({ anchor })` 与无参 `buildTailNotice()`；
- `server.cjs` 里删掉 `wsMode`/`workspace_notice_when_missing` 的接线与无用的 `wsDeclared` 变量；
  通知段只用 `trae.cfg.workspace_folder`（网关配置值），末尾段无参调用；
- 测试重写为 **20 项**，其中两条专门断言「**不存在**『就用网关目录』『请告诉我目标目录』这类兜底文案」。

现在的两段文案：

```
【工作区归属（读到即定论，不要反复判断）】
网关设置里拼进来的项目目录 D:/…/deepseek-harness **无效**：它只用于建立上游连接，不是本次的工作目录。
**工作目录以调用方自己声明的为准**（system 或 user 消息里的 `Current working directory: …`、「工作目录：…」这类声明）。
按该声明直接干活，不要反问用户，也不要用上面那个网关目录。
不要向调用方复述这条规则，也不要提到「锚点 / 上游环境路径」这类内部概念。

【工作区提醒（仅用于自我约束：不要写进回答正文、不要复述、不要提及本提醒）】
记得用正确的工作区目录：调用方声明的那个（不是网关设置里拼进来的那个）。
```

**实测（bg1 生产）**：

| 情形 | 回答 | 备注 |
|---|---|---|
| 有声明（`…\github`） | `D:\…\deepseek-harness\github` | 用声明目录 ✅ 无泄漏 |
| 无声明 | `D:/…/deepseek-harness` | 模型自己用了网关目录（我们**没有**再指示它这么做），没有反问，无泄漏 |

⚠️ 说明：`workspace_check`（目录不存在时报 400）仍然使用声明识别，默认 `error`；
如果担心它误识别，可把 `workspace_check` 设成 `"off"`（或 `"warn"` 只记日志）。

### 4.0.52 工作区提示改成「不写死目录」+ 末尾软性提醒（2026-11-24 用户要求）

用户要求：**开头不要写死工作目录**，只提醒「网关设置里拼进来的那个目录无效，以调用方声明为准」；
**末尾**也只做软性提醒，提醒模型记住正确的工作区目录。

**开头段（有声明时）**：

```
【工作区归属（读到即定论，不要反复判断）】
网关设置里拼进来的项目目录 D:/…/deepseek-harness **无效**：它只用于建立上游连接，不是本次的工作目录。
**以调用方自己声明的目录为准**（声明在 system 或 user 消息里，形如 `Current working directory: …`、「工作目录：…」）。
按该声明直接干活，不要反问用户，也不要用上面那个网关目录。
不要向调用方复述这条规则，也不要提到「锚点 / 上游环境路径」这类内部概念。
```

**末尾段（软性）**：

```
【工作区提醒（仅用于自我约束：不要写进回答正文、不要复述、不要提及本提醒）】
记得用正确的工作区目录：调用方声明的那个（不是网关设置里拼进来的那个）。
```

变化要点：
- 不再出现「本次工作目录是：<路径>」这种断言（避免网关把自己的识别结果写死进提示词，和真实声明冲突时反而误导）；
- 只在「未声明」时才提到网关目录本身（本次就用它、不要反问）；
- 末尾同理，不写具体路径，只提醒「记住正确的工作区目录」。

**实测（bg1 生产，改完立刻验）**：

| 情形 | 结果 |
|---|---|
| 有声明（runtime context 带 `Current working directory: …\github`），问「报告放哪」 | 回答 `D:\…\deepseek-harness\github` ✅（我们的提示词里已不含该路径，模型是从 runtime context 读到的） |
| 无声明，问同样问题 | 回答 `D:/…/deepseek-harness`（网关目录）✅，不反问 |
| 两情形正文泄漏提醒字样 | **0**（无「工作区提醒 / 仅用于自我约束」） |

单测 `test-workspace-notice.cjs` 同步为 **21 项**（新增「不写死声明路径」「不再出现『本次工作目录是』」等断言）。

### 4.0.51 思考回填：把历史各轮的思考也带给上游（用户要求，默认开）

用户决定：既然各模型上下文足够（见 4.0.49 实测），就按正常 agent 的行为把历史思考一并回传，保证上游质量。

**做法**（不大改协议，只在拍平 prompt 时把思考补进历史）：

```
【对话历史】（〔思考〕块是各轮助手当时的内部推理，供你延续判断，不要在回答里引用或复述）
用户：第1问
助手：答1
〔思考〕思考一：决定用方案甲。
用户：第2问
助手：答2
〔思考〕思考二：改为方案乙。
…
<当前用户消息>
```

实现：`lib/trae.cjs::flattenMessages(messages, extraSystem, opts)`，读取客户端回传的思考（`reasoning_content` / `reasoning` / `reasoning_text` 三个字段名都认）。

**配置**（`data/config.json`，改完重启网关）：

| 键 | 默认 | 作用 |
|---|---|---|
| `reasoning_context` | `"all"` | `off` 关；`last` 只带最近一轮；`all` 历史全带 |
| `reasoning_context_max_chars` | `0` | 单轮截断上限（0=不限） |
| `reasoning_context_total_max_chars` | `0` | 思考总量上限（0=不限；超限时**优先保留最近几轮**，丢弃较早的） |

**实测（bg1 生产）**：

| 场景 | 结果 |
|---|---|
| 约束只写在思考里（`reasoning_content`），下一轮问确认 | **现在遵守**（回答以「遵命」开头）；改动前同样问法是「完全看不到」 |
| 日志 | `[rzn] 模式=all 历史思考字符=34 prompt字符=293` |
| CALL 工具协议 | 不受影响：`tool_calls=["write_file {…}"]`（7.1 s，HTTP200） |
| 延迟 | 4 轮 × 每轮思考 200 字 → HTTP200 6.6 s（prompt_tokens 10,215）；8 轮 × 200 字 → 300 s 超时（当次上游长尾，需继续观测） |
| 单测 | `test-reasoning-context.cjs` **18 项**（off/all/last、三个字段名、单轮截断、总量上限优先级、无思考时不加多余说明） |

**注意**：思考回填会让 prompt 体积按会话积累增长（实测本会话思考是正文的 31 倍），
建议配合 DSH 的 `contextWindow`（按模型设，见 4.0.49）与总量上限一起用；要回退就设 `reasoning_context: "off"`。



### 4.0.4 确认部署是否跟上了仓库

多机部署时，逐文件比 hash 不可靠（发布仓库是脱敏副本，注释/路径不同也会不一致）。用特征自检：

```powershell
node deploy\check-version.cjs --dir D:\apps\trae2api     # 逐项 ✓/✗ + 缺失清单
```

覆盖 23 项特征：20107 探测、登录写缓存、ACL 收紧与自愈、空结果归因、工具块预算、
自带内核、一次性登录 profile、面板状态分档、start-runtime、给 AI 的部署文档、回归测试等。
退出码 0 = 全部具备。

### 4.0.3 凭据文件的权限（别把自己锁在外面）

`data/token-cache.json`、`data/client-secret.txt`、`data/safekey.bin` 三个文件写入后会收紧 ACL：
**去掉继承**，只授 **SYSTEM / Administrators / 运行网关的那个用户**（内置主体按 SID 表达，避免非英文系统名称差异）。

> 曾经踩过的坑：只授 `Administrators+SYSTEM`，而网关以普通用户身份运行时，
> 会读不到自己刚写的缓存 → `hasCreds=false`、`/v1/models` 500。

加固措施（都有回归测试）：

- 收紧后**回读自检**，读不到只打日志，不静默失败；
- `_loadTokenCache()` 遇到 `EPERM`/`EACCES` 会**自动补授当前用户并重试一次**（老版本留下的坏 ACL 文件升级后自愈）；
- 同时清理该文件上针对上述主体的显式 `deny` ACE。

如果手工修过权限，等同效果的一条命令：

```powershell
icacls data\token-cache.json /inheritance:r /grant:r "$env:USERNAME:F" "*S-1-5-18:F" "*S-1-5-32-544:F"
```

### 4.0.2 运行时没起来怎么办（自定义布局必看）

网关和运行时可以分开放：网关在 `D:\apps\trae2api`，运行时根在 `D:\apps\trae2api-runtime`。
这种情况下只起网关不会自动带上运行时，面板会显示 **IPC 断开 / 套接字 —**。

```powershell
pwsh -NoProfile -File start-runtime.ps1                      # 自动找运行时根并后台起看护
pwsh -NoProfile -File start-runtime.ps1 -Foreground          # 前台跑，直接看日志
pwsh -NoProfile -File start-runtime.ps1 -Root D:\apps\trae2api-runtime
```

它会：定位运行时根（`-Root` → 环境变量 `TRAE2API_ROOT` → `deploy.json` 的 `root` → 同目录 `runtime`）
→ **确认没有第二个 aiserver**（双实例是最难查的故障）→ 起看护 `deploy/watch-runtime.cjs`（旧机器上若还留着 `supervise.ps1`，先用它跑一次再换成看护器） → 等 `aha\aha\vscode_ai_agent_*.sock`
→ 探 `/healthz` 直到 `connected:true`，并给出失败时的排查指引。

另外 `start-trae2api.ps1` 启动时也会**自动**检查并拉起运行时（不需要就加 `-NoRuntime`）。

### 4.0.1 自带浏览器内核（推荐，双端一致）

面板内登录要真实像素渲染（截图抓二维码 + 面板实时画面），所以只能是 Chromium 家族；
但**不依赖用户机器上装了什么浏览器**：可以按需下载一份 `chrome-headless-shell`（Chromium 的无 UI 变体）。

```bash
node deploy/fetch-browser.cjs            # 装到 <仓库>/runtime/browser/（自动取 CfT 稳定版）
node deploy/fetch-browser.cjs --status   # 看已装的内核与自检结果
node deploy/fetch-browser.cjs --force    # 强制重装
```

| 平台 | 下载 | 装好占盘 | 备注 |
|---|---|---|---|
| Windows x64 | 122 MB | 234 MB | 裁剪掉 locales（只留 en-US）与 SwiftShader |
| Linux x64 | 126 MB | 228 MB | **仍需系统库**，见下 |

下载源：npmmirror（国内快）→ 官方 `storage.googleapis.com` 自动回退；解包后跑 `--version` 自检，
Linux 缺库会把要装的包名和 `apt-get` 命令直接打出来（Ubuntu 实测这行够用）：

```bash
sudo apt-get install -y libnss3 libnspr4 libasound2t64 libatk1.0-0t64 libatk-bridge2.0-0t64 \
  libatspi2.0-0t64 libcups2t64 libdrm2 libgbm1 libxkbcommon0 libxcomposite1 libxdamage1 \
  libxfixes3 libxrandr2 libpango-1.0-0 libcairo2
```

网关选择顺序：`TRAE_LOGIN_BROWSER`/`CDP_EXE` → `<仓库>/runtime/browser/**/chrome-headless-shell*`
→ 系统 Edge/Chrome/Chromium。相关环境变量：

| 变量 | 作用 |
|---|---|
| `TRAE2API_BROWSER_DIR` | 自带内核的根目录（默认 `<仓库>/runtime/browser`） |
| `TRAE_LOGIN_BROWSER` | 直接指定浏览器 exe（优先级最高） |
| `TRAE_LOGIN_NO_SANDBOX=1` | 强制加 `--no-sandbox`（Linux root/容器里通常自动加） |

> 实测（2026-11-22）：Windows 与 WSL（无系统 chromium）两边都能在 0.7–1.2 秒内启动内核，
> 打开真实登录页（跳转 `accounts.doubao.com` SSO）并抓到 324×324 的二维码 PNG。

### 4.0 登录用的浏览器配置（一次性，默认不残留）

面板内登录会拉起无头 Edge。**浏览器配置目录默认是一次性的**：每次登录用系统临时目录里的独立 profile，
登录结束（成功 / 失败 / 取消）后立即删除，不会把上一次的登录态（cookie、localStorage）带给下一次。

| 环境变量 | 行为 |
|---|---|
| 不设置（默认） | 一次性 profile（`%TEMP%\trae2api-login-<pid>-<ts>`），结束即删；**不接管**已开的浏览器 |
| `TRAE_LOGIN_KEEP_PROFILE=1` | 持久用 `data/login-profile`（省约 20 秒冷启动），但每次登录前会清掉 trae.cn / trae.com.cn / doubao 的站点数据 |
| `TRAE_LOGIN_PROFILE=<dir>` | 完全自定义持久目录，**不清**站点数据（你自己管） |
| `TRAE_LOGIN_KEEP_COOKIES=1` | 与 `KEEP_PROFILE=1` 搭配时也不清站点数据（= 有意继承上次登录态） |
| `TRAE_LOGIN_ATTACH=1` / `0` | 强制允许 / 禁止接管已开的登录浏览器（默认：仅持久 profile 模式允许） |
| `TRAE_LOGIN_CDP_PORT` | 调试端口，默认 9333 |
| `TRAE_LOGIN_BROWSER` | 浏览器 exe 路径（默认 Edge，探测不到时用 Chrome） |

> 为什么默认改一次性：持久 profile 里是**完整会话 cookie**（`Default\Network\Cookies`），
> 换账号登录会直接落在上一个账号的登录态上，多人共用同一部署时也等于把会话交出去。



启动后打开面板 `http://<host>:<port>/`，输入 `panel_password`，进「凭据」页：

- **面板内登录（推荐）**：网关在后台用无头浏览器打开真实登录页，面板右侧实时显示画面；可以 **扫码**，也可以填 **手机号 + 短信验证码**。
- 登录成功后凭据写入运行时 profile（`<root>\profile\.trae-runtime\jwt.txt`），网关会让 aiserver 重启（约 15–20 秒，看护脚本自动拉起）后生效。

之后凭据 **每 24 小时自动续期**一次（`creds_auto_renew_hours` 可调，设 0 关闭）：

- JWT 有效期 **14 天**、refresh token **180 天**，每次续期两者都会换成新的（滑动续期，永不自然到期）；
- 续期失败保留旧凭据、记 `lastError`、1 小时后重试；
- 有在途流式请求时会推迟 5 分钟再续，避免打扰正在跑的任务；
- 面板「凭据」页可随时「立即续期」，显示上次/下次续期时间与自动续期次数。

---

## 5. 接口

| 端点 | 鉴权 | 说明 |
|---|---|---|
| `GET /v1/models` | Bearer | 模型列表（OpenAI 格式），字段见下表 |
| `POST /v1/chat/completions` | Bearer | 对话补全，支持 `stream` / `tools` / `tool_choice` |
| `GET /healthz` | 无 | 健康检查：`ok` + `connected` + **`checks`（通道/工作区/凭据三项自检）** |
| `GET /` | 面板会话 | 管理面板；未登录 302 → `/login?next=…` |
| `GET /login` · `GET /login.html` | 无 | 面板登录页 |
| `POST /api/login` | 无 | 换取会话 Cookie（同 IP 10 分钟内失败 10 次即 429） |
| `POST /api/logout` | 面板会话 | 注销 |

### 5.2 `/healthz` 的 `checks` 字段

`ok` 只表示「网关进程在跑」；`checks` 才是可判读的自检（外部监控可直接看这三项，不必再从一片红里猜原因）：

```json
{
  "ok": true,
  "connected": true,
  "version": "0.1.0",
  "checks": {
    "runtime":   { "ok": true, "connected": true, "socket": "ipc://…vscode_ai_agent_1.sock", "detail": "已连上上游" },
    "workspace": { "ok": true, "path": "D:/…/trae2api-workspace", "exists": true, "writable": null, "detail": "工作区可用" },
    "creds":     { "ok": true, "hasCreds": true, "lastError": null, "detail": "凭据就绪" },
    "ok": true
  }
}
```

判定逻辑在 `lib/health.cjs`（纯函数，`test-health-drop.cjs` 覆盖 14 种组合），常见 `detail`：

| 项 | 不通过时的 detail |
|---|---|
| `runtime` | 「没有可用的 aha socket（运行时未启动？）」/「有 socket 但未连上（死 socket / 运行时已退出）」 |
| `workspace` | 「未配置 workspace_folder」/「目录不存在（上游会报 992501）」/「不可写」 |
| `creds` | 「没有可用凭据（面板「凭据」→ 立即续期 / 面板内登录）」/「有凭据但最近有续期错误：…」 |

---
### 5.1 `/v1/models` 返回字段

每个模型除了 `id` / `display_name` / `multimodal` / `is_beta` / `max_turns`，还下发容量（**已按 §6 的覆盖表换成真实值，不再是上游那个 116000**）：

| 字段 | 含义 |
|---|---|
| `context_window` / `context_length` / `max_input_tokens` | 上下文窗口（同一数值，下三种别名是给不同客户端认的） |
| `prompt_max_tokens` | 输入预算 |
| `max_tokens` / `max_output_tokens` | 输出上限 |
| `limit` | `{ "context": …, "output": … }`（LiteLLM 风格） |
| `max_tokens_note` | 可选备注（例如 DeepSeek-V4-Pro 标 128K、注明官方 384K） |

> 为什么要给三种别名：DSH 读 `context_window` / `context_length`，Cline/Roo 读 `context_length`，LiteLLM 风格读 `limit.*`。
> 少给一份，客户端就退回自己的默认值（表现为「获取可用模型」后窗口又变回 116K）。
> 面板「总览 → 模型（实时目录）」显示的就是同一份数值（`/api/status` 与 `/v1/models` 共用 `modelCapacity()`）。

调用示例：

```bash
curl http://127.0.0.1:18790/v1/chat/completions \
  -H "Authorization: Bearer <api_key>" -H "Content-Type: application/json" \
  -d '{"model":"qwen-3.6-plus","messages":[{"role":"user","content":"你好"}]}'
```

面板 API（除 `login/logout` 外都需要面板会话；本机回环访问免登录）：

| 端点 | 说明 |
|---|---|
| `GET /api/status` | 运行状态：通道 socket、凭据到期、统计、配置快照、各模型容量 |
| `GET /api/requests` | 请求日志（内存环形 + `data/requests.jsonl`），支持 `limit` / `status` 过滤 |
| `GET /api/errors` | 错误聚合 |
| `GET /api/logs` | 最近 200 行网关日志 |
| `GET/POST /api/settings` | 读/改设置（即时生效子集见 `docs/CONFIG.md` 第 3 节） |
| `POST /api/creds/refresh` | 立即续期凭据 |
| `POST /api/models/refresh` | 强制刷新模型目录 |
| `POST /api/playground` | 面板试聊（SSE） |
| `POST /api/heal` | 手动触发运行时自愈（含 inflight 保护） |
| `POST /api/shutdown` | 优雅停机（**仅回环地址**可用） |
| `POST /api/trae-login/{start,phone,code,finish,cancel}` | 面板内登录：开始 / 填手机号 / 填验证码 / 收尾 / 取消 |
| `GET /api/trae-login/{state,screen,page}` | 登录状态 / 实时截图 / 页面文本 |
| `GET /api/trae-login/open` | 另开窗口人工接管 |
| `POST /api/trae-login/refresh-token` | 直接用 refresh token 登录（应急） |


---

## 6. 配置项（`data/config.json`）

> **完整清单（50 个键 + 17 个环境变量 + 生效方式 + 校对脚本）见 [docs/CONFIG.md](docs/CONFIG.md)。**
> 这里只列最常改的；改完 `data/config.json` 需要**重启网关**（面板「设置」页改的那几项即时生效）。

**必填**（缺了/为空网关拒绝启动，见第 8.5 节）

| 键 | 说明 |
|---|---|
| `panel_password` | 面板登录口令，同时是 `/v1/*` 的 Bearer key |
| `api_key` | 可选，单独指定 API key；留空则等于 `panel_password` |

**常用**

| 键 | 默认 | 说明 |
|---|---|---|
| `workspace_folder` | 空（自动建 `~/trae2api-workspace`） | 上游项目锚点目录（不是模型的工作目录） |
| `agent_type` / `default_agent_type` | `chat` | `builder` 思考更短、重任务更快；示例配置里填 `builder` |
| `default_model` | 空 | 未指定 `model` 时用哪个；空则取模型目录第一个 |
| `creds_auto_renew_hours` | `24` | 自动续期间隔，`0` 关闭 |
| `native_ban` | `true` | 屏蔽平台原生工具声明（只允许走 CALL 协议） |
| `image_passthrough` | `true` | 图片落盘并告知路径（远程 URL 会拒内网地址，上限 `TRAE2API_IMAGE_MAX_MB=20`） |

**容量标注（让客户端拿到真实值）**

| 键 | 默认 | 说明 |
|---|---|---|
| `context_window_override` | `{}` | 按模型覆盖上下文窗口（上游一律标 116000，实测 1,048,576） |
| `prompt_max_tokens_override` | `{}` | 按模型覆盖输入预算（上游一律 100000） |
| `max_tokens_override` | `{}` | 按模型覆盖输出上限（上游一律 16000）；**同时决定截断判定** |
| `max_tokens_note` | `{}` | 按模型附加备注，随 `/v1/models` 下发 |

**流式与超时（长输出/「卡死」相关）**

| 键 | 默认 | 说明 |
|---|---|---|
| `idle_timeout_ms` | `600000` | 连续这么久**没有任何上游事件**才断开（生产用 240000）；有事件在流的长请求不受影响 |
| `stream_keepalive_ms` | `20000` | 静默时发 `delta:{}` 空帧（生产 15000），用于重置客户端空闲看门狗（SSE 注释不算 chunk） |
| `reasoning_abort_chars` | `0` | 思考超阈值且无正文 → 掐断重试一次；`0`=关闭（当前生产关闭） |
| `warmup_chat` | `true` | 启动后跑一次极小 chat 预热（`TRAE2API_WARMUP=0` 或 `false` 关闭） |

**高级 / 排障**

| 键 | 默认 | 说明 |
|---|---|---|
| `tool_schema_depth` | `3` | 工具参数 schema 展开深度 |
| `tool_block_budget` | `24000` | 工具说明字符预算 |
| `instruction_style` | `aligned` | `aligned`（默认）或 `legacy`（老的"输出前自检"措辞，不含【通道事实】段） |
| `undeclared_tool_mode` | `feedback` | 未声明工具名：回灌让模型改（默认）/ `strip` 丢弃 / `passthrough` 旧行为 |
| `undeclared_tool_retries` | `1` | 回灌次数上限（`0` = 等同 strip） |
| `tool_aliases` | `{}` | 模型自造名 → 已声明名 |
| `workspace_check` | `error` | `error` 拒绝 / `warn` 放行告警 / `off` 不校验 |
| `reasoning_context` | `all` | 历史思考回填：`off` / `last` / `all` |
| `runtime_heal` | `true` | 运行时挂死自动自愈总开关 |

**网关自动维护，别手改**：`local_project_id`、`local_project_id_tag`、`icube_language`、`version_code`、`plugin_channel`、`device_id`。

---

## 7. 测试

```bash
# 全部单测（main：26 个文件 464 个用例；feat/linux：27 个文件 479 个用例）
for f in test-*.cjs; do node "$f" || echo "FAIL $f"; done
```

| 文件 | 用例 | 覆盖内容 |
|---|---|---|
| `test-call-parse.cjs` | 23 | CALL 行解析 / JSON 修复 / 截断识别 |
| `test-tools-bridge.cjs` | 21 | 工具桥：schema 降级、预算、通道事实段 |
| `test-workspace-notice.cjs` | 20 | 【工作区归属】/【工作区提醒】两段提示词 |
| `test-workspace-declare.cjs` | 23 | 从 messages 里识别调用方声明的工作目录 |
| `test-workspace-check.cjs` | 17 | 目录存在/可写校验与 `error`/`warn`/`off` 三态 |
| `test-reasoning-context.cjs` | 18 | 历史思考回填 `off`/`last`/`all` 与上限 |
| `test-runtime-healer.cjs` | 19 | 自愈：失败权重、窗口、冷却、inflight 保护 |
| `test-watcher-grace.cjs` | 14 | 看护器宽限期/坏链判定（`shouldHeal`） |
| `test-model-alias.cjs` | 18 | 模型名解析：别名 / display_name / 未知拦截 |
| `test-aha-config.cjs` | 21 | aha 目录探测与配置应答 |
| `test-creds-acl.cjs` | 18 | 凭据文件 ACL（当前用户/去继承/deny 清理/自愈） |
| `test-panel-escape.cjs` | 10 | 面板转义（防存储型 XSS）+ 表格渲染 |
| `test-prompt-template.cjs` | 13 | 提示词模板拼装顺序 |
| `test-login-profile.cjs` | 9 | 登录浏览器配置（一次性/持久/接管门控） |
| `test-browser-pick.cjs` | 11 | 浏览器选择与启动参数 |
| `test-addon-resolve.cjs` | 5 | zmq addon 定位（自包含/环境变量） |
| `test-config-jsonc.cjs` | 14 | 配置 JSONC 容错（注释 / 尾逗号 / 坏 JSON 抛错）+ 示例文件完整性 |
| `test-platform-paths.cjs`（仅 feat/linux） | 8 | 平台路径归一化与 zmq addon 候选顺序 |
| `test-health-drop.cjs` | 18 | `/healthz` 三项自检（14 种组合）+ 断链时在飞 RPC 立即失败（4 项） |
| `test-tool-whitelist.cjs` | 28 | 工具名守卫：未声明识别 / 别名 / 大小写宽容 / 回灌文案 / 正文剔除 |
| `test-cookie.cjs` | 21 | 会话 Cookie：HTTPS 加 Secure、HTTP 不加、属性与登录/登出一致 |
| `test-silent-catch.cjs` | 3 | 静默 catch 棘轮闸门（新增空 catch 即失败） |
| `test-no-dead-code.cjs` | 4 | 死代码守卫：未用导入 / 未引用函数 / 无用导出 / 孤儿模块 |
| `test-no-conflict-markers.cjs` | 随仓库文件数变化（main 59 / feat/linux 65） | 全仓库无冲突标记 |

```bash
# 部署版本自检：逐项 ✓/✗ 看部署跟上仓库没有（退出码 0 = 全具备）
node deploy/check-version.cjs --dir <部署目录>

# 端到端（需要网关已启动、且运行时不被另一个网关占用）
node tools/verify-e2e.cjs 18790 <panel_password>
```


---

## 8. 常见问题

**Q：不装 VS Code 能跑吗？**
能。运行时全部来自你放的 VSIX；网关只依赖 Node.js ≥ 20 与 PowerShell 7。

**Q：面板打不开 / 提示未登录？**
面板需要口令；未登录访问任何页面都会 302 到 `/login?next=…`，登录后跳回原地址。本机回环访问免登录。

**Q：一直显示"未连接"？**
先看 `GET /healthz` 的 `checks`（它会直接说是通道、工作区还是凭据的问题），再看 `<root>\logs\aiserver.log` 与面板「总览」里的 socket；多半是运行时没起来，
执行 `pwsh -NoProfile -File deploy\bootstrap-runtime.ps1` 重新自举。卡住时杀掉 aiserver，看护脚本约 6 秒会重新拉起。

**Q：想换目录 / 换端口？**
跑 `deploy\setup.ps1 -Dir <新目录> -Port <新端口>`；或改 `deploy.json` 的 `root`/`port` 后重启。
`restart.ps1` 会读 `deploy.json`，不用改脚本。

**Q：能同时开两个网关指向同一个运行时吗？**
不能。运行时（ai-agent）只接受一个活跃网关，双跑会互相抢通道，表现为 `RPC 超时 model/model_list`、
`create_chat_session` 超时、对话返回空。换机/换目录时先停旧网关。

**Q：请求全部返回空内容？**
先看三种常见原因：① `workspace_folder` 指向的目录不存在（网关会自动创建，日志里有 `已创建工作区目录`）；
② 凭据失效 —— 面板「凭据」→「立即续期」，refresh token 也过期就用「面板内登录」重新扫码/收验证码；
③ 两个网关抢同一个运行时（见上一条）。

**Q：日志在哪？**
网关：`data/trae2api.log`（面板「错误汇总」也能看）；运行时：`<root>\logs\aiserver.log`、`<root>\logs\supervise.log`；
自举：`<root>\logs\bootstrap.log`。

**Q：客户端报 `pi-ai stream idle timeout after 300000ms`？**
客户端只看**真正的 chunk**，SSE 注释 `: ping` 不算。网关从 4.0.62 起在静默时发 `delta: {}` 空帧
（`stream_keepalive_ms`，默认 20 s），能重置这类看门狗。若仍报错，把该 provider 的
`streamIdleTimeoutMs` 调大（本机 DSH 里 trae2api 配的是 900000），或把 `stream_keepalive_ms` 调小。

**Q：界面长时间没有字出来，看着像「卡死」？**
先分清三件事：

| 现象 | 判据 | 处置 |
|---|---|---|
| 上游**零事件**（一段事件都没有） | `[watchdog] 连续 …ms 无上游事件` + journal 里 `status=idle_timeout`，且 `reasoningChars` 为空 | 偶发上游流式失效；`idle_timeout_ms`（生产 240 s）会兜底断开。要更快失败就把它调小 |
| 上游**一直在思考**（有 reasoning 增量） | journal `reasoningTokens` 很大、耗时很长但 `status=ok` | 正常。实测 DeepSeek-V4-Pro 单轮思考 25.7 分钟、输出 134,997 tokens（含思考） |
| 事件在流但客户端不渲染思考 | 面板「请求日志」有 reasoning 字符数，界面无字 | 客户端展示设置问题，不是网关 |

**Q：返回 `finish_reason: "length"` / 正文突然断在半句？**
说明打满了该模型在本通道的输出上限（不是网关截断）。判据是 `completion_tokens` 恰好等于 `max_tokens`
（DeepSeek-V4-Flash / qwen-3.6-plus / glm / kimi / minimax 都是 16,000）。客户端可按 `length` 自动续写。
DeepSeek-V4-Pro 标 128K（官方 384K），其余按 16K。

**Q：只出思考、正文 0 字符（journal `status=empty_content`）？**
思考与正文**共享同一份输出预算**，模型把 16K 全用在思考上就一个字正文都不剩。
三种处置：换思考更少的模型；把 `reasoning_abort_chars` 设成正数（思考超限且无正文就掐断重试）；
在提示词里要求「先给结论再解释」。

---

## 8.5 安全底线：没有口令就不启动

`panel_password` 同时是面板登录口令和 `/v1/*` 的 Bearer key。它为空、或还是模板占位值（`CHANGE_ME` 等）时，
网关**直接拒绝启动**（退出码 2），并在日志里打印修法：

```
============ 启动中止：没有设置面板口令 ============
  修法任选其一：
   1) 删掉 data/config.json 后重启：会自动生成随机口令并打印在日志里；
   2) 手动填：{"panel_password":"你的口令","api_key":"同一个口令"}
   3) 仅本机临时调试：先 set TRAE2API_ALLOW_NO_AUTH=1 再启动（会持续告警）
```

- 首次安装不会碰到它：`data/config.json` 不存在时会自动生成 16 位随机口令；
- 口令短于 8 位只告警不拦（兼容既有短口令）；
- 保活脚本识别退出码 2 会**停止重试**，避免刷日志；改好配置后重启计划任务即可；
- 面板登录有防爆破（同 IP 10 分钟 10 次失败），口令正确时永远放行。

---

## 9. 免责声明

本项目仅用于把**你自己账号**的客户端通道封装成标准接口，请遵守上游服务条款；
仓库不包含任何第三方二进制、证书或账号凭据。
