// 回归测试：看护器自愈门控（宽限期 + 连续坏次数）
const path = require("path");
const { shouldHeal } = require(path.join(__dirname, "deploy", "watch-runtime.cjs"));

let pass = 0, fail = 0;
const ck = (n, c, e = "") => { if (c) { pass++; console.log("  ✓ " + n); } else { fail++; console.log("  ✗ " + n + (e ? "  → " + e : "")); } };

const base = { uptimeMs: 300000, badStreak: 2, graceMs: 90000, minStreak: 2, cooldownOk: true };
const run = (over) => shouldHeal({ ...base, ...over });

console.log("=== 1) 宽限期：网关刚起不动手 ===");
ck("uptime 30s（< 90s）不自愈", run({ uptimeMs: 30000 }).heal === false);
ck("理由里写明宽限", run({ uptimeMs: 30000 }).why.includes("宽限期"));
ck("uptime 恰好 90s 放行", run({ uptimeMs: 90000 }).heal === true);
ck("uptime 缺失（旧网关）不因宽限卡住", run({ uptimeMs: undefined }).heal === true);

console.log("\n=== 2) 连续坏次数 ===");
ck("badStreak 1 → 不自愈", run({ badStreak: 1 }).heal === false);
ck("badStreak 2 → 自愈", run({ badStreak: 2 }).heal === true);
ck("badStreak 5 → 自愈", run({ badStreak: 5 }).heal === true);
ck("理由里带次数", run({ badStreak: 2 }).why.includes("2"));

console.log("\n=== 3) 冷却 ===");
ck("冷却中不自愈", run({ cooldownOk: false }).heal === false);
ck("冷却理由", run({ cooldownOk: false }).why.includes("冷却"));

console.log("\n=== 4) 自定义参数 ===");
ck("graceMs=0 时立即放行", run({ graceMs: 0, uptimeMs: 1000 }).heal === true);
ck("minStreak=1 时一次即自愈", run({ minStreak: 1, badStreak: 1 }).heal === true);
ck("minStreak=3 时 2 次还不够", run({ minStreak: 3, badStreak: 2 }).heal === false);

console.log("\n=== 5) 只做判定，不产生副作用 ===");
ck("返回对象只含 heal/why", Object.keys(run()).sort().join(",") === "heal,why", Object.keys(run()).join(","));

console.log("\n合计 " + (pass + fail) + " 项：" + pass + " 通过，" + fail + " 失败");
process.exit(fail ? 1 : 0);
