// 回归测试：data/prompt.md 模板机制（不启用时零影响；启用后整段替换 + 占位符替换）
const fs = require("fs");
const path = require("path");
const REPO = __dirname;
const { buildToolInstruction, PROMPT_FILE } = require(path.join(REPO, "lib", "tools-bridge.cjs"));

const TOOLS = [
  { type: "function", function: { name: "web_search", description: "联网搜索",
    parameters: { type: "object", properties: { queries: { type: "array", items: { type: "string" } } }, required: ["queries"] } } },
  { type: "function", function: { name: "read_file", description: "读文件",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } },
];
const render = (opts = {}) => buildToolInstruction(TOOLS, undefined, { nativeBan: true, depth: 3, budget: 24000, report: {}, ...opts });

let pass = 0, fail = 0;
const ck = (name, cond, extra = "") => { if (cond) { pass++; console.log("  ✓ " + name); } else { fail++; console.log("  ✗ " + name + (extra ? "  → " + extra : "")); } };

// 备份可能存在的真实模板
const bak = fs.existsSync(PROMPT_FILE) ? fs.readFileSync(PROMPT_FILE) : null;
try {
  console.log("=== 1) 没有模板：内置文本，且与历史行为一致 ===");
  if (fs.existsSync(PROMPT_FILE)) fs.rmSync(PROMPT_FILE, { force: true });
  const a = render();
  ck("含内置开头", a.startsWith("你现在可以使用【外部工具】"), a.slice(0, 40));
  ck("含工具清单", a.includes("1. web_search") && a.includes("2. read_file"));
  ck("含内置工具禁令（native_ban=true）", a.includes("【关于\"内置工具\"") && a.includes("WebSearch"));
  ck("渲染长度合理（>1500 字符）", a.length > 1500, String(a.length));

  console.log("\n=== 2) native_ban=false：不注入禁令 ===");
  const b = render({ nativeBan: false });
  ck("没有禁令段", !b.includes("【关于\"内置工具\""), "仍含禁令");
  ck("工具清单仍在", b.includes("web_search"));

  console.log("\n=== 3) 放入 data/prompt.md：整段替换 + 占位符替换 ===");
  fs.mkdirSync(path.dirname(PROMPT_FILE), { recursive: true });
  fs.writeFileSync(PROMPT_FILE, [
    "【自定义协议 v9】",
    "工具清单：",
    "{{TOOLS}}",
    "禁令：",
    "{{NATIVE_BAN}}",
    "格式：CALL <name> {json}",
  ].join("\n"), "utf8");
  const c = render();
  ck("模板生效（首行被替换）", c.startsWith("【自定义协议 v9】"), c.slice(0, 30));
  ck("不再含内置文本", !c.includes("你现在可以使用【外部工具】"));
  ck("{{TOOLS}} 被替换", !c.includes("{{TOOLS}}") && c.includes("1. web_search"));
  ck("{{NATIVE_BAN}} 被替换", !c.includes("{{NATIVE_BAN}}") && c.includes("WebSearch"));
  ck("模板尾部格式行保留", c.includes("格式：CALL <name> {json}"));

  console.log("\n=== 4) 模板 + native_ban=false：占位符替换为空 ===");
  const d = render({ nativeBan: false });
  ck("禁令占位符替换为空", !d.includes("WebSearch") && !d.includes("{{NATIVE_BAN}}"));

  console.log("\n=== 5) 改模板后热重载（按 mtime）===");
  const t0 = Date.now(); while (Date.now() - t0 < 20) { /* 等同毫秒过去 */ }
  fs.writeFileSync(PROMPT_FILE, "【v10】\n{{TOOLS}}", "utf8");
  const e = render();
  ck("按 mtime 热重载生效", e.startsWith("【v10】"), e.slice(0, 20));
} finally {
  try { if (bak) fs.writeFileSync(PROMPT_FILE, bak); else fs.rmSync(PROMPT_FILE, { force: true }); } catch {}
}

console.log("\n合计 " + (pass + fail) + " 项：" + pass + " 通过，" + fail + " 失败");
process.exit(fail ? 1 : 0);
