// config.json 的 JSONC 容错：示例文件带注释与尾逗号，旧版会解析失败并静默退回默认值。
// 这里验证 stripJsonc 后能正确解析，且不误删字符串里的 "//"。
const path = require('path');
const fs = require('fs');
const { stripJsonc } = require('./lib/trae.cjs');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}

// 1) 纯 JSON 不需要改动
const plain = '{"a":1,"b":[1,2]}';
check('纯 JSON 原样可解析', JSON.stringify(JSON.parse(stripJsonc(plain))) === plain);

// 2) 行注释
const line = '{\n  "a": 1, // 这是注释\n  "b": 2\n}';
check('去掉 // 行注释', JSON.parse(stripJsonc(line)).a === 1 && JSON.parse(stripJsonc(line)).b === 2);

// 3) 块注释
const block = '{ /* 前言 */ "a": 1, "b": 2 /* 结尾 */ }';
check('去掉 /* */ 块注释', JSON.parse(stripJsonc(block)).b === 2);

// 4) 尾逗号
const trailing = '{"a":1,"b":[1,2,],"c":{"d":1,},}';
const t = JSON.parse(stripJsonc(trailing));
check('去掉对象/数组尾逗号', t.b.length === 2 && t.c.d === 1);

// 5) 字符串里的 // 与 /* 不能被当注释
const inStr = '{"url":"http://127.0.0.1:18790/v1","glob":"a/*/b","n":1}';
const s = JSON.parse(stripJsonc(inStr));
check('字符串内 // 不被删', s.url === 'http://127.0.0.1:18790/v1', s.url);
check('字符串内 /* 不被删', s.glob === 'a/*/b', s.glob);

// 6) 转义引号里的 // 也不能被删
const esc = '{"note":"引号 \\" 后面 // 不是注释"}';
check('转义引号后的 // 不被删', JSON.parse(stripJsonc(esc)).note.includes('//'));

// 7) 真正坏的 JSON 仍然会抛错（不能把错误吞掉）
let threw = false;
try { JSON.parse(stripJsonc('{"a": 1,, "b":}')); } catch { threw = true; }
check('坏 JSON 仍抛错', threw);

// 8) 仓库里的示例文件剥注释后可解析，且包含本文档提到的容量覆盖表
const example = stripJsonc(fs.readFileSync(path.join(__dirname, 'config.example.json'), 'utf8'));
const ex = JSON.parse(example);
check('config.example.json 剥注释后可解析', !!ex && typeof ex === 'object');
check('示例含 context_window_override', !!ex.context_window_override && ex.context_window_override['DeepSeek-V4-Pro'] === 1048576);
check('示例含 max_tokens_override', !!ex.max_tokens_override && ex.max_tokens_override['DeepSeek-V4-Pro'] === 131072);
check('示例含 idle_timeout_ms / stream_keepalive_ms', ex.idle_timeout_ms > 0 && ex.stream_keepalive_ms > 0);
check('示例含 prompt_max_tokens_override', !!ex.prompt_max_tokens_override);
check('示例含 max_tokens_note', !!ex.max_tokens_note && !!ex.max_tokens_note['DeepSeek-V4-Pro']);

console.log('\n合计 ' + (pass + fail) + ' 项：' + pass + ' 通过，' + fail + ' 失败');
process.exit(fail ? 1 : 0);
