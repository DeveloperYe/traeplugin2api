// 回归测试：思考回填（reasoning_context）
const path = require("path");
const { TraeService } = require(path.join(__dirname, "lib", "trae.cjs"));
const F = TraeService.flattenMessages;

let pass = 0, fail = 0;
const ck = (n, c, e = "") => { if (c) { pass++; console.log("  ✓ " + n); } else { fail++; console.log("  ✗ " + n + (e ? "  → " + e : "")); } };

const msgs = [
  { role: "system", content: "SYS" },
  { role: "user", content: "第1问" },
  { role: "assistant", content: "答1", reasoning_content: "思考一：决定用方案甲。" },
  { role: "user", content: "第2问" },
  { role: "assistant", content: "答2", reasoning_content: "思考二：改为方案乙。" },
  { role: "tool", name: "read", content: "文件内容" },
  { role: "user", content: "第3问（当前）" },
];

console.log("=== 1) off：完全不带思考（旧行为）===");
const pOff = F(msgs, "EXTRA", { includeReasoning: "off" });
ck("不含任何〔思考〕", !pOff.includes("〔思考〕"));
ck("正文仍在", pOff.includes("答1") && pOff.includes("答2"));
ck("末尾是当前用户消息", pOff.trimEnd().endsWith("第3问（当前）"));

console.log("\n=== 2) all：历史每轮思考都带上 ===");
const pAll = F(msgs, "EXTRA", { includeReasoning: "all" });
ck("含第1轮思考", pAll.includes("思考一：决定用方案甲。"));
ck("含第2轮思考", pAll.includes("思考二：改为方案乙。"));
ck("有 2 个〔思考〕行（不含表头说明）", (pAll.match(/^〔思考〕/gm) || []).length === 2);
ck("有防复述说明", pAll.includes("不要在回答里引用或复述"));
ck("思考紧跟对应那轮正文", /答1\n〔思考〕思考一/.test(pAll));
ck("工具返回仍在历史里", pAll.includes("工具(read) 返回：文件内容"));

console.log("\n=== 3) last：只带最近一轮思考 ===");
const pLast = F(msgs, "", { includeReasoning: "last" });
ck("含第2轮思考（最近一轮）", pLast.includes("思考二：改为方案乙。"));
ck("不含第1轮思考", !pLast.includes("思考一：决定用方案甲。"));
ck("只有 1 个〔思考〕行", (pLast.match(/^〔思考〕/gm) || []).length === 1);

console.log("\n=== 4) 兼容其它字段名（reasoning / reasoning_text）===");
const pAlt = F([
  { role: "user", content: "q1" },
  { role: "assistant", content: "a1", reasoning: "来自 reasoning 字段" },
  { role: "user", content: "q2" },
  { role: "assistant", content: "a2", reasoning_text: "来自 reasoning_text 字段" },
  { role: "user", content: "q3" },
], "", { includeReasoning: "all" });
ck("reasoning 字段被采用", pAlt.includes("来自 reasoning 字段"));
ck("reasoning_text 字段被采用", pAlt.includes("来自 reasoning_text 字段"));

console.log("\n=== 5) 截断与总量上限 ===");
const long = "长".repeat(500);
const pCap = F([
  { role: "user", content: "q1" },
  { role: "assistant", content: "a1", reasoning_content: long },
  { role: "user", content: "q2" },
], "", { includeReasoning: "all", reasoningMaxChars: 100 });
ck("单轮按上限截断", pCap.includes("长".repeat(100)) && !pCap.includes("长".repeat(101)) && pCap.includes("已截断"));

const pTotal = F([
  { role: "user", content: "q1" },
  { role: "assistant", content: "a1", reasoning_content: "甲".repeat(80) },
  { role: "user", content: "q2" },
  { role: "assistant", content: "a2", reasoning_content: "乙".repeat(80) },
  { role: "user", content: "q3" },
], "", { includeReasoning: "all", reasoningTotalMaxChars: 100 });
const keptJia = pTotal.includes("甲".repeat(80));
const keptYi = pTotal.includes("乙".repeat(80));
ck("总量超限时丢了较早那轮、保留较晚那轮", !keptJia && keptYi, `甲保留=${keptJia} 乙保留=${keptYi}`);

console.log("\n=== 6) 没有思考时不产生多余说明 ===");
const pNone = F([{ role: "user", content: "q1" }, { role: "assistant", content: "a1" }, { role: "user", content: "q2" }], "", { includeReasoning: "all" });
ck("不出现〔思考〕", !pNone.includes("〔思考〕"));
ck("不出现防复述说明", !pNone.includes("不要在回答里引用或复述"));

console.log("\n合计 " + (pass + fail) + " 项：" + pass + " 通过，" + fail + " 失败");
process.exit(fail ? 1 : 0);
