// 多形态 CALL 解析（移植 polymas2api/toolbridge.py 的思路）+ 单测
// 目标：模型怎么吐都要能解析出来，且不把正文误当参数。
const CALL_WORD = /\bCALL\b/;

/** 从 start（{ 或 [ 的位置）向后扫描，返回配平后的结束索引（不含），失败返回 -1 */
function scanBalanced(text, start) {
  const open = text[start];
  if (open !== '{' && open !== '[') return -1;
  const stack = [];
  let inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) { esc = false; continue; }
      if (ch === '\\') { esc = true; continue; }
      if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{' || ch === '[') stack.push(ch === '{' ? '}' : ']');
    else if (ch === '}' || ch === ']') {
      if (stack.pop() !== ch) return -1;
      if (!stack.length) return i + 1;
    }
  }
  return -1;
}

/** 修复非法转义序列（逐字符，不能用 lookahead 正则——会把已合法的 \\ 再补一层） */
function repairEscapes(s) {
  const VALID = '"\\/bfnrt';
  const HEX = /^[0-9a-fA-F]{4}$/;
  let out = '';
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch !== '\\') { out += ch; i++; continue; }
    const next = s[i + 1];
    if (next === undefined) { out += '\\\\'; i++; continue; }
    if (VALID.includes(next)) { out += ch + next; i += 2; continue; }
    // \u 必须后接 4 位十六进制，否则也算非法（C:\users 里的 \u 就是这种）
    if (next === 'u' && HEX.test(s.slice(i + 2, i + 6))) { out += s.slice(i, i + 6); i += 6; continue; }
    out += '\\\\';
    i++;
  }
  return out;
}

/** 修复模型常见的非法 JSON：非法转义、尾逗号、中文引号 */
function repairJson(text) {
  let s = String(text).trim();
  s = s.replace(/[\u201c\u201d]/g, '"').replace(/[\u2018\u2019]/g, "'");
  s = repairEscapes(s);
  // 尾逗号
  s = s.replace(/,\s*([}\]])/g, '$1');
  return s;
}

// ---------- 合法转义的静默错解（Windows 路径 \n \t \b \f \r） ----------
// JSON 里 \b \f \n \r \t 是合法转义，所以 "C:\new\test.txt" 会被解成换行+制表符，
// 不报错但值悄悄错掉。做法参考 polymas2api：先修非法转义，再对"看起来是路径"的值
// 把合法转义双写后重解一次。

const PATH_KEY_RE = /(^|_)(path|paths|file|files|filename|dir|dirs|folder|workdir|cwd|root|src|dest|dst|target|output|input)($|_)/i;
const COMMAND_KEY_RE = /(^|_)(command|cmd|script|code|shell|bash|powershell|pwsh)($|_)/i;
const DRIVE_RE = /[A-Za-z]:[\\/]|^\\\\/;
const CTRL_RE = /[\u0000-\u001f]/;

/** 把合法转义双写：\n -> \\n（\\ 本身保持不变） */
function doubleLegalEscapes(s) {
  const LEGAL = new Set(['b', 'f', 'n', 'r', 't']);
  let out = '';
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch !== '\\') { out += ch; i++; continue; }
    const next = s[i + 1];
    if (next === undefined) { out += '\\\\'; i++; continue; }
    if (next === '\\') { out += '\\\\'; i += 2; continue; }   // 已是转义反斜杠，原样保留
    if (LEGAL.has(next)) { out += '\\\\' + next; i += 2; continue; }  // \n -> \\n
    out += ch + next;
    i += 2;
  }
  return out;
}

function walkStrings(node, keyPath, fn) {
  if (typeof node === 'string') { fn(node, keyPath); return; }
  if (Array.isArray(node)) { node.forEach((v, i) => walkStrings(v, keyPath, fn)); return; }
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) walkStrings(v, k, fn);
  }
}

/** 解析出的值里有没有"被合法转义吃掉"的路径迹象 */
function hasMangledPath(obj) {
  let mangled = false;
  let driveInCommand = false;
  walkStrings(obj, '', (val, key) => {
    if (!CTRL_RE.test(val)) return;
    if (PATH_KEY_RE.test(key || '')) { mangled = true; return; }
    if (DRIVE_RE.test(val)) { mangled = true; return; }
    if (COMMAND_KEY_RE.test(key || '')) driveInCommand = true;
  });
  return { mangled, driveInCommand };
}

/**
 * 把 JSON 字符串内部的裸控制字符（真实换行/制表/回车）转成合法转义。
 * 模型写大参数（整段 SVG/代码）时经常直接在字符串里换行，严格 JSON 会拒收；
 * 网关侧替它修好，模型就不用再"逐字符校验转义"——实测这种自我校验占用了大量思考预算。
 */
function escapeRawControlChars(text) {
  let out = '';
  let inStr = false;
  let esc = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (esc) { out += ch; esc = false; continue; }
    if (ch === '\\') { out += ch; esc = true; continue; }
    if (ch === '"') { inStr = !inStr; out += ch; continue; }
    if (inStr && (ch === '\n' || ch === '\r' || ch === '\t')) {
      out += ch === '\n' ? '\\n' : (ch === '\r' ? '\\r' : '\\t');
      continue;
    }
    out += ch;
  }
  return out;
}

/** 解析一段 CALL 的参数：严格 → 修非法转义 → 控制字符守卫 */
function parseArgs(jsonText) {
  const raw = String(jsonText || '').trim();
  if (!raw) return null;

  let parsed = null;
  let text = raw;
  let repaired = false;
  try { parsed = JSON.parse(raw); } catch {
    // 先试：字符串里写了真实换行（模型最自然的写法）
    const ctrlFixed = escapeRawControlChars(raw);
    if (ctrlFixed !== raw) {
      try { parsed = JSON.parse(ctrlFixed); text = ctrlFixed; repaired = true; } catch {}
    }
    if (parsed === null) {
      text = repairJson(raw);
      repaired = true;
      try { parsed = JSON.parse(text); } catch {
        // 最后兜底：控制字符 + 非法转义一起修
        const both = escapeRawControlChars(repairJson(raw));
        try { parsed = JSON.parse(both); text = both; } catch { return null; }
      }
    }
  }

  const { mangled, driveInCommand } = hasMangledPath(parsed);
  if (!mangled && !driveInCommand) return parsed;

  // 重解：把合法转义双写后再解析一次（顺序关键：非法转义必须已经修完，见 repaired）
  const base = repaired ? text : repairJson(raw);
  const doubled = doubleLegalEscapes(base);
  let alt = null;
  try { alt = JSON.parse(doubled); } catch { return parsed; }

  if (mangled) return alt;

  // command 类参数：只有"双写之后才显出盘符"才采用（避免把正文真换行改坏）
  const hasDrive = (o) => { let hit = false; walkStrings(o, '', (v) => { if (DRIVE_RE.test(v)) hit = true; }); return hit; };
  if (driveInCommand && hasDrive(alt) && !hasDrive(parsed)) return alt;
  return parsed;
}

/** 收集所有 CALL 候选：{ name, jsonText, index, end, form } */
function findCallCandidates(raw) {
  const out = [];
  const s = raw;
  const re = /\bCALL\b/g;
  let m;
  while ((m = re.exec(s))) {
    const after = s.slice(m.index + m[0].length);
    // 允许 CALL 后跟空白/冒号/中括号/圆括号
    const head = /^\s*[:：]?\s*[\[\(]?\s*([A-Za-z_][\w.\-]*)\s*[\]\)]?\s*/.exec(after);
    if (!head) continue;
    const name = head[1];
    const argStartInAfter = head[0].length;
    let rest = after.slice(argStartInAfter);

    // 形式 1：紧跟 JSON 对象
    const first = rest.search(/[{[]/);
    if (first >= 0 && first <= 4) {
      const abs = m.index + m[0].length + argStartInAfter + first;
      const end = scanBalanced(s, abs);
      if (end > 0) {
        out.push({ name, jsonText: s.slice(abs, end), index: m.index, end, form: 'inline' });
        continue;
      }
    }

    // 形式 2：CALL 后面没有 JSON —— 找同一行或紧随的代码块里的 JSON
    const lineEnd = rest.indexOf('\n');
    const sameLine = lineEnd < 0 ? rest : rest.slice(0, lineEnd);
    if (/\{/.test(sameLine)) {
      const braceAt = rest.indexOf('{');
      const abs = m.index + m[0].length + argStartInAfter + braceAt;
      const end = scanBalanced(s, abs);
      if (end > 0) { out.push({ name, jsonText: s.slice(abs, end), index: m.index, end, form: 'same-line' }); continue; }
    }
    // 形式 3：后续 3 行内的第一个 JSON 对象（含 ```json 代码块）
    const window = s.slice(m.index, m.index + 600);
    const braceAt = window.search(/\{/);
    if (braceAt > 0) {
      const abs = m.index + braceAt;
      const end = scanBalanced(s, abs);
      if (end > 0) out.push({ name, jsonText: s.slice(abs, end), index: m.index, end, form: 'following' });
    }
  }
  // 去掉重叠候选（同一位置只留第一个成功的）
  const seen = new Set();
  return out.filter(c => { const k = c.index + ':' + c.name; if (seen.has(k)) return false; seen.add(k); return true; });
}

/** 主解析入口：返回 { calls, content, strict, rawCalls } */
function parseCalls(text) {
  const raw = String(text || '');
  if (!raw.trim()) return { calls: [], content: '', strict: false, rawCalls: [] };

  const cands = findCallCandidates(raw);
  const calls = [];
  const spans = [];
  for (const c of cands) {
    const parsed = parseArgs(c.jsonText);
    if (parsed === null) continue;
    calls.push({ name: c.name, argumentsText: JSON.stringify(parsed), parsed, form: c.form });
    spans.push([c.index, c.end]);
  }
  if (!calls.length) return { calls: [], content: raw.trim(), strict: false, rawCalls: [] };

  // 正文 = 原文去掉所有 CALL 片段，再去掉代码块残留标记
  let content = raw;
  for (const [a, b] of spans.sort((x, y) => y[0] - x[0])) content = content.slice(0, a) + content.slice(b);
  content = content
    .replace(/```[A-Za-z0-9_+-]*[ \t]*\r?\n?/g, '')
    .replace(/`CALL[^`]*`/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  const firstLine = raw.split('\n').find(l => l.trim().length) || '';
  const strict = /^\s*CALL\b/.test(firstLine);
  return { calls, content, strict, rawCalls: cands.map(c => c.form) };
}

/** 流式场景：CALL 已出现但 JSON 还没闭合 */
function hasUnterminatedCall(text) {
  const s = String(text || '');
  const at = s.search(/\bCALL\b/);
  if (at < 0) return false;
  const braceAt = s.indexOf('{', at);
  if (braceAt < 0) return true;
  return scanBalanced(s, braceAt) < 0;
}

module.exports = { parseCalls, hasUnterminatedCall, repairJson, repairEscapes, doubleLegalEscapes, escapeRawControlChars, parseArgs, scanBalanced, findCallCandidates, CALL_WORD };

