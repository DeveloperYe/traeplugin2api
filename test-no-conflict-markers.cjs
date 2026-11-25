// 回归检查：仓库里任何被跟踪的文本文件都不得含 Git 冲突标记。
// 由来：2026-11-23 一次跨分支 cherry-pick 把冲突标记提交进了 docs/MODEL-MAPPING.md 并推上远端。
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
const files = execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" })
  .split("\n").filter(Boolean)
  .filter((f) => /\.(md|cjs|js|mjs|ps1|sh|json|html|yml|yaml)$/i.test(f));

const MARK = /^(<<<<<<< |=======$|>>>>>>> )/;
const bad = [];
for (const f of files) {
  const p = path.join(ROOT, f);
  if (!fs.existsSync(p)) continue;
  const text = fs.readFileSync(p, "utf8");
  // ======= 单独出现也算问题，但代码里的分隔线可能误报：只在同时含 <<<<<<< 或 >>>>>>> 时才计入
  const hasLeft = /^<<<<<<< /m.test(text);
  const hasRight = /^>>>>>>> /m.test(text);
  if (hasLeft || hasRight) {
    const n = text.split("\n").filter((l) => MARK.test(l)).length;
    bad.push(f + " (" + n + " 处)");
  }
}
if (bad.length) {
  console.log("  ✗ 发现冲突标记：");
  bad.forEach((b) => console.log("      " + b));
  console.log("  合计 0/" + files.length + " 通过");
  process.exit(1);
}
console.log("  ✓ " + files.length + " 个文本文件均无冲突标记");
console.log("  合计 " + files.length + "/" + files.length + " 通过");
