// 严格版「工作区声明」识别（关键词 + 分隔符 + 绝对路径，同一行）
//
// 关键事实（2026-11-24 核实）：DSH 会把工作目录放在一条 **user 消息**里发过来，形如：
//   Current runtime context. This snapshot supersedes earlier runtime-context snapshots.
//   Current working directory: "D:\Users\Administrator\Documents\deepseek-harness\github".
// 所以默认 scope 必须包含 user（且要能处理 content 为数组的多模态消息）。
//
// 防误命中（用户明确要求过的场景）：
//   「我在调试另一个项目，这个项目目录在 D:/x 下」→ 不算声明（关键词后跟的是「在」，不是分隔符）
//   「工作目录：D:/x」「workspace: /a/b」「Working directory is D:/x」→ 算

const WIN_PATH = /[A-Za-z]:[\\/][^\s"'`<>|*?，。；：）)】\]]*/;
const POSIX_PATH = /\/(?:[\w.@-]+\/){1,}[\w.@-]*/;

const KEYWORDS = ["current working directory", "working directory", "project root", "workspace", "工作目录", "工作区", "项目根目录", "cwd"];
const DELIMS = ["：", ":", "=", "是", "为", "is"];

function toForward(p) {
  let s = String(p || "").trim().replace(/\\/g, "/");
  // 折叠重复斜杠：盘符后 D://x → D:/x；其它位置 a//b → a/b（保留 UNC 前缀 //server/share）
  s = s.replace(/^([A-Za-z]:)\/{2,}/, "$1/");
  s = s.replace(/([^:/])\/{2,}/g, "$1/");
  return s.replace(/\/+$/, "");
}

const isAbsolute = (p) => /^[A-Za-z]:\//.test(p) || (p.startsWith("/") && p.length > 1 && !/^\/{2,}$/.test(p));

function matchInLine(line) {
  const low = String(line || "").toLowerCase();
  for (const kw of KEYWORDS) {
    const kwLow = kw.toLowerCase();
    let from = 0;
    for (;;) {
      const i = low.indexOf(kwLow, from);
      if (i < 0) break;
      from = i + kwLow.length;
      let rest = String(line).slice(i + kwLow.length);
      const head = rest.slice(0, 12);
      let delimAt = -1, delimLen = 0;
      for (const d of DELIMS) {
        const j = head.indexOf(d);
        if (j >= 0 && (delimAt < 0 || j < delimAt)) { delimAt = j; delimLen = d.length; }
      }
      if (delimAt < 0) continue;
      rest = rest.slice(delimAt + delimLen).replace(/^[\s"'`（(【\[]+/, "");
      const win = rest.match(WIN_PATH);
      const posix = rest.match(POSIX_PATH);
      const cand = win && win.index === 0 ? win[0] : posix && posix.index === 0 ? posix[0] : null;
      if (!cand) continue;
      const p = toForward(cand);
      if (isAbsolute(p)) return p;
    }
  }
  return null;
}

// content 可能是字符串，也可能是 [{type:'text',text:...}, …]
function textOf(m) {
  const c = m && m.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((x) => (typeof x === "string" ? x : (x && x.text) || "")).join("\n");
  return "";
}

function extractDeclared(messages, { scope = "all" } = {}) {
  if (!Array.isArray(messages)) return null;
  const sys = [], user = [];
  for (const m of messages) {
    if (!m) continue;
    const t = textOf(m);
    if (!t) continue;
    if (m.role === "system" || m.role === "developer") sys.push(t);
    else if (m.role === "user" && scope === "all") user.push(t);
  }
  const scan = (texts) => {
    for (const t of texts) {
      for (const line of t.split(/\r?\n/)) {
        const hit = matchInLine(line);
        if (hit) return hit;
      }
    }
    return null;
  };
  // system 优先；user 里的「Current working directory: …」也认（DSH 就是这么发的）
  return scan(sys) || scan(user);
}

module.exports = { extractDeclared, matchInLine, toForward, textOf };
