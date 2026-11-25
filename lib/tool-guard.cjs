// 工具名守卫：判断模型写的 CALL 名字是否在本次请求的 tools 声明里，
// 并把「非法调用」变成可以回灌给上游的反馈（让模型自己改），而不是悄悄丢掉或原样转发。
//
// 为什么要这层：Trae 通道没有原生工具通道，模型是在正文里手写 `CALL <名字> {json}`。
// 实测出现过「请求只声明 write_file，模型却写 CALL get_weather」且网关原样转发成 tool_calls
// （客户端收到自己没声明的工具，轻则报错重则误执行）。

const SEP = /[^a-z0-9]/g;

// 归一化：小写 + 去掉下划线/连字符/点，用于「大小写或下划线差异」的宽容匹配
function normalizeName(name) {
  return String(name || '').toLowerCase().replace(SEP, '');
}

/**
 * 把模型写的名字解析成「请求里声明过的工具名」。
 * 顺序：完全相等 → 归一化相等 → tool_aliases 映射（值必须是已声明的名字）。
 * @returns {string|null} 命中返回声明里的那个名字，否则 null
 */
function resolveToolName(name, declaredNames, aliases) {
  const raw = String(name || '').trim();
  if (!raw) return null;
  const declared = Array.isArray(declaredNames) ? declaredNames : [];
  if (declared.includes(raw)) return raw;

  const norm = normalizeName(raw);
  const byNorm = declared.find((d) => normalizeName(d) === norm);
  if (byNorm) return byNorm;

  const map = aliases && typeof aliases === 'object' ? aliases : {};
  const target = map[raw] ?? map[normalizeName(raw)];
  if (typeof target === 'string' && target) {
    if (declared.includes(target)) return target;
    const byAliasNorm = declared.find((d) => normalizeName(d) === normalizeName(target));
    if (byAliasNorm) return byAliasNorm;
  }
  return null;
}

/**
 * 把一次解析出来的调用分成「合法」与「非法」两堆，并顺手把合法调用的名字归一化成声明名。
 * @param {{name:string}[]} calls parseCalls 的结果
 * @returns {{ok: object[], illegal: {name:string, call:object}[]}}
 */
function partitionCalls(calls, declaredNames, aliases) {
  const ok = [];
  const illegal = [];
  for (const c of Array.isArray(calls) ? calls : []) {
    const resolved = resolveToolName(c && c.name, declaredNames, aliases);
    if (resolved) ok.push(Object.assign({}, c, { name: resolved, nameResolvedFrom: c.name === resolved ? null : c.name }));
    else illegal.push({ name: String((c && c.name) || ''), call: c });
  }
  return { ok, illegal };
}

/**
 * 回灌给上游的反馈文案。刻意**不复述工具清单**——工具说明已经在本轮 prompt 里声明过了，
 * 再贴一份既费 token 又容易让模型把两份清单混起来。只告诉它「这个名字不在已声明的那几个里」。
 */
function feedbackHint(illegalNames) {
  const names = [...new Set((illegalNames || []).filter(Boolean))];
  const listed = names.map((n) => '`' + n + '`').join('、');
  return [
    '',
    '【系统指令（高优先级）】你刚才输出了 ' + (listed || '一个工具调用') + '，但这个名字**不在本次请求已声明的工具列表里**（可用工具见前面的工具说明，不要自己发明名字）。',
    '请立刻重来一次，二选一：',
    '① 从已声明的工具里选一个，按 CALL <工具名> <参数JSON> 输出一行；',
    '② 如果确实不需要工具，就直接用正文回答。',
    '不要复述这条提示，也不要再调用 ' + (listed || '那个名字') + '。',
  ].join('\n');
}

/**
 * 把正文里针对非法名字的 CALL 段剔除（含多行 JSON 参数），
 * 避免把「CALL get_weather {...}」当普通文本回给客户端。
 * 做法：遇到非法 CALL 行就开始吞，直到这一段的括号配平为止，然后继续保留后面的正文。
 */
function stripIllegalCalls(content, illegalNames) {
  const text = String(content || '');
  const names = new Set((illegalNames || []).filter(Boolean).map((n) => String(n)));
  if (!names.size) return text;

  const depthOf = (line, start) => {
    let d = start;
    for (const ch of line) {
      if (ch === '{' || ch === '[') d++;
      else if (ch === '}' || ch === ']') d = Math.max(0, d - 1);
    }
    return d;
  };

  const lines = text.split(/\r?\n/);
  const out = [];
  let skipping = false;
  let depth = 0;
  for (const line of lines) {
    if (skipping) {
      depth = depthOf(line, depth);
      if (depth === 0) skipping = false;
      continue;
    }
    const m = line.match(/^[ \t]*CALL[ \t]*([A-Za-z0-9_.\-]+)/i);
    if (m && names.has(m[1])) {
      depth = depthOf(line, 0);
      skipping = depth > 0;   // 参数跨行才需要继续吞
      continue;
    }
    out.push(line);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

module.exports = { normalizeName, resolveToolName, partitionCalls, feedbackHint, stripIllegalCalls };
