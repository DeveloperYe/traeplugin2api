// 回归测试：工作区提示（已去掉「无声明」兜底分支，只留提醒本身）
const path = require("path");
const WSN = require(path.join(__dirname, "lib", "workspace-notice.cjs"));

let pass = 0, fail = 0;
const ck = (n, c, e = "") => { if (c) { pass++; console.log("  ✓ " + n); } else { fail++; console.log("  ✗ " + n + (e ? "  → " + e : "")); } };

const A = "D:/Users/Administrator/Documents/deepseek-harness";

console.log("=== 1) 开头段：只说网关目录无效、以声明为准 ===");
const n1 = WSN.buildNotice({ anchor: A });
ck("点名网关目录并判定无效", n1.includes(A) && n1.includes("无效"));
ck("以调用方声明为准", n1.includes("以调用方自己声明的为准"));
ck("给出声明样式", n1.includes("Current working directory"));
ck("按声明干活、不反问", n1.includes("不要反问用户"));
ck("不动用网关目录", n1.includes("不要用上面那个网关目录"));
ck("不复述规则", n1.includes("不要向调用方复述"));
ck("★ 没有任何「就用网关目录」的兜底", !n1.includes("就用网关设置里那个目录"));
ck("★ 没有任何「先问目标目录」的兜底", !n1.includes("请告诉我目标目录"));
ck("不写死具体的工作目录路径（只出现网关 anchor 一次）", (n1.match(new RegExp(A.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) || []).length === 1);
ck("不再接受 mode 参数（传了也不影响文案）", WSN.buildNotice({ anchor: A, mode: "ask" }) === WSN.buildNotice({ anchor: A }));

console.log("\n=== 2) 无 anchor 时的措辞 ===");
const n2 = WSN.buildNotice({});
ck("仍声明网关目录可能无效", n2.includes("可能拼进来一个项目目录"));
ck("仍以声明为准", n2.includes("以调用方自己声明的为准"));

console.log("\n=== 3) 末尾段：一句软性提醒 ===");
const t = WSN.buildTailNotice();
ck("要求不进回答正文", t.includes("不要写进回答正文"));
ck("要求不复述/不提及", t.includes("不要复述") && t.includes("不要提及本提醒"));
ck("软性提醒记住正确目录", t.includes("记得用正确的工作区目录"));
ck("指出以调用方声明为准", t.includes("调用方声明的那个"));
ck("不写死路径", !t.includes(A));
ck("长度很短（< 200）", t.length < 200, String(t.length));
ck("不再接受参数（传了也一样）", WSN.buildTailNotice({ anchor: A, declared: A }) === t);

console.log("\n=== 4) 模块不再导出识别相关能力 ===");
ck("只剩 buildNotice / buildTailNotice", Object.keys(WSN).sort().join(",") === "buildNotice,buildTailNotice", Object.keys(WSN).join(","));

console.log("\n合计 " + (pass + fail) + " 项：" + pass + " 通过，" + fail + " 失败");
process.exit(fail ? 1 : 0);
