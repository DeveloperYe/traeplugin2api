// 回归测试：aha 假 IDE 对配置键的回答（已知键显式表 + 未知键兜底 + 留痕）
const path = require("path");
const A = require(path.join(__dirname, "lib", "aha.cjs"));

let pass = 0, fail = 0;
const ck = (n, c, e = "") => { if (c) { pass++; console.log("  ✓ " + n); } else { fail++; console.log("  ✗ " + n + (e ? "  → " + e : "")); } };

const CMD = "icube.common.commands.tooling.getConfigurationValue";
const ask = (key) => {
  const r = A.answerCommand(CMD, JSON.stringify({ key }));
  return r && Object.prototype.hasOwnProperty.call(r, "value") ? r.value : "__unhandled__";
};

console.log("=== 1) 已知键：走显式表 ===");
ck("AI.skills.enableAgentsDir → false", ask("AI.skills.enableAgentsDir") === false);
ck("AI.skills.enablePeerProductSkills → false", ask("AI.skills.enablePeerProductSkills") === false);
ck("显式表里包含实测过的两个键",
  Object.prototype.hasOwnProperty.call(A.CONFIG_ANSWERS, "AI.skills.enableAgentsDir") &&
  Object.prototype.hasOwnProperty.call(A.CONFIG_ANSWERS, "AI.skills.enablePeerProductSkills"));

console.log("\n=== 2) 未登记的 skills 键：按前缀兜底为 false ===");
ck("AI.skills.someNewThing → false", ask("AI.skills.someNewThing") === false);
ck("AI.skills.enableAutoInstall → false", ask("AI.skills.enableAutoInstall") === false);

console.log("\n=== 3) autoRun 类：兜底 false ===");
ck("AI.autoRun.enabled → false", ask("AI.autoRun.enabled") === false);
ck("AI.auto_run.enabled → false", ask("AI.auto_run.enabled") === false);
ck("非 AI. 前缀的 autoRun 键不再命中（回 null）", ask("other.autoRun.x") === null);

console.log("\n=== 4) 完全无关的键：回 null（未设置），不是 false ===");
ck("editor.fontSize → null", ask("editor.fontSize") === null);
ck("AI.skillsPanelWidth 不再被误判（回 null）", ask("AI.skillsPanelWidth") === null);

console.log("\n=== 5) 其它命令仍按原样回答 ===");
const dyn = A.answerCommand("icube.common.getDynamicConfig", null);
ck("getDynamicConfig → {}", dyn && JSON.stringify(dyn.value) === "{}");
const folder = A.answerCommand("icube.common.commands.tooling.listFolder", JSON.stringify({ path: "D:/x" }));
ck("listFolder → []", folder && Array.isArray(folder.value) && folder.value.length === 0);
const ab = A.answerCommand("icube.event.getABTestConfigByKey", JSON.stringify({ key: "k", defaultValue: 7 }));
ck("AB 测试回 defaultValue", ab && ab.value === 7);

console.log("\n=== 6) 未知命令仍返回 null（让上层回 unsupported）===");
ck("未知命令 → null", A.answerCommand("some.unknown.command", null) === null);


console.log("\n=== 7) 代答模式：off / poll / all ===");
{
  const CMDC = "icube.common.commands.tooling.getConfigurationValue";
  const DYN = "icube.common.getDynamicConfig";
  const FOLDER = "icube.common.commands.tooling.listFolder";
  ck("poll 只答轮询类（getDynamicConfig）", A.answerCommand(DYN, null, "poll") !== null);
  ck("poll 不答 listFolder", A.answerCommand(FOLDER, "{}", "poll") === null);
  ck("all 答 listFolder", A.answerCommand(FOLDER, "{}", "all") !== null);
  ck("默认（不传 mode）= all", A.answerCommand(CMD, JSON.stringify({ key: "AI.skills.enableAgentsDir" })) !== null);
  const old = process.env.TRAE2API_ANSWER_COMMANDS;
  process.env.TRAE2API_ANSWER_COMMANDS = "poll";  ck("answerMode('poll')", A.answerMode() === "poll");
  process.env.TRAE2API_ANSWER_COMMANDS = "1";     ck("answerMode('1')=all", A.answerMode() === "all");
  process.env.TRAE2API_ANSWER_COMMANDS = "";      ck("answerMode(空)=off", A.answerMode() === "off");
  if (old === undefined) delete process.env.TRAE2API_ANSWER_COMMANDS; else process.env.TRAE2API_ANSWER_COMMANDS = old;
}

console.log("\n合计 " + (pass + fail) + " 项：" + pass + " 通过，" + fail + " 失败");
process.exit(fail ? 1 : 0);
