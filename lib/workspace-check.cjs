// workspace-check.cjs —— 只做「校验」，不改行为
// 背景：客户端有时会在 system/user 里声明一个并不存在的工作目录（假路径）。
// 之前那套「自动切锚点」被回滚了；现在只做一件事：发现声明的目录不真实时，明确告诉调用方，
// 而不是把它悄悄发给上游（上游只会回一个空结果/奇怪报错）。

const WIN_PATH = /[A-Za-z]:[\\/][^\s"'`<>|*?，。；：）)】\]]*/g;
const POSIX_PATH = /\/(?:[\w.@-]+\/){1,}[\w.@-]*/g;

const WS_WORDS = /(工作区|工作目录|项目目录|项目根目录|根目录|workspace|working directory|project (?:root|dir)|cwd)/i;

function toForward(p) {
  return String(p || "").trim().replace(/\\/g, "/").replace(/\/+$/, "");
}

// 从消息里找「明确声明」的工作目录。
// 实现已收敛到 lib/workspace-declare.cjs 的严格版：
//   关键词必须紧跟分隔符（: ： = 是 为 is），然后是同行的绝对路径；
//   默认只看 system/developer（用户叙述「这个项目目录在 X 下」不会误命中）。
function extractDeclared(messages, opts) {
  return require("./workspace-declare.cjs").extractDeclared(messages, opts);
}


// 分类检查：ok / not-found / not-a-dir / not-writable
function checkWorkspace(target, { requireWritable = false } = {}) {
  const fs = require("fs");
  const p = toForward(target);
  if (!p) return { ok: false, kind: "empty", target: p };
  let st;
  try { st = fs.statSync(p); }
  catch { return { ok: false, kind: "not-found", target: p }; }
  if (!st.isDirectory()) return { ok: false, kind: "not-a-dir", target: p };
  if (requireWritable) {
    try { fs.accessSync(p, fs.constants.W_OK); }
    catch { return { ok: false, kind: "not-writable", target: p }; }
  }
  return { ok: true, kind: "ok", target: p };
}

const MESSAGES = {
  "not-found": (p) => `客户端声明的工作目录不存在：${p}（请检查路径拼写，或先在机器上创建该目录）`,
  "not-a-dir": (p) => `客户端声明的工作目录不是目录：${p}`,
  "not-writable": (p) => `客户端声明的工作目录不可写：${p}`,
  empty: () => "客户端声明的工作目录为空",
};

function describe(res) {
  const f = MESSAGES[res.kind] || MESSAGES["not-found"];
  return f(res.target);
}

module.exports = { extractDeclared, checkWorkspace, describe, toForward };
