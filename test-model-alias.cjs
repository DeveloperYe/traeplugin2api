// 回归测试：模型名解析（别名 / 未知拦截 / 近似提示 / 目录为空）
const assert = require("assert");
const { resolveModel, suggest } = require("D:/Users/Administrator/Documents/deepseek-harness/work/trae2api-release/lib/models.cjs");

const CATALOG = [
  "Doubao-Seed-2.0-Code", "Doubao-Seed-Code", "minimax-m2.7", "minimax-m2.5",
  "glm-5.1", "glm-5v-turbo", "glm-5", "DeepSeek-V4-Pro", "DeepSeek-V4-Flash",
  "kimi-k2.6", "qwen-3.6-plus",
];

let pass = 0, fail = 0;
const ck = (name, cond, extra = "") => {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (extra ? "  → " + extra : "")); }
};

console.log("=== 1) 精确匹配（大小写不敏感，回填目录里的写法）===");
let r = resolveModel({ requested: "Doubao-Seed-2.0-Code", catalog: CATALOG });
ck("原名通过", r.ok && r.name === "Doubao-Seed-2.0-Code" && r.reason === "exact");
r = resolveModel({ requested: "doubao-seed-2.0-code", catalog: CATALOG });
ck("小写也能匹配并回填真名", r.ok && r.name === "Doubao-Seed-2.0-Code");

console.log("\n=== 2) 用户这次遇到的场景：seed 2.1 turbo 不在目录 ===");
r = resolveModel({ requested: "Doubao-Seed-2.1-Turbo", catalog: CATALOG });
ck("被拒绝（不再静默替换）", r.ok === false && r.reason === "unknown");
ck("给出近似候选", r.suggestions.length > 0, JSON.stringify(r.suggestions));
ck("近似里含最接近的 Seed 系列", r.suggestions.some((x) => x.startsWith("Doubao-Seed")), JSON.stringify(r.suggestions));
console.log("    建议: " + r.suggestions.join(", "));
r = resolveModel({ requested: "seed-2.1-turbo", catalog: CATALOG });
ck("别的小写写法同样拒绝", r.ok === false);
console.log("    建议: " + r.suggestions.join(", "));

console.log("\n=== 3) 别名映射 ===");
r = resolveModel({ requested: "seed-2.1-turbo", catalog: CATALOG, aliases: { "seed-2.1-turbo": "Doubao-Seed-2.0-Code" } });
ck("别名命中并映射到真名", r.ok && r.name === "Doubao-Seed-2.0-Code" && r.reason === "alias");
r = resolveModel({ requested: "SEED-2.1-TURBO", catalog: CATALOG, aliases: { "seed-2.1-turbo": "Doubao-Seed-2.0-Code" } });
ck("别名大小写不敏感", r.ok && r.name === "Doubao-Seed-2.0-Code");
r = resolveModel({ requested: "x", catalog: CATALOG, aliases: { x: "不存在的模型" } });
ck("别名指向不存在的模型 → 仍拒绝", r.ok === false && r.reason === "unknown");

console.log("\n=== 4) 目录为空（上游拉取失败）===");
r = resolveModel({ requested: "Doubao-Seed-2.0-Code", catalog: [] });
ck("strict 默认拒绝（不假装通过）", r.ok === false && r.reason === "catalog-empty");
r = resolveModel({ requested: "Doubao-Seed-2.0-Code", catalog: [], strict: false });
ck("model_strict=false 时放行", r.ok === true);

console.log("\n=== 5) 空请求名 ===");
r = resolveModel({ requested: "", catalog: CATALOG });
ck("空名拒绝", r.ok === false && r.reason === "empty");

console.log("\n=== 5.5) 显示名匹配（上游 slug 与 display_name 不同）===");
const CAT_OBJS = [
  { name: "Doubao-Seed-2.0-Code", display_name: "Seed-2.1-Turbo" },
  { name: "Doubao-Seed-Code", display_name: "Seed-Code" },
  { name: "kimi-k2.6", display_name: "Kimi-K2.6" },
  { name: "qwen-3.6-plus", display_name: "Qwen3.6-Plus" },
];
let rd = resolveModel({ requested: "Seed-2.1-Turbo", catalog: CAT_OBJS.map(m => m.name), displayNames: CAT_OBJS });
ck("显示名 → slug", rd.ok && rd.name === "Doubao-Seed-2.0-Code" && rd.reason === "display");
rd = resolveModel({ requested: "seed 2.1 turbo", catalog: CAT_OBJS.map(m => m.name), displayNames: CAT_OBJS });
ck("带空格/小写也认", rd.ok && rd.name === "Doubao-Seed-2.0-Code");
rd = resolveModel({ requested: "Seed-2.1-Turbo", catalog: CAT_OBJS.map(m => m.name), displayNames: CAT_OBJS, aliases: { "Seed-2.1-Turbo": "kimi-k2.6" } });
ck("显式别名优先于显示名", rd.ok && rd.name === "kimi-k2.6" && rd.reason === "alias");
rd = resolveModel({ requested: "Seed-9.9-Nope", catalog: CAT_OBJS.map(m => m.name), displayNames: CAT_OBJS });
ck("显示名也不匹配时仍拒绝", rd.ok === false);

console.log("\n=== 6) suggest 排序常识 ===");
const s1 = suggest("glm5", CATALOG);
ck("glm5 优先给 glm-5", s1[0] === "glm-5", JSON.stringify(s1));
const s2 = suggest("kimi-k2", CATALOG);
ck("kimi-k2 优先给 kimi-k2.6", s2[0] === "kimi-k2.6", JSON.stringify(s2));

console.log("\n合计 " + (pass + fail) + " 项：" + pass + " 通过，" + fail + " 失败");
process.exit(fail ? 1 : 0);
