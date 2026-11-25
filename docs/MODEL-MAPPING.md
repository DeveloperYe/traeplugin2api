# 模型名从哪来：VSIX 内嵌映射表 vs 服务端目录

> 结论先行：**展示名 `Seed-2.1-Turbo` 不是 VSIX 写死的；VSIX 里写死的是路由清单里的模型键 `Doubao-Seed-2.1-Turbo`。**
> 两者名字像，但来源完全不同，一个是服务端下发的 `display_name`，一个是客户端二进制里内嵌的 `models` 映射表。

## 1. 两个来源

| 来源 | 载体 | 内容 | 是否写死 |
|---|---|---|---|
| **服务端目录** | `aha` 的 `model_list` RPC（每次启动/手动刷新拉取） | `name`（slug）、`display_name`、`multimodal`、`max_tokens`、`context_window_size`… 共 51 个字段 | 否，账号/租户绑定，动态 |
| **客户端映射表** | VSIX 内 `ai-agent.exe` 里内嵌的 `manifests/mapping.json` | `directory_mapping.agentTypes`（agent 类型 → 分节）+ `directory_mapping.models`（分节 → 模型键 → 后端族） | **是，随 VSIX 版本固定** |

实测（extension 1.7.16）：

- 在 `ai-agent.exe`（385.7 MB）里搜 `"Seed-2.1-Turbo"`（带引号）→ **0 命中**；
- 搜 `"Doubao-Seed-2.1-Turbo"` → 5 命中，全部落在同一张 JSON 里；
- 这张 JSON 的 `manifest_version` 是 `20260928144019_internal_prod_skill_version`，位于二进制偏移约 325 MB 处，长度 8,104 字节。

## 2. 映射表长什么样

```jsonc
{
  "manifest_version": "20260928144019_internal_prod_skill_version",
  "directory_mapping": {
    "agentTypes": {
      "solo_agent_remote": "code", "solo_agent_lite": "code", "solo_agent": "trae",
      "solo_work_lite": "work", "solo_work_remote": "work",
      "solo_design_lite": "design", "solo_design_remote": "design"
    },
    "models": {
      "design": { "Doubao-Seed-2.0-Code": "default", "Doubao-Seed-2.1-Turbo": "seed", ... },  // 33 项
      "code":   { "Doubao-Seed-2.0-Code": "doutops", "Doubao-Seed-2.1-Turbo": "doutops", ... }, // 60 项
      "work":   { "Doubao-Seed-2.1-Turbo": "seed", ... },                                       // 52 项
      "trae":   { "Doubao-Seed-2.0-Code": "doutops", "Doubao-Seed-2.1-Turbo": "doutops", ... }  // 51 项
    }
  }
}
```

「后端族」取值有 `doutops / seed / default / gpt / non_multimodal / hebe / iris / thetis / iphigenia / deidamia / buse`，
可以理解为**该模型该走哪套上游服务**（灰度/地域/产品线的路由分组），不是模型版本号。

## 3. 关键对照：同一个 slug 在不同分节走不同后端

| 模型键 | design | code | work | trae |
|---|---|---|---|---|
| `Doubao-Seed-2.0-Code` | `default` | **`doutops`** | — | **`doutops`** |
| `Doubao-Seed-2.1-Turbo` | `seed` | **`doutops`** | `seed` | **`doutops`** |
| `Doubao-Seed-Code` | — | `doutops` | `seed` | `doutops` |
| `Doubao-Seed-2.0-Code-auto` | — | — | — | `default` |
| `Doubao-Seed-2.1-Turbo-auto` | — | — | — | `default` |

读法：
1. `Doubao-Seed-2.1-Turbo` 在这张表里**是一个真实存在的独立模型键**，不是别名；
2. 在 `code` / `trae` 两节里，`2.0-Code` 与 `2.1-Turbo` **都落到 `doutops`**（同一后端族）；
3. 在 `design` / `work` 里两者分家（`2.0-Code`→`default`，`2.1-Turbo`→`seed`）；
4. `*-auto` 两条是另一套（`default`），大概是自动路由/托管形态。

## 4. 所以「Seed-2.1-Turbo」到底是谁

| 你看到的字符串 | 出处 | 性质 |
|---|---|---|
| `Seed-2.1-Turbo` | 服务端 `model_list` 的 `display_name` | 展示名，随服务端配置变化 |
| `Doubao-Seed-2.0-Code` | 同一个 `model_list` 条目的 `name` | 真正的路由 slug |
| `Doubao-Seed-2.1-Turbo` | VSIX 内嵌 `manifests/mapping.json` | 客户端认识的另一个模型键 |

也就是说：**服务端把 slug `Doubao-Seed-2.0-Code` 的展示名标成了 `Seed-2.1-Turbo`，而客户端二进制里同时存在 `Doubao-Seed-2.0-Code` 与 `Doubao-Seed-2.1-Turbo` 两个路由键。** 至于服务端那条 slug 背后到底是哪一代权重，从网关/客户端两侧都无法自证（见 README 4.0.45）。

## 5. 复现方法（只读）

```powershell
# 1) 找 ai-agent.exe（VSIX 解包后的运行时）
#    典型位置：%USERPROFILE%\.marscode\ai-chat\binary\<版本>\modules\ai-agent\ai-agent.exe
# 2) 在二进制里搜字符串（ASCII，UTF-16LE 无命中说明是 UTF-8 存储）
# 3) 定位 "manifest_version" 后向前找最近的 '{'，再做括号配平取出 JSON
```

探测脚本思路（不改任何文件）：

- 按 8 MB 分块扫二进制，匹配 `"Seed-2.1-Turbo"` / `"Doubao-Seed-2.1-Turbo"` / `"display_name"` 等；
- 找到 `"manifest_version"` 的偏移，向前回溯到最近的 `{`，用「字符串感知的括号配平」取出完整 JSON；
- `JSON.parse` 后检查 `directory_mapping` 是否存在（同一二进制里还有 skills 清单等其它 manifest，靠这个字段区分）。

## 6. 附带发现

同一个 `ai-agent.exe` 里还内嵌了**技能市场清单**（`global.skills`：`TRAE-browseruse`、`TRAE-code-mode-orchestrator`、`digital-avatar-creator`、`dynamic-ui`、`skill-creator` 等，带 `url` + `sha256` + `frontmatter.description`）与 agent 类型映射，说明这些「能力清单」是**随 VSIX 版本冻结**的，不是每次从服务端拉。

## 7. 三个名字的实测关系（上游载荷逐字节对照）

用真实账号目录跑 `resolveModel()` + 真实 `modelConfig()`，构造出会发给上游的
`{ model_name, custom_model }` 载荷并比哈希：

| 你在请求里写 | 解析结果 | 上游 `model_name` | 载荷长度 / SHA1（前 16） |
|---|---|---|---|
| `Seed-2.1-Turbo`（display_name） | `reason=display` → `Doubao-Seed-2.0-Code` | `Doubao-Seed-2.0-Code` | 504 B / `359bec08e8d6e1f8` |
| `Doubao-Seed-2.0-Code`（slug） | `reason=exact` | `Doubao-Seed-2.0-Code` | 504 B / `359bec08e8d6e1f8` |
| `Doubao-Seed-2.1-Turbo`（VSIX 路由键） | `reason=unknown` → 拒绝 | —（发不出去） | — |

**结论**：写 `Seed-2.1-Turbo` 与写 `Doubao-Seed-2.0-Code` 是**同一个请求**（载荷逐字节相同）；
而写 `Doubao-Seed-2.1-Turbo` 是另一回事 —— 它确实是 VSIX 里认得的模型键，但**当前账号目录没有这条**，
新版网关会 404 并在报错里给近似名，旧版则静默回退到默认模型（`Doubao-Seed-Code`）。

## 9. 知识截止实测（结果型探针，2026-11-23）

**官方基准**（用户从火山官网读得）：`Doubao-Seed-2.0-Code` → **2023-10**；`Seed-2.1-Turbo` → **2024-07**。

**方法**：只问「事件结果」，不问日期（日期可从旧知识推测）；请求带一个无害 `tools` 掐掉上游检索；
每事件 2 次。有效性自检：2026 年事件全部答「不知道」⇒ 检索确实被掐掉，测的是权重记忆。

**结果**（Trae 的 slug `Doubao-Seed-2.0-Code`，display_name = Seed-2.1-Turbo）：

| 月份 | 探针 | 结果 |
|---|---|---|
| 2024-02 / 03 / 06 / 07 | 超级碗 LVIII / 第 96 届奥斯卡 / NBA 总决赛 / 欧洲杯 | ✅✅✅✅ |
| 2024-08 / 10 / 12 | 巴黎奥运百米 / MLB 世界大赛 / TGA 年度游戏 | ✅✅✅ |
| 2024-11 | ATP 年终总决赛 | ⚠️ 一次错（德约）一次对（辛纳） |
| 2025-02 | 超级碗 LIX | ❌（答前任冠军酋长） |
| 2026-02 / 03 / 06 | 超级碗 LX / 第 98 届奥斯卡 / WWDC26 | ❌❌❌ |

**结论**：
1. 排除 2023-10 的 `Doubao-Seed-2.0-Code`（实测覆盖到 2024-12，晚 14 个月）；
2. 与 2024-07 的 `Seed-2.1-Turbo` 方向一致，实测再靠后约 5 个月（数据约到 2024 年底/2025 年初）；
3. 默认 `Doubao-Seed-Code` 最新（知道 2025-02）。

**边界**：标注 cutoff 通常保守；个别探针不稳定；本方法只能排除/定向，精确定版仍需官方 API A/B 指纹。

## 10. 直接问「知识截止日期」会得到什么（自述不可用实证）

2026-11-23 实测：同一个模型、同一套问题，只改问法/是否带 tools（禁检索开关），答案就变——自述**没有一致性**。

| 模型 | 问法 | 禁检索（带 tools） | 允许检索（不带 tools） |
|---|---|---|---|
| `Doubao-Seed-2.0-Code`（显示名 Seed-2.1-Turbo） | "训练数据截止到哪年哪月？只回答 YYYY-MM，不确定就说不知道" | 不知道 | 不知道 |
| 同上 | "知识库截止日期是什么？直接给年月" | **2024年1月** | **2024年4月** |
| 同上 | "有资料说是 2024-07，请只回答 是/不是/不知道" | 不知道 | 不知道 |
| `Doubao-Seed-Code`（默认） | "训练数据截止到哪年哪月？…" | 不知道 | 不知道 |
| 同上 | "知识库截止日期是什么？直接给年月" | **2025-09**（24 s，疑似检索泄漏） | **2024-06**（52 s） |
| 同上 | "有资料说是 2024-07…" | 不知道 | 不知道 |

读法：

1. **同一模型对同一事实给出互斥答案**（不知道 / 2024-01 / 2024-04）⇒ 自述不能当证据；
2. 带不带 tools 只对「有没有检索」有影响，**对自述的可靠性没有帮助**——"禁检索"是提示词软约束，不是硬开关（默认模型那次 24 s/52 s 的耗时就是检索特征）；
3. 唯一可提取的弱信息：**这些答案里从未出现官方值 `2023-10`**，而出现的是 2024 年初——
   与上一节的行为探针（知道 2024 全年）方向一致，仍指向"比 2.0-Code 新"。

**结论**：判定模型身份请用「行为探针」（第 9 节），自述只作旁证，且必须标明它不稳定。

---

## 11. 目录值 vs 官方值：`/v1/models` 报了谁（2026-11-25）

上游 `model_list` 对 **11 个模型一律**声明 `max_tokens=16000`、`prompt_max_tokens=100000`、`context_window=116000`。
这三个数都不可信，网关用四张覆盖表改成真实值后再下发（README 4.0.67–4.0.69）：

| 字段 | 上游声明 | 网关下发 | 依据 |
|---|---|---|---|
| `context_window` | 116,000 | 1,048,576（DeepSeek-V4-Pro/Flash、qwen-3.6-plus）/ 262,144（Doubao）/ 256,144（kimi-k2.6）/ 204,800（glm-5.x、minimax-m2.x） | 各厂商官方上下文规格 + 自测（1,048,576 tokens 实测通过） |
| `prompt_max_tokens` | 100,000 | 同 `context_window` | 输入预算不应小于窗口 |
| `max_tokens` | 16,000 | 131,072（DeepSeek-V4-Pro）/ 16,000（其余） | Pro 官方 MAX OUTPUT 384K，实测单轮 134,997；Flash/qwen/glm/kimi/minimax 实测精确卡 16,000 |

另外下发 `context_length` / `max_input_tokens` / `max_output_tokens` / `limit.{context,output}` 兼容别名，
以及 `max_tokens_note`（Pro 的备注：官方 384K、此处标 128K、实测可能更高）。

**为什么必须由网关报**：客户端「获取可用模型」只读这些字段；只要网关不报真实值，客户端就会写回 116K/16K，
进而过早压缩上下文、或把 maxTokens 设小。

覆盖表在 `data/config.json`：
`context_window_override`、`prompt_max_tokens_override`、`max_tokens_override`、`max_tokens_note`
（完整键表见 [CONFIG.md](CONFIG.md) 第 1.4 节）。
