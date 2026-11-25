// 回归测试：工作区声明识别的「防误命中」
// 核心诉求：用户聊天里说「我在调试另一个项目，这个项目目录在 D:/x 下」不能被当成工作区声明。
const path = require("path");
const WD = require(path.join(__dirname, "lib", "workspace-declare.cjs"));

let pass = 0, fail = 0;
const ck = (n, c, e = "") => { if (c) { pass++; console.log("  ✓ " + n); } else { fail++; console.log("  ✗ " + n + (e ? "  → " + e : "")); } };
const dec = (content, role = "system", opts = {}) => WD.extractDeclared([{ role, content }], opts);

console.log("=== 1) 用户叙述：不能误命中 ===");
for (const s of [
  "我在调试另一个项目，这个项目目录在 D:/proj/other 下",
  "这个项目的目录在 D:/proj/other 下",
  "这个项目目录在 D:/proj/x 下",
  "我在 D:/proj/c 里干活，这个目录是工作目录",
  "参考一下 /home/u/other 那个仓库怎么做的",
  "工具安装在 D:/tools/bin 下",
  "项目根目录结构说明见文档",
]) {
  ck("不命中：" + s.slice(0, 28), dec(s, "user") === null, String(dec(s, "user")));
}

console.log("\n=== 2) 显式声明：必须命中 ===");
ck("工作目录：D:/proj/a", dec("工作目录：D:/proj/a") === "D:/proj/a");
ck("当前工作目录是 D:/proj/a", dec("当前工作目录是 D:/proj/a") === "D:/proj/a");
ck("workspace: /home/u/demo", dec("workspace: /home/u/demo") === "/home/u/demo");
ck("workspace=/home/u/demo2", dec("workspace=/home/u/demo2") === "/home/u/demo2");
ck("Working directory is D:\\proj\\b", (dec("Working directory is D:\\proj\\b") || "").replace(/\//g, "\\") === "D:\\proj\\b");
ck("工作区为 D:/proj/c", dec("工作区为 D:/proj/c") === "D:/proj/c");

console.log("\n=== 3) 作用域：默认只看 system，user 里的声明需 scope=all ===");
const userDecl = [{ role: "user", content: "工作目录：D:/proj/u" }];
ck("现在默认认识 user 里的声明（DSH 把 cwd 放在 user 消息）", WD.extractDeclared(userDecl) === "D:/proj/u");
ck("显式传 scope=system 才只看 system", WD.extractDeclared(userDecl, { scope: "system" }) === null);

ck("system 里的声明默认识别", dec("工作目录：D:/proj/s") === "D:/proj/s");

console.log("\n=== 4) 关键词后必须紧跟分隔符（隔太远不算）===");
ck("「工作区在项目里，另外 D:/x」不算", dec("工作区在项目里，另外 D:/x 是别的") === null);
ck("关键词后 12 字符内有冒号就算", dec("工作目录（本机）：D:/proj/paren") === null || dec("工作目录（本机）：D:/proj/paren") === "D:/proj/paren");

console.log("\n=== 5) 归一化与边界 ===");
ck("反斜杠归一", dec("工作目录：D:\\proj\\d").replace(/\//g, "\\") === "D:\\proj\\d");
ck("尾斜杠去掉", dec("工作目录：D:/proj/e/") === "D:/proj/e");
ck("相对路径不算", dec("工作目录：proj/rel") === null);


console.log("\n=== 6) DSH 的 runtime context（user 消息 + 数组 content）===");
{
  const dsh = [{
    role: "user",
    content: [{
      type: "text",
      text: "Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\n\nCurrent working directory: \"D:" + String.fromCharCode(92) + String.fromCharCode(92) + "Users" + String.fromCharCode(92) + String.fromCharCode(92) + "Administrator" + String.fromCharCode(92) + String.fromCharCode(92) + "Documents" + String.fromCharCode(92) + String.fromCharCode(92) + "deepseek-harness" + String.fromCharCode(92) + String.fromCharCode(92) + "github\".\n\nCurrent DSH file policy: danger-full-access.",
    }],
  }];
  ck("识别出 cwd", WD.extractDeclared(dsh) === "D:/Users/Administrator/Documents/deepseek-harness/github", String(WD.extractDeclared(dsh)));
  ck("数组 content 也能解析", WD.textOf(dsh[0]).startsWith("Current runtime context"));
}

console.log("\n合计 " + (pass + fail) + " 项：" + pass + " 通过，" + fail + " 失败");
process.exit(fail ? 1 : 0);
