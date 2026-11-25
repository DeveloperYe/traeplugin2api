# 思考强度（reasoning_effort）在 Trae 通道里生效吗

> **结论：不生效。** `reasoning_effort: none / low / high` 传下去对思考量没有可测影响；
> 模型目录里也没有任何思考开关字段（11 个模型的 `thinking_enable` 与 `reasoning_effort_options` 全为 `null`）。

## 1. 目录侧证据（服务端就没给开关）

| 模型 | `thinking_enable` | `reasoning_effort_options` | `reasoning_effort_config` |
|---|---|---|---|
| Doubao-Seed-2.0-Code / Seed-Code / qwen-3.6-plus / glm-5.x / minimax-m2.x / DeepSeek-V4-* / kimi-k2.6 | `null` | `null` | 仅 `Doubao-Seed-Code` 有 `{"support_thinking": false}` |

`null` 的含义是「没有可选档位」，上游 `send_message` 里也没有这个字段的位置。

## 2. 行为侧实测（2026-11-23，`temperature=0`、同一 prompt、每档多次）

题目：`求最小的正整数 n，使 n 除以 7 余 3、除以 11 余 5、除以 13 余 7。`（正确答案 423，16 次全对）

`Doubao-Seed-2.0-Code`，每档 5 次：

| 条件 | `reasoning_tokens` 明细 | 中位数 | 耗时中位 |
|---|---|---|---|
| baseline（不传） | 826, 1090, 414, 1453, 843 | **843** | 10.5 s |
| `reasoning_effort: none` | 1388, 1225, 795, 1148, 1169 | **1169** | 12.4 s |
| `reasoning_effort: low` | 1359, 409, 1194, 985, 986 | **986** | 12.4 s |
| `reasoning_effort: high` | 1200, 1007, 1336, 1672, 695 | **1200** | 14.4 s |

复核（baseline vs none，各 6 次）：baseline 中位 **919.5**，`none` 中位 **1063**（+15.6%）——
`none` 不但没把思考压下去，反而更高，差异完全在噪声内。

## 3. 为什么不能用单次数据判断

同一条件（baseline）5 次 `reasoning_tokens` 是 **414 ~ 1453**，波动 3.5 倍。
任何「档位有效」的结论都必须用 **≥5 次中位数**比较；第一版探测正是用单次对比把
`high/low` 误判成"可能有效"，加样本后作废。

## 4. 还能怎么控制思考量

| 手段 | 效果 | 代价 |
|---|---|---|
| 换模型 | **最有效**：同题 `Doubao-Seed-2.0-Code` 中位约 900，`qwen-3.6-plus` 约 200 | 能力/风格不同 |
| 配置 `reasoning_abort_chars` | 思考超限且无正文 → 掐断 + 强纠偏重试一次 | 硬手段，可能损质量。**当前生产为 0（关闭）**（README 4.0.65） |
| 提示词软控 | 有效但不保证 | 占上下文 |

## 5. 思考算在「输出预算」里（2026-11-24/25 实测）

- 上游 `usage` 的 `completion_tokens` **包含** `reasoning_tokens`：DeepSeek-V4-Flash / qwen-3.6-plus / glm-5v-turbo
  多次出现 `completion=16000` 且 `reasoning=16000`，正文 0 字符（journal `status=empty_content`）；
- 所以「思考强 = 正文少」不是错觉，是同一份预算被烧光；
- 官方口径：DeepSeek `max_tokens` 明确「包含 CoT 部分」，最大值 384K（V4-Pro / Flash 同时适用）；
- 实测输出上限差异极大：DeepSeek-V4-Pro 单轮到过 **134,997**（reasoning 131,079，25.7 分钟），
  而 Flash / qwen / glm / kimi / minimax 在这条通道上精确卡 **16,000**；
- 打满上限时网关会把 `finish_reason` 标成 `length`（README 4.0.64/4.0.66），客户端据此续写。

**结论**：想「要么少想、要么把想的内容留出来」，可行顺序是
①换思考更少的模型 → ②提示词要求先给结论 → ③（慎用）`reasoning_abort_chars`。

## 6. 复现

```bash
N=5 MODELS=Doubao-Seed-2.0-Code node work/fingerprint/probe-effort2.mjs
MODEL=Doubao-Seed-2.0-Code node work/fingerprint/confirm-effort.mjs
```
