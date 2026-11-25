// 静默 catch 闸门：把「没有注解的空 catch」数量钉在基线，涨了就失败。
// 为什么：空 catch 会让真故障无声消失（本项目就踩过：配置读失败静默用默认值、
// 错误汇总看不到失败、loadJournal 从未被调用、轮转失败无声……）。
// 约定：
//   - 「有意静默」的（关 socket、删临时文件、清定时器）可以保留，但**数量不许增长**；
//   - 新增静默必须写成 `catch (e) { /* 有意静默：原因 */ }`，并把基线调高（同一次提交里改）；
//   - 请求路径文件（server.cjs / lib/aha.cjs / lib/creds.cjs / lib/trae.cjs）额外受"必须注解"约束：
//     这些文件里未注解的空 catch 数同样不许超过基线。
const fs = require('fs');
const path = require('path');

const BASELINE_FILE = path.join(__dirname, 'tools', 'silent-catch-baseline.json');
const STRICT_FILES = ['server.cjs', 'lib/aha.cjs', 'lib/creds.cjs', 'lib/trae.cjs'];
const MARK = /有意静默|静默：/;
const EMPTY_CATCH = /\bcatch\s*(\([^)]*\))?\s*\{\s*\}/;

function listSources() {
  const files = [];
  for (const f of fs.readdirSync(__dirname)) if (/^[^.].*\.cjs$/.test(f)) files.push(f);
  for (const d of ['lib', 'deploy', 'tools']) {
    if (!fs.existsSync(path.join(__dirname, d))) continue;
    for (const f of fs.readdirSync(path.join(__dirname, d))) if (/\.cjs$/.test(f)) files.push(d + '/' + f);
  }
  return files.sort();
}

function scan() {
  const out = {};
  let total = 0, unmarkedTotal = 0;
  for (const rel of listSources()) {
    const lines = fs.readFileSync(path.join(__dirname, rel), 'utf8').split(/\r?\n/);
    let empty = 0, unmarked = 0;
    for (const line of lines) {
      if (!EMPTY_CATCH.test(line)) continue;
      empty++;
      if (!MARK.test(line)) unmarked++;
    }
    if (empty) out[rel] = { empty, unmarked };
    total += empty;
    unmarkedTotal += unmarked;
  }
  return { files: out, total, unmarkedTotal };
}

let pass = 0, fail = 0;
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra === undefined ? '' : '  → ' + JSON.stringify(extra))); }
};

const now = scan();
console.log('  空 catch 总数: ' + now.total + '（其中未注解 ' + now.unmarkedTotal + '）');

if (!fs.existsSync(BASELINE_FILE)) {
  fs.writeFileSync(BASELINE_FILE, JSON.stringify(now, null, 2) + '\n');
  console.log('  （基线不存在，已按当前值生成 tools/silent-catch-baseline.json）');
  pass++;
} else {
  const base = JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8'));

  // 只判定基线里列出的文件：生产目录常混有一次性探针脚本（probe-*.cjs / tmp-*.cjs 等），
  // 它们不在仓库里，不该让闸门失败；真正要防的是「仓库里的文件新增静默」。
  const known = new Set(Object.keys(base.files || {}));
  const grewEmpty = [];
  const grewUnmarked = [];
  const unknown = [];
  let knownTotal = 0;
  for (const [f, v] of Object.entries(now.files)) {
    if (!known.has(f)) { unknown.push(f); continue; }
    knownTotal += v.empty;
    const b = base.files[f];
    if (v.empty > b.empty) grewEmpty.push(f + ': 空 catch ' + b.empty + ' → ' + v.empty);
    if (v.unmarked > b.unmarked) grewUnmarked.push(f + ': 未注解 ' + b.unmarked + ' → ' + v.unmarked);
  }
  if (unknown.length) console.log('  ℹ 不在基线里的文件（跳过判定，' + unknown.length + ' 个）: ' + unknown.slice(0, 8).join(', ') + (unknown.length > 8 ? ' …' : ''));
  check('没有新增空 catch', grewEmpty.length === 0, grewEmpty);
  check('没有新增未注解的空 catch', grewUnmarked.length === 0, grewUnmarked);
  check('基线内文件的总数没有增长（基线 ' + base.total + '）', knownTotal <= base.total, { baseline: base.total, now: knownTotal });

  const shrank = Object.keys(base.files || {}).filter((f) => !now.files[f] || now.files[f].empty < base.files[f].empty);
  if (shrank.length) console.log('  ℹ 这些文件的空 catch 变少了，可以把基线调低：' + shrank.join(', '));
}

// 严格文件：未注解的必须在基线内（上面已比过），再单独提示当前明细便于清理
const strictDetail = {};
for (const f of STRICT_FILES) if (now.files[f]) strictDetail[f] = now.files[f];
console.log('  请求路径文件明细: ' + JSON.stringify(strictDetail));

console.log('\n合计 ' + (pass + fail) + ' 项：' + pass + ' 通过，' + fail + ' 失败');
process.exit(fail ? 1 : 0);
