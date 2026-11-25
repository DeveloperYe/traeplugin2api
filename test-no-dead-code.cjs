// 死代码守卫（review 2026-11-26 第二遍的产物）：
// 上一轮 loadJournal() 定义了却从没被调用，这类问题只能靠静态检查兜住。
// 三条规则：
//   1. server.cjs 里 require 进来的名字必须真的被用到；
//   2. server.cjs 顶层定义的函数必须至少被引用一次（定义处不算）；
//   3. lib/*.cjs 导出的成员必须被「非测试文件」用到；只被测试用到也算死角（INFO 提示，不失败）。
const fs = require('fs');
const path = require('path');

// 允许「只被测试用」的导出（写清理由）
const TEST_ONLY_OK = {
  'lib/stream-meta.cjs': ['STATUS', 'FAIL_LEVEL'],       // 词表：供 test-keepalive / test-panel-tables 校验
  'lib/tool-guard.cjs': ['normalizeName'],                // 内部用 + 测试要单独验证归一化
};

let pass = 0, fail = 0;
const info = [];
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra === undefined ? '' : '  → ' + JSON.stringify(extra))); }
};

const server = fs.readFileSync('server.cjs', 'utf8');
const testFiles = fs.readdirSync('.').filter((f) => /^test-.*\.cjs$/.test(f));
const libFiles = fs.readdirSync('lib').filter((f) => /\.cjs$/.test(f)).map((f) => 'lib/' + f);
const nonTestSrc = ['server.cjs', ...libFiles, ...fs.readdirSync('deploy').filter((f) => /\.cjs$/.test(f)).map((f) => 'deploy/' + f)]
  .map((f) => ({ f, s: fs.readFileSync(f, 'utf8') }));

// ---------- 1. server.cjs 的 import 是否都被使用 ----------
const body = server.replace(/const \{[^}]+\} = require\([^)]+\);/g, '');
const unusedImports = [];
for (const m of server.matchAll(/const \{([^}]+)\} = require\(([^)]+)\);/g)) {
  const names = m[1].split(',').map((x) => x.trim().split(':')[0].trim()).filter(Boolean);
  for (const n of names) {
    if ((body.match(new RegExp('\\b' + n + '\\b', 'g')) || []).length === 0) unusedImports.push(n + '（from ' + m[2] + '）');
  }
}
check('server.cjs 没有 import 了却不用的名字', unusedImports.length === 0, unusedImports);

// ---------- 2. server.cjs 顶层函数是否都被引用 ----------
const fnNames = [...server.matchAll(/^(?:async )?function ([A-Za-z0-9_]+)\s*\(/gm)].map((m) => m[1]);
const deadFns = [];
for (const fn of new Set(fnNames)) {
  // 引用形式：fn( 或 fn 作为值（setInterval(fn) / onX: fn）
  const re = new RegExp('\\b' + fn + '\\b', 'g');
  const total = (server.match(re) || []).length;
  if (total <= 1) deadFns.push(fn);   // 只有定义那一处
}
check('server.cjs 没有定义了却没人引用的函数', deadFns.length === 0, deadFns);

// ---------- 3. lib 导出是否被非测试代码使用 ----------
const deadExports = [];
for (const f of libFiles) {
  const src = fs.readFileSync(f, 'utf8');
  const m = src.match(/module\.exports\s*=\s*\{([\s\S]*?)\};/);
  if (!m) continue;
  // 全大写的是常量（词表/默认值），供测试或调用方取值用，不算死代码
  const names = m[1].split(',').map((x) => x.trim().split(':')[0].trim()).filter(Boolean)
    .filter((n) => !/^[A-Z][A-Z0-9_]*$/.test(n));
  const allow = TEST_ONLY_OK[f] || [];
  for (const n of names) {
    const usedOutside = nonTestSrc.some(({ f: other, s }) => {
      if (other === f) return false;
      return new RegExp('\\b' + n + '\\b').test(s);
    });
    const usedInside = new RegExp('\\b' + n + '\\s*\\(').test(src.replace(m[0], ''));
    if (usedOutside || usedInside) continue;
    const usedByTest = testFiles.some((t) => new RegExp('\\b' + n + '\\b').test(fs.readFileSync(t, 'utf8')));
    if (usedByTest && allow.includes(n)) { info.push(f + ' 的 ' + n + ' 只被测试用（已登记允许）'); continue; }
    deadExports.push(f + ' → ' + n + (usedByTest ? '（只被测试用）' : '（完全没人用）'));
  }
}
check('lib 没有被测试以外的代码都不用的导出', deadExports.length === 0, deadExports);

// ---------- 4. lib 模块本身必须被非测试代码引用（整模块死掉的情况） ----------
const orphanModules = [];
for (const f of libFiles) {
  const pats = ['lib/' + f.replace(/^lib\//, ''), './' + f.replace(/^lib\//, ''), '../lib/' + f.replace(/^lib\//, '')];
  const used = nonTestSrc.some(({ f: other, s }) => other !== f && pats.some((p) => s.includes(p)));
  if (!used) orphanModules.push(f);
}
check('没有「谁都不 require」的 lib 模块', orphanModules.length === 0, orphanModules);

if (info.length) { console.log('  ℹ ' + info.join('；')); }
console.log('\n合计 ' + (pass + fail) + ' 项：' + pass + ' 通过，' + fail + ' 失败');
process.exit(fail ? 1 : 0);
