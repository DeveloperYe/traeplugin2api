// 工具名守卫（A4）：未声明名字的识别 / 别名 / 大小写宽容 / 回灌文案 / 正文剔除
const { normalizeName, resolveToolName, partitionCalls, feedbackHint, stripIllegalCalls } = require('./lib/tool-guard.cjs');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra === undefined ? '' : '  → ' + JSON.stringify(extra))); }
}

const declared = ['write_file', 'read_file', 'grep'];

// ---------- 归一化 ----------
check('归一化去掉下划线与大小写', normalizeName('Write_File') === 'writefile', normalizeName('Write_File'));
check('归一化保留数字', normalizeName('tool2_x') === 'tool2x');

// ---------- 名字解析 ----------
check('完全相等命中', resolveToolName('write_file', declared) === 'write_file');
check('大小写差异命中', resolveToolName('WRITE_FILE', declared) === 'write_file');
check('下划线差异命中', resolveToolName('writefile', declared) === 'write_file');
check('横线差异命中', resolveToolName('read-file', declared) === 'read_file');
check('未声明返回 null', resolveToolName('get_weather', declared) === null);
check('空名返回 null', resolveToolName('', declared) === null);
check('别名表命中', resolveToolName('写文件', declared, { '写文件': 'write_file' }) === 'write_file');
check('别名指向未声明 → null', resolveToolName('写文件', declared, { '写文件': 'delete_file' }) === null);
check('别名值大小写不同也能解析', resolveToolName('wf', declared, { wf: 'WRITE_FILE' }) === 'write_file');

// ---------- 分流 ----------
const part = partitionCalls(
  [{ name: 'write_file' }, { name: 'get_weather' }, { name: 'Grep' }],
  declared
);
check('合法调用保留 2 个', part.ok.length === 2, part.ok.map((c) => c.name));
check('非法调用识别 1 个', part.illegal.length === 1 && part.illegal[0].name === 'get_weather', part.illegal.map((x) => x.name));
check('大写的 Grep 被归一化成 grep', part.ok.some((c) => c.name === 'grep'), part.ok.map((c) => c.name));
check('归一化记录来源名', part.ok.find((c) => c.name === 'grep').nameResolvedFrom === 'Grep');
check('完全相等的没有来源名', part.ok.find((c) => c.name === 'write_file').nameResolvedFrom === null);
check('空调用数组安全', partitionCalls([], declared).ok.length === 0 && partitionCalls(undefined, declared).illegal.length === 0);

// ---------- 回灌文案 ----------
const hint = feedbackHint(['get_weather']);
check('文案点名非法工具', hint.includes('get_weather'), hint.slice(0, 60));
check('文案说明「不在已声明列表里」', /已声明/.test(hint));
check('文案给出二选一指令', /CALL <工具名>/.test(hint) && /正文回答/.test(hint));
check('文案不复述工具清单（不出现合法工具名列表）', !/write_file.*read_file/.test(hint));
const hint2 = feedbackHint(['a', 'a', 'b']);
check('多个非法名去重（列举段只列一次）', hint2.includes('`a`、`b`') && hint2.includes('`b`'), hint2.slice(0, 80));

// ---------- 正文剔除 ----------
const body = [
  '我来看一下天气。',
  'CALL get_weather {"city":"北京"}',
  '然后写文件：',
  'CALL write_file {"path":"D:/a.txt","content":"hi"}',
].join('\n');
const stripped = stripIllegalCalls(body, ['get_weather']);
check('剔掉非法 CALL 行', !stripped.includes('get_weather'), stripped);
check('保留合法 CALL 行', stripped.includes('CALL write_file'), stripped);
check('保留正文前缀', stripped.includes('我来看一下天气'));

const multi = ['CALL get_weather {', '  "city": "北京"', '}', '之后的话'].join('\n');
const stripped2 = stripIllegalCalls(multi, ['get_weather']);
check('多行参数一起剔除', !stripped2.includes('city') && stripped2.includes('之后的话'), JSON.stringify(stripped2));

check('没有非法名时原样返回', stripIllegalCalls(body, []) === body);
check('空正文安全', stripIllegalCalls('', ['x']) === '');

// ---------- 与 server 的策略语义对齐（passthrough 不该剔除） ----------
// 这里只验证纯函数：stripIllegalCalls 是显式调用，调用方按模式决定是否调用

console.log('\n合计 ' + (pass + fail) + ' 项：' + pass + ' 通过，' + fail + ' 失败');
process.exit(fail ? 1 : 0);
