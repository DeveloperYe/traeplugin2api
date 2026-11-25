// 回归测试：工作区校验（只校验、不改行为）
const fs = require("fs");
const os = require("os");
const path = require("path");
const WSC = require(path.join(__dirname, "lib", "workspace-check.cjs"));

let pass = 0, fail = 0;
const ck = (n, c, e = "") => { if (c) { pass++; console.log("  ✓ " + n); } else { fail++; console.log("  ✗ " + n + (e ? "  → " + e : "")); } };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wsc-"));
const dir = path.join(tmp, "real").replace(/\\/g, "/");
const file = path.join(tmp, "a.txt").replace(/\\/g, "/");
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(file, "x");

console.log("=== 1) 声明抽取：只认「关键词 + 绝对路径」===");
ck("工作目录：D:/x", WSC.extractDeclared([{ role: "system", content: "当前工作目录是 " + dir }]) === dir);
ck("workspace: /home/a/b", WSC.extractDeclared([{ role: "system", content: "workspace: " + dir }]) !== null);
ck("无关键词的路径 → 不算声明", WSC.extractDeclared([{ role: "system", content: "工具装在 D:/tools/bin" }]) === null);
ck("相对路径 → 不算声明", WSC.extractDeclared([{ role: "system", content: "工作目录：github/foo" }]) === null);
ck("user 里的显式声明默认参与（DSH 把 cwd 放 user 消息）", WSC.extractDeclared([{ role: "user", content: "工作目录：" + dir }]) === dir);
ck("显式传 scope=system 时忽略 user", WSC.extractDeclared([{ role: "user", content: "工作目录：" + dir }], { scope: "system" }) === null);
ck("scope=all 时才认 user 里的显式声明", WSC.extractDeclared([{ role: "user", content: "工作目录：" + dir }], { scope: "all" }) === dir);
ck("全角括号包裹也能抓到", WSC.extractDeclared([{ role: "system", content: "工作目录：（" + dir + "）" }]) === dir);

console.log("\n=== 2) 存在性检查 ===");
const r1 = WSC.checkWorkspace(dir);
ck("真实目录 → ok", r1.ok === true && r1.kind === "ok", JSON.stringify(r1));
const r2 = WSC.checkWorkspace(dir + "/not-exist-xyz");
ck("不存在 → not-found", r2.ok === false && r2.kind === "not-found", JSON.stringify(r2));
const r3 = WSC.checkWorkspace(file);
ck("是文件 → not-a-dir", r3.ok === false && r3.kind === "not-a-dir", JSON.stringify(r3));
const r4 = WSC.checkWorkspace("");
ck("空 → empty", r4.ok === false && r4.kind === "empty");

console.log("\n=== 3) 报错文案 ===");
ck("不存在文案含路径与提示", WSC.describe(r2).includes(dir + "/not-exist-xyz") && WSC.describe(r2).includes("不存在"));
ck("文件文案含'不是目录'", WSC.describe(r3).includes("不是目录"));
ck("可写检查（可选）", WSC.checkWorkspace(dir, { requireWritable: true }).ok === true);

console.log("\n=== 4) 反斜杠与尾斜杠归一 ===");
ck("反斜杠路径可校验", WSC.checkWorkspace(dir.replace(/\//g, "\\") + "\\").ok === true);
ck("toForward 归一", WSC.toForward("D:\\a\\b\\") === "D:/a/b");

fs.rmSync(tmp, { recursive: true, force: true });
console.log("\n合计 " + (pass + fail) + " 项：" + pass + " 通过，" + fail + " 失败");
process.exit(fail ? 1 : 0);
