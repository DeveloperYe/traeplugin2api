// 单测：多形态 CALL 解析
const assert = require('assert');
const { parseCalls, hasUnterminatedCall, repairJson } = require('./lib/call-parse.cjs');
const { toOpenAIToolCalls } = require('./lib/tools-bridge.cjs');

let n = 0, fail = 0;
function t(name, fn) {
  n++;
  try { fn(); console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + '\n      ' + e.message); }
}

console.log('多形态解析');
t('标准单行', () => {
  const r = parseCalls('CALL get_weather {"city":"北京"}');
  assert.equal(r.calls.length, 1);
  assert.equal(r.calls[0].name, 'get_weather');
  assert.deepEqual(r.calls[0].parsed, { city: '北京' });
  assert.equal(r.strict, true);
  assert.equal(r.content, '');
});

t('CALL 前有说明文字（不算 strict）', () => {
  const r = parseCalls('好的，我来查一下。\nCALL get_weather {"city":"上海"}');
  assert.equal(r.calls.length, 1);
  assert.equal(r.strict, false);
  assert.ok(r.content.includes('好的'));
});

t('CALL 后跟正文', () => {
  const r = parseCalls('CALL read {"path":"a.txt"}\n正在读取，请稍候。');
  assert.equal(r.calls.length, 1);
  assert.ok(r.content.includes('正在读取'));
});

t('Windows 反斜杠非法转义（关键场景）', () => {
  const r = parseCalls('CALL read {"path":"D:\\code\\main.py"}');
  // 上面在 JS 里是合法 JSON；下面模拟模型吐的非法转义
  const bad = 'CALL read {"path":"D:\\code\\main.py"}'.replace('\\\\', '\\');
  const r2 = parseCalls(bad);
  assert.equal(r2.calls.length, 1, '非法转义应被修复');
  assert.equal(r2.calls[0].parsed.path, 'D:\\code\\main.py');
});

t('代码块包裹的 CALL', () => {
  const r = parseCalls('```\nCALL read {"path":"a.txt"}\n```');
  assert.equal(r.calls.length, 1);
  assert.equal(r.calls[0].parsed.path, 'a.txt');
});

t('调用形式 CALL name({...})', () => {
  const r = parseCalls('CALL get_weather({"city":"广州"})');
  assert.equal(r.calls.length, 1);
  assert.deepEqual(r.calls[0].parsed, { city: '广州' });
});

t('JSON 换行多行', () => {
  const r = parseCalls('CALL create {"title":"x","labels":["a","b"]}');
  assert.equal(r.calls.length, 1);
  assert.deepEqual(r.calls[0].parsed.labels, ['a', 'b']);
});

t('嵌套对象与转义引号', () => {
  const r = parseCalls('CALL t {"a":{"b":"say \\"hi\\""},"arr":[1,2]}');
  assert.equal(r.calls.length, 1);
  assert.equal(r.calls[0].parsed.a.b, 'say "hi"');
  assert.deepEqual(r.calls[0].parsed.arr, [1, 2]);
});

t('多个 CALL（并行）', () => {
  const r = parseCalls('CALL get_weather {"city":"北京"}\nCALL list_files {"dir":"D:/work"}');
  assert.equal(r.calls.length, 2);
  assert.deepEqual(r.calls.map(c => c.name), ['get_weather', 'list_files']);
});

t('尾逗号', () => {
  const r = parseCalls('CALL t {"a":1,"b":2,}');
  assert.equal(r.calls.length, 1);
  assert.deepEqual(r.calls[0].parsed, { a: 1, b: 2 });
});

t('无 CALL 时原样返回正文', () => {
  const r = parseCalls('递归是函数调用自身。');
  assert.equal(r.calls.length, 0);
  assert.ok(r.content.includes('递归'));
});

t('空输入', () => {
  const r = parseCalls('');
  assert.equal(r.calls.length, 0);
});

t('流式未闭合检测', () => {
  assert.equal(hasUnterminatedCall('CALL t {"a":'), true);
  assert.equal(hasUnterminatedCall('CALL t {"a":1}'), false);
  assert.equal(hasUnterminatedCall('普通回答'), false);
});

t('repairJson 不动合法内容', () => {
  const s = '{"path":"D:\\\\code","re":"\\\\d+"}';
  assert.equal(repairJson(s), s);
});

t('转 OpenAI tool_calls 结构', () => {
  const r = parseCalls('CALL read {"path":"a.txt"}');
  const tc = toOpenAIToolCalls(r, 'call');
  assert.equal(tc.length, 1);
  assert.equal(tc[0].type, 'function');
  assert.equal(tc[0].function.name, 'read');
  assert.equal(JSON.parse(tc[0].function.arguments).path, 'a.txt');
  assert.ok(tc[0].id.startsWith('call_'));
});

console.log('\n合法转义守卫（Windows 路径）');
function pathOf(sample) {
  const r = parseCalls(sample);
  if (!r.calls.length) return { missing: true };
  return r.calls[0].parsed;
}
t('C:\\new\\test.txt 不应变换行', () => {
  const v = pathOf('CALL read {"path":"C:\\new\\test.txt"}').path;
  assert.equal(v, 'C:\\new\\test.txt');
  assert.ok(!/[\u0000-\u001f]/.test(v));
});
t('C:\\bin\\tool.exe 不应变退格', () => {
  const v = pathOf('CALL read {"path":"C:\\bin\\tool.exe"}').path;
  assert.equal(v, 'C:\\bin\\tool.exe');
});
t('C:\\temp\\a.log（非法+合法混合）', () => {
  const v = pathOf('CALL read {"path":"C:\\temp\\a.log"}').path;
  assert.equal(v, 'C:\\temp\\a.log');
});
t('C:\\robots\\rules.txt（两个 \\r）', () => {
  const v = pathOf('CALL read {"path":"C:\\robots\\rules.txt"}').path;
  assert.equal(v, 'C:\\robots\\rules.txt');
});
t('路径藏在 command 里（参数名不是 path）', () => {
  const v = pathOf('CALL pwsh {"command":"Get-Item C:\\temp\\a.log"}').command;
  assert.equal(v, 'Get-Item C:\\temp\\a.log');
});
t('对照：正常转义路径不变', () => {
  const v = pathOf('CALL read {"path":"D:\\\\work\\\\ok.txt"}').path;
  assert.equal(v, 'D:\\work\\ok.txt');
});
t('反例：content 里的真换行不被改写', () => {
  const v = pathOf('CALL write {"path":"a.txt","content":"第1行\\n第2行"}').content;
  assert.equal(v, '第1行\n第2行');
  assert.ok(v.includes('\n'));
});
t('反例：content 里出现盘符字样也不误改', () => {
  // 期望：\t 仍是制表符（守卫只认 path 类键或值以盘符开头，不碰正文）
  const v = pathOf('CALL write {"path":"a.txt","content":"盘符是 D:\\temp 目录"}').content;
  assert.equal(v, '盘符是 D:\temp 目录');
});

console.log(`\n合计 ${n - fail}/${n} 通过`);
process.exit(fail ? 1 : 0);

