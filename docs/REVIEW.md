# 代码审查报告（2026-11-21）

审查对象：`trae2api` 干净发布树（26 个文件 / 284 KB，见 `README.md` 第 1 节）。
审查方式：逐文件通读 + 危险模式扫描（`exec*` / `fs.*` / `path.join`）+ 本机实机验证（真运行时、真账号、真流式）。
结论摘要：**发现 1 个会让 SSE 丢帧的逻辑 bug、3 个安全缺口、1 个"全新安装必踩"的空响应坑，全部已修并实测**；
另有 6 项遗留风险（不影响当前使用）在文末列出。

---

## 1. 清理与脱敏（相对原开发仓库）

| 类别 | 数量 | 处置 |
|---|---|---|
| 探针脚本 `probe-*.cjs` | 91 | 剔除（历史实验，已在 git 历史里） |
| 截图 `*.png` | 8 | 剔除（含面板截图） |
| 开发日志 `README.md`（176 KB 流水账） | 1 | 重写为面向使用者的 README |
| 临时脚本 `tmp-*.cjs` / `test-standalone-*` / `test-auth` 等 | 12 | 剔除 |
| MITM 证书与私钥 `mitm/{ca,leaf}.{crt,key,csr,srl}` | 7 | **剔除（CA 私钥绝不能入库）** |
| 打包/安装类一次性脚本（`install-task.ps1`、`cleanup-mcp.ps1`、`start-agent-*.ps1` 等） | 9 | 剔除（功能已并入 `deploy/`） |
| 运行时数据 `data/`（配置、JWT 缓存、请求日志、附件） | 目录 | 剔除并 `.gitignore` |
| VSIX / 7z / exe / dll / node 二进制 | — | 仓库不含；`.gitignore` 已挡住 |
| 保留单元测试 | 2 | `test-call-parse.cjs`、`test-tools-bridge.cjs` |

**脱敏点**

| 位置 | 原内容 | 现在 |
|---|---|---|
| `lib/trae.cjs` 默认工作区 | 开发机上的个人工作目录（绝对路径） | `~/trae2api-workspace`（不再写死机器路径） |
| `deploy/setup.ps1` 示例 | `C:\Users\<用户名>\Downloads\…` | `D:\downloads\…` |
| `deploy/install-from-vsix.cjs` 默认目标 | `C:\trae2api-runtime` | `<仓库>/runtime` |
| `data/config.json`（口令、api_key、device_id、local_project_id） | 真实值 | 不入库；首跑自动生成随机口令 |
| 启动日志 | 打印完整 `creds.status()`（含 uid / tenant / 姓名） | 只打 jwt / refresh 到期时间 |

复查结果：个人目录路径、工作区路径、账号 uid 与 tenant、`device_id`、面板口令、公网 / 内网 IP、machine-id、JWT 片段 —— **全树 0 命中**（具体值不写入本报告）。

---

## 2. 发现与修复（按严重度）

### S1 · SSE 心跳写的是字面量 `\n`，会把下一帧吃掉（已修）

`server.cjs` 心跳：

```js
heartbeat = setInterval(() => { try { res.write(': ping\\n\\n'); } catch {} }, 15000);
```

源文件里是双反斜杠 ⇒ JS 字符串实际内容是 `: ping\n\n`（两个字符 `\` + `n`），**不含真实换行**。
后果：① 心跳帧永远不结束；② 下一帧 `data: {…}` 会被粘在同一行，而该行以 `:` 开头 ⇒ 整行被 SSE 客户端当成注释**丢弃**。
即"每闲置 15 秒，就有 1 个数据帧丢失"。

实测核对：

```
源文本 : "res.write(': ping\\\\n\\\\n')"
实际字节: ": ping\\n\\n"   含真实换行: false
```

修复：改为真实换行 `res.write(': ping\n\n')`。修复后长流式验证 22 帧、`[DONE]`、`finish_reason=stop` 齐全，无字面量反斜杠。

### S2 · 没有配置文件时完全不鉴权（已修）

`authCfg()` 读不到 `data/config.json` 时 `enabled=false`，`panelAuthed()` / `apiAuthed()` 全都直接放行 ——
新装用户忘了建配置，就等于把面板 + `/v1/*` 暴露在 `0.0.0.0:18790` 上。

修复：
- 首跑自动生成 `data/config.json`，`panel_password` 与 `api_key` 都是 **16 位随机串**，并打印到启动日志；
- 若仍然是"无口令"状态，启动时打 `[SECURITY] ⚠ 未设置 panel_password：面板与 /v1/* 现在对任何来源开放！`。

### S3 · 图片 URL 任意抓取 + 无大小上限（已修）

`lib/attachments.cjs` 的 `saveRemoteUrl()` 直接 `fetch(url)`，URL 来自请求体 ⇒ 网关卡在用户机器上，
这就是一个 SSRF 入口（可打 `127.0.0.1` 上的其它服务、内网管理面、云 metadata），且整包读进内存无大小限制。

修复：
- 只允许 `http(s)`；拒绝 `localhost` / `127.0.0.0/8` / `10/8` / `172.16/12` / `192.168/16` / `169.254/16` / `::1` / `fc00::/7` / `*.local` / `*.internal`；
- 下载前看 `Content-Length`、下载后再核对，超过 `TRAE2API_IMAGE_MAX_MB`（默认 20 MB）直接拒绝。

### S4 · VSIX 解包没有 zip-slip 防护（已修）

`deploy/install-from-vsix.cjs` 用条目名直接拼目标路径：

```js
const out = path.join(serverDir, rel.replace(/\//g, path.sep));
```

恶意/异常 VSIX 里带 `../../` 的条目可以写到部署目录之外。修复：

```js
const out = path.resolve(serverDir, rel.replace(/\//g, path.sep));
if (!out.startsWith(path.resolve(serverDir) + path.sep)) { dropped++; continue; }
```

### M1 · 全新安装必踩：工作区目录不存在 → 对话返回空（已修）

这是本次审查最有价值的发现。干净副本首跑（无 `~/trae2api-workspace`）时：

```
[empty] 上游返回空结果（usage 全 0）… estPromptTokens=8296     ← 1 帧、0 字、745 ms 返回
```

建好该目录后，**同一个二进制、同一条请求**：

```
[流式] 32731ms  帧 24  正文 1884 字  finish=stop  [DONE]=true    ← 正常
```

修复：启动时检查 `workspace_folder`，不存在就 `mkdir -p` 并打日志
（`[boot] 已创建工作区目录 …`）。

### M2 · 面板用 `innerHTML` 拼服务端数据（已修）

`public/index.html` 有 8 处 `tr.innerHTML = \`<td>${...}</td>\`` 之类的拼接，
数据来自上游模型目录、请求日志、错误聚合；带 api_key 的调用方可以构造模型名 / 报错文本注入 HTML，
在面板里形成存储型 XSS（可读同源接口、改设置）。

**修复（2026-11-21）**

1. 新增 `esc()`（转义 `& < > " '`），放在脚本最前面，所有外部文本一律过它；
2. 覆盖全部注入点：模型表三列、凭据表、缓存表（自拼的 pill 用 `isHtml` 标记放行）、
   请求日志（model / kind / tools / blockMode / callNames / error）、错误汇总（type / lastModel / sample）；
3. `sm.innerHTML = sel.innerHTML` 改为 `sm.replaceChildren(...cloneNode)`，不再做 HTML 往返；
4. 新增单测 `test-panel-escape.cjs`（10 个用例）：从 `index.html` 里取出 `esc()` 做函数级断言，
   并结构断言「关键列必须经过 esc()」「不得再有未转义插值」。

验证：`node test-panel-escape.cjs` → 10/10；两段内联脚本 `new vm.Script` 语法通过；
生产重启后返回的面板 HTML 里 `esc(m.name)` 已生效、无未转义插值、`replaceChildren(` 就位；对话回归 5.3 s 正常。
（浏览器级自动化未做：本机 Edge 157 无头模式下 CDP 的 Page 域不响应，改用函数级 + 结构级断言覆盖。）

### M3 · 面板登录没有防爆破（已修）

原来 `POST /api/login` 只记日志。修复：同 IP 10 分钟内最多 10 次**失败**；
顺序上先校验口令再判断限流，所以**口令正确永远能进**，被锁的只会是猜口令的人。

实测：

```
12 次错误口令 → 401,401,401,401,401,401,401,401,401,401,429,429   ✅ 出现 429
紧接着正确口令 → HTTP 200 + Set-Cookie: t2a=…                      ✅ 未被误锁
```

### M4 · `schtasks` 路径没加引号（已修）

`deploy/install-from-vsix.cjs` 里 `-File ${supPath}` 未加引号：部署到 `D:\My Apps\...` 这类含空格目录时任务会建错。
已改为 `-File "${supPath}"`（两个分支都改）。

### M5 · `supervise.ps1` 以无 BOM 的 UTF-8 写盘（已修）

内容含中文注释，`powershell.exe` 5.1 会按 ANSI 解码而乱码甚至解析失败。已改为写 `\ufeff` + 内容。

### M6 · 单测断言已过时（已修）

`test-tools-bridge.cjs` 断言指令块含「输出前自检」，但该措辞现在只存在于 `instruction_style=legacy`。
默认风格用的是「一条底线」。原来 20/21 通过（长期飘红）。已改为断言默认风格文案，并新增 legacy 分支断言 ⇒ 21/21。

### M7 · 静态文件前缀判断（已修）

`file.startsWith(PUBLIC)` 会放行 `public-x/` 这类同级目录；已改成 `file === PUBLIC || file.startsWith(PUBLIC + path.sep)`。

### L 级（已记录，未改）

| 编号 | 内容 | 影响 |
|---|---|---|
| L1 | `server.cjs` 用 `execFileSync('powershell.exe', …)` 找 aiserver 进程 | 仅 ASCII 命令，无乱码风险；有 `pwsh` 时优先用它更好 |
| L2 | `run-aiserver.cmd` 以 `ascii` 写盘 | 部署目录含中文时 `.cmd` 会坏（建议改 `utf8` + `chcp 65001`） |
| ~~L3~~ | 已处理：删除 `deploy/install.cjs`（与 `setup.ps1` + `install-from-vsix.cjs` 职责重叠的薄封装），部署入口收敛为两个：`setup.ps1`（人用）与 `install-from-vsix.cjs`（执行器，被 `bootstrap-runtime.ps1` 调用） | — |
| ~~L4~~ | 已处理：删除 `agent_backend=standalone` 整条分支（`server.cjs` 的启动判断、`projectIdKey` 分支、`apiStatus.agent_backend` 字段、`aha.cjs` 的 `agent-runtime` 扫描与 standalone 自动应答），并删除 `work/trae2api/agent-runtime/` 残留 | — |
| L5 | 所有响应统一 `Access-Control-Allow-Origin: *` | 已鉴权端点靠 Cookie，浏览器不会带凭据跨域读；实际风险低，但语义上应收窄 |
| L6 | `lib/aha.cjs` 掉线时未 reject 在飞 RPC | 每个 RPC 自带超时，最多多等一个超时周期 |

---

## 3. 架构层面的约束（重要）

1. **一个运行时只能挂一个网关**。实测：让生产网关和干净副本同时连同一个 `ai-agent`，
   会出现 `RPC 超时 model/model_list`、`lite/create_chat_session` 超时、乃至对话返回空；
   独占后恢复正常（干净副本 24 帧 1884 字、生产 22 帧+`[DONE]`）。
   ⇒ 换机/换目录时务必先停旧网关，**禁止双跑**；解卡办法是重启 aiserver（看护器 6 秒拉起）。
2. **Windows 专属**。依赖 `ai-agent.exe`、Windows 计划任务、DPAPI 解 VS Code `safeStorage`。
3. **VSIX 不入库**。运行时=aiserver(JS)+ai-agent(exe)，都从用户自下载的 VSIX 里解出来；仓库只有 284 KB。
4. **凭据链路**：JWT 随每次请求放在 `user_info.token` 发给 ai-agent（实测伪造 JWT ⇒ 45 ms 空返回），
   JWT 有效期 14 天、refresh token 180 天，24 小时自动续期使其双滑动，永不到期。

---

## 4. 验收记录

| 项 | 结果 |
|---|---|
| 语法检查（server + 8 个 lib + 3 个 deploy） | 全通过 |
| 单元测试 | `test-call-parse` 23/23、`test-tools-bridge` 21/21 |
| 全新安装（无 `data/`） | 自动生成 16 位随机口令、自动创建 `~/trae2api-workspace`、面板与 `/healthz` 正常 |
| 面板鉴权 | 未登录访问页面 302 → `/login?next=…`；错误口令 10 次后 429；正确口令 200 + Cookie |
| 流式对话（干净副本，独占运行时） | 32.7 s、24 帧、正文 1884 字、`finish=stop`、`[DONE]`、0 坏帧 |
| 流式对话（生产，同步修复后） | 22 帧、`[DONE]`、`finish=stop`；短请求 4.9 s |
| 心跳修复 | 长流式输出中不再出现字面量 `\n`，无帧被吞 |
| 个人信息扫描 | 0 命中；无 vsix/7z/exe/dll/证书/图片 |

测试脚本：`node tools/verify-e2e.cjs <port> <panel_password>`（流式 + 防爆破 + 正常登录三项一次跑完）。

---

## 5. 后续建议（按性价比排序）

1. **面板 XSS**：加 `escapeHtml()` 覆盖 8 处 `innerHTML`（M2），约半小时。
2. **运行前自检**：启动时检查"运行时 socket / 工作区 / 凭据"三项并写进 `/healthz` 的 `checks` 字段，
   把 M1 这类"静默空响应"变成显式状态。
3. **在飞 RPC 掉线即失败**（L6）：`_dropConnection()` 里遍历 `pending` 逐个 reject，省掉一次超时等待。
4. **死代码清理**（L4）：删掉 `agent_backend=standalone` 相关分支与 `TRAE2API_ANSWER_COMMANDS`。
5. **跨平台**：若要 Linux，只需换掉 `ai-agent.exe` 与 DPAPI 两处（`creds.cjs` 的 `_safeKey`），
   其余（aha/ZeroMQ、HTTP、面板）本就是跨平台的。

---

## 6. 2026-11-25 复核补充（4.0.60–4.0.70 期间）

> 本文前 5 节写于 2026-11-21。之后又发现并修掉的问题记在这里，避免结论过期。

| 编号 | 问题 | 影响 | 处置 |
|---|---|---|---|
| S5 | 我加的「打满上限标 length」首个版本把 `capHit` 计算放在 `const usage` 之前 | 触发 `Cannot access 'usage' before initialization`，流式请求直接失败（16:39 那次） | 移到 `usage` 之后；json/stream 两条路径实测通过（4.0.64） |
| S6 | `capHit` 用 `completion >= modelCap` | DeepSeek-V4-Pro 的 16,709 / 19,797 / 43,049 会被误标 `length` | 改为**精确等于**上限（4.0.66） |
| M8 | 流式静默期只发 SSE 注释 `: ping` | 客户端 `idleWatchdog` 只认真 chunk，注释不算 → `pi-ai stream idle timeout` | 改发 `delta:{}` 空帧，`stream_keepalive_ms` 可调（4.0.62） |
| M9 | 空闲看门狗 600 s 硬编码 | 上游零事件时要死等 10 分钟 | 改成 `idle_timeout_ms` 可配，生产 240 s（4.0.63） |
| M10 | 模型表加列后 `td{white-space:nowrap}` 导致表格溢出卡片 | 面板排版错乱（压住右侧卡片） | 模型卡片独占整行 + 表格横向滚动 + 列精简（4.0.70） |
| L7 | README 同步脚本用「`### 4.0.7`」当边界 | 把 4.0.69→4.0.1 整段复制了两遍（1509 → 2438 行） | 以任意 `### ` 为边界重新抽取，只插一节✅ |
| L8 | 三个历史版本号重复（4.0.44/45/46 各出现两次，内容不同） | 版本号有歧义 | 第二处改为 `4.0.44b/45b/46b` |

| S7 | `/healthz` 只有 `ok`+`connected`，没有任何自检（本文第 5 节建议 2 一直没做） | 外部监控分不清「运行时没起 / 工作区没了 / 凭据失效」 | 4.0.72 增加 `checks`（`lib/health.cjs` 纯函数 + 14 组合单测） |
| S8 | `_dropConnection()` 只关 socket，不清 `pending`（本文第 5 节 L6 一直没做） | 断链后在飞请求要各自等满 RPC 超时，表现为「卡住」 | 4.0.72 逐个 `clearTimeout` + `reject`，并记一行日志 |
| S9 | `check-version.cjs` 完全不知道 4.0.60–4.0.71 加过什么（且生产那份是旧版 35 项） | 部署目录跑自检会报「全具备」，属于假信心 | 4.0.72 补 12 项到 54 项 |
| S10 | 面板 `STATUS_LABEL` 缺 5 个新状态、且多一个代码里不存在的老状态；状态词表与面板没有一致性校验 | 新状态在面板上显示英文原名且统一红色，看不出是警告还是失败 | 4.0.74 补全标签 + `test-panel-tables.cjs` 强制校验（代码里出现的 status 必须有标签且级别一致） |
| S11 | `/api/errors` 只统计 `status==="error"` | 超时/未声明工具/只有思考/打满上限这些失败在面板上完全看不见 | 4.0.74 改为按 `levelOf()` 聚合所有非正常状态，带 err/warn 等级 |
| S12 | 客户端断开只从 `activeStreams` 移除，不中止上游 | 客户端已走，上游继续生成（长思考可烧 20+ 分钟）并占账号池 | 4.0.74 断开即 abort，记 `client_gone`，并跳过后续重试 |
| S13 | 无 `unhandledRejection`/`uncaughtException` 兜底；日志与 `requests.jsonl` 只追加不轮转 | 一次漏 catch 就掉进程；日志长期无限增长（实测 6.12 MB / 0.28 MB） | 4.0.74 全局兜底 + 双文件轮转（10MB / 5MB） |
| S14 | 面板会话过期不清理；`/v1` 无限速无并发上限 | 长期运行缓慢堆积；单客户端可打满账号池 | 4.0.74 每 10 分钟清会话 + 新增 `rate_limit_per_min` / `max_concurrent`（默认关，生产 240/8） |
| S15 | `loadJournal()` 定义了但全代码没有任何调用点 | `data/requests.jsonl` 一直在写，重启后面板「请求日志/错误汇总」永远是空的（实测磁盘 938 行、内存 0 行） | 4.0.74 补调用；重启后 `total=500` |
| S16 | 全仓库 101 处空 `catch {}`，其中 3 处会吞掉真故障（配置读失败、creds.status、日志轮转） | 故障无声消失，排障只能靠猜 | 4.0.75 加 `test-silent-catch.cjs` 棘轮闸门（基线 `tools/silent-catch-baseline.json`）+ 3 处改为留痕 |
| S17 | 会话 Cookie 从来不设 `Secure` | 反代到 HTTPS 时少一层保护 | 4.0.75 `lib/cookie.cjs` 按 `socket.encrypted` / `X-Forwarded-Proto` 自动加 |
| S18 | `handleChatInner` 的 catch（流已开始后抛异常）只发 error 帧就 `res.end()`，没发 `[DONE]` | 客户端报「stream ended without finish」并可能原样重试，白烧一次上游 | 4.0.76 所有流式错误路径统一先补 `[DONE]` |
| S19 | `lib/aiserver-client.cjs` 整模块没人 require；`_legacyExtractDeclared_unused`、`STATUS` 导入、四处别名字段、`pingTick % 15` 都是重复或死代码 | 与 `loadJournal()` 同类：读代码时以为某功能在跑，实际早就没接线 | 4.0.76 全部清理 + `test-no-dead-code.cjs` 守卫（导入/函数/导出/孤儿模块四条规则） |
| S20 | `LOGIN_FAILS` 只在新失败时覆盖旧记录，唯一 IP 永不清理 | 长期运行缓慢堆积 | 4.0.76 并入每 10 分钟的定期清理 |
**新增的验收项**（建议并入第 4 节的验收表）：

| 指标 | 期望 |
|---|---|
| `GET /v1/models` 的 `context_window` | 不含 116000（应为 1,048,576 / 262,144 / 256,144 / 204,800） |
| `GET /v1/models` 的 `limit.context` / `max_input_tokens` | 与 `context_window` 一致 |
| 面板「总览 → 模型（实时目录）」 | 显示 `1M / 128K / 256K / 200K / 16K`，且不溢出卡片 |
| 长流式请求 | 静默期能看到 `delta:{}` 空帧；客户端不报 idle timeout |
| 打满上限的请求 | journal `finishReason=length`，且**只有**恰好等于上限时才标 |
