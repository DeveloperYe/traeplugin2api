// 面板一致性：表格列数对齐 + 状态标签与实际写出的 status 全覆盖（P3 #12）
const fs = require('fs');
const path = require('path');
const { STATUS } = require('./lib/stream-meta.cjs');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra === undefined ? '' : '  → ' + JSON.stringify(extra))); }
}

const html = fs.readFileSync(path.join(__dirname, 'public/index.html'), 'utf8');
const lines = html.split(/\r?\n/);

// ---------- 1) 表头列数 vs 行内 <td> 数 ----------
function thCount(startIdx) {
  // 从含 <table 的行往后找 </thead>，统计中间的 <th>
  let seg = '';
  for (let i = startIdx; i < Math.min(lines.length, startIdx + 12); i++) {
    seg += lines[i] + '\n';
    if (lines[i].includes('</thead>')) break;
  }
  return (seg.match(/<th>/g) || []).length;
}

const reqIdx = lines.findIndex((l) => l.includes('<table id="journal"'));
check('找到请求日志表（id=journal）', reqIdx >= 0);
if (reqIdx >= 0) {
  const head = thCount(reqIdx);
  const rowStart = lines.findIndex((l) => l.includes('tr.innerHTML = `<td>${new Date(r.ts)'));
  const block = lines.slice(rowStart, rowStart + 10).join('\n');
  const tds = (block.match(/<td/g) || []).length;
  check('请求日志：表头列数 == 行内单元格数', head === tds, { head, tds });
  check('请求日志：含「未声明」列', /<th>未声明<\/th>/.test(html));
}

const errIdx = lines.findIndex((l) => l.includes('<table id="errors"'));
check('找到错误汇总表', errIdx >= 0);
if (errIdx >= 0) {
  const head = thCount(errIdx);
  const rowStart = lines.findIndex((l) => l.includes('tr.innerHTML = `<td>${lv}'));
  const block = lines.slice(rowStart, rowStart + 6).join('\n');
  const tds = (block.match(/<td/g) || []).length;
  check('错误汇总：表头列数 == 行内单元格数', head === tds, { head, tds });
  check('错误汇总：含「等级」列', /<th>等级<\/th>/.test(html));
}

// ---------- 2) 状态标签覆盖 ----------
const labelStart = lines.findIndex((l) => l.includes('const STATUS_LABEL'));
const labelBlock = lines.slice(labelStart, labelStart + 24).join('\n');
const labels = new Set([...labelBlock.matchAll(/^\s*([a-z_]+):\s*\[/gm)].map((m) => m[1]));
const statuses = Object.values(STATUS);
const missing = statuses.filter((x) => !labels.has(x));
check('代码里写出的每个 status 都有面板标签', missing.length === 0, missing);
check('标签表没有已废弃的 truncated（旧写法）', !labels.has('truncated'));

// 面板标签里多出来的键（允许的例外：ok/tool_calls 之类都在 STATUS 里，这里只查反方向）
const stale = [...labels].filter((x) => !statuses.includes(x));
check('标签表没有多余键', stale.length === 0, stale);

// ---------- 3) 失败分类与标签级别一致 ----------
const meta = require('./lib/stream-meta.cjs');
const levelMismatch = [];
for (const st of statuses) {
  const lv = meta.levelOf(st);
  const m = labelBlock.match(new RegExp('^\\s*' + st + ':\\s*\\[\\s*\'(\\w+)\'', 'm'));
  if (!m) continue;
  const panelLevel = m[1];
  const wantLevel = lv === null ? 'ok' : lv;
  // tool_calls 面板故意用 warn 色高亮（表示「这轮是工具调用」），不代表失败，属已知例外
  const EXEMPT = { tool_calls: 'warn' };
  if (EXEMPT[st] === panelLevel) continue;
  if (panelLevel !== wantLevel) levelMismatch.push(st + ': 面板=' + panelLevel + ' 期望=' + wantLevel);
}
check('面板标签级别与 fail 分类一致', levelMismatch.length === 0, levelMismatch);

console.log('\n合计 ' + (pass + fail) + ' 项：' + pass + ' 通过，' + fail + ' 失败');
process.exit(fail ? 1 : 0);
