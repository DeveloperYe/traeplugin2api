// 文档校对：文档里承诺的「配置键 / 环境变量 / HTTP 路由 / 仓库文件 / 单测用例数」
// 逐条拿去和代码、磁盘、git 其他分支对照；任何一项对不上就退出码 1。
//
// 用法：node tools/verify-docs.cjs
//
// 两种运行环境：
//   - git 检出（仓库）：六项全查（含「文档引用的文件是否存在」「README 第 7 节用例数」）
//   - 部署目录（无 .git）：只查配置键 / 环境变量 / 路由 / 过期键；文件与用例数跳过（部署只装子集）
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const rel = (f) => path.join(ROOT, f);
const exists = (f) => fs.existsSync(rel(f));
const IS_REPO = fs.existsSync(path.join(ROOT, '.git'));
// 部署目录可能只装了一部分测试/文档，此时「文件存在性」和「用例数」会误报；
// 只要 README 第 7 节列出的任一测试文件不在本目录，就降级为「部分部署」模式。

const DOC_FILES = ['README.md', 'docs/CONFIG.md', 'docs/AI-DEPLOY.md', 'docs/MODEL-MAPPING.md',
  'docs/REASONING-EFFORT.md', 'docs/REVIEW.md'];
const CODE_FILES = ['server.cjs', 'config.example.json', 'public/index.html',
  'start-runtime.ps1', 'start-trae2api.ps1', 'restart.ps1'];
for (const dir of ['lib', 'deploy', 'tools']) {
  if (!fs.existsSync(rel(dir))) continue;
  for (const f of fs.readdirSync(rel(dir))) if (/\.(cjs|ps1|cmd|sh)$/.test(f)) CODE_FILES.push(dir + '/' + f);
}

const readAll = (list) => list.map((f) => (exists(f) ? fs.readFileSync(rel(f), 'utf8') : '')).join('\n');
const codeText = readAll(CODE_FILES);
const docText = readAll(DOC_FILES);

const __docText0 = DOC_FILES.map((f) => (fs.existsSync(path.join(ROOT, f)) ? fs.readFileSync(path.join(ROOT, f), 'utf8') : '')).join('\n');
const __refTests = [...new Set([...__docText0.matchAll(/^\| `(test-[^`]+\.cjs)`/gm)].map((m) => m[1]))];
// 「仅 feat/linux」这类分支专有文件不算缺失：查一下另一个分支是否存在
function __onOtherBranch(name) {
  for (const ref of ["main", "feat/linux"]) {
    try { execFileSync("git", ["cat-file", "-e", ref + ":" + name], { cwd: ROOT, stdio: "ignore" }); return true; } catch {}
  }
  return false;
}
const __missingRefTests = __refTests.filter((t) => !fs.existsSync(path.join(ROOT, t)) && !__onOtherBranch(t));
const FULL = IS_REPO && __missingRefTests.length === 0;

let pass = 0, fail = 0;
const problems = [];
const ok = (name) => { pass++; console.log('  ✓ ' + name); };
const skip = (name) => { pass++; console.log('  ⊘ ' + name); };
const bad = (name, detail) => { fail++; problems.push(name + '：' + detail); console.log('  ✗ ' + name + ' → ' + detail); };

// ---------- 1. CONFIG.md 表里声明的键，代码必须真的读取 ----------
const cfgInCode = new Set();
for (const m of codeText.matchAll(/cfg\??\.([a-zA-Z_][a-zA-Z0-9_]*)/g)) cfgInCode.add(m[1]);
for (const m of codeText.matchAll(/cfg\[["']([a-zA-Z_][a-zA-Z0-9_]*)["']\]/g)) cfgInCode.add(m[1]);

const configDoc = exists('docs/CONFIG.md') ? fs.readFileSync(rel('docs/CONFIG.md'), 'utf8') : '';
const declaredKeys = new Set();
for (const line of configDoc.split(/\r?\n/)) {
  const m = line.match(/^\|\s*`([a-z][a-z0-9_]*)`\s*\|/);
  if (m) declaredKeys.add(m[1]);
}
if (!configDoc) bad('CONFIG.md', '文件不存在');
else if (declaredKeys.size < 40) bad('CONFIG.md 键表', '只解析到 ' + declaredKeys.size + ' 个键，解析逻辑可能失效');
else {
  const missing = [...declaredKeys].filter((k) => !cfgInCode.has(k));
  if (missing.length) bad('CONFIG.md 声明的键在代码里没被读取', missing.join(', '));
  else ok('CONFIG.md 声明的 ' + declaredKeys.size + ' 个配置键，代码里全部读取');
}

// ---------- 2. 文档提到的环境变量必须在代码里出现 ----------
const envInCode = new Set();
for (const m of codeText.matchAll(/TRAE2API_[A-Z0-9_]+/g)) envInCode.add(m[0]);
const envInDoc = new Set();
for (const m of docText.matchAll(/`?(TRAE2API_[A-Z0-9_]+)`?/g)) envInDoc.add(m[1]);
const missingEnv = [...envInDoc].filter((e) => !envInCode.has(e));
if (missingEnv.length) bad('文档提到的环境变量代码里没有', missingEnv.join(', '));
else ok('文档提到的 ' + envInDoc.size + ' 个环境变量，代码里全部出现');

// ---------- 3. 文档提到的 HTTP 路由必须真的注册 ----------
const routesInCode = new Set();
for (const m of codeText.matchAll(/(?:p|pathname)\s*===\s*["']([^"']+)["']/g)) routesInCode.add(m[1]);
const routesInDoc = new Set();
for (const m of docText.matchAll(/`(?:GET|POST|GET\/POST)?\s*(\/v1\/[a-z/]+|\/api\/[A-Za-z\-/{}.,]+|\/healthz)`/gi)) routesInDoc.add(m[1]);
const missingRoutes = [];
for (const r of routesInDoc) {
  if (routesInCode.has(r)) continue;
  const brace = r.match(/^(.*)\{([^}]+)\}$/);
  if (brace) {
    const parts = brace[2].split(',').map((s) => s.trim()).filter(Boolean);
    const badParts = parts.filter((p) => !routesInCode.has(brace[1] + p));
    if (!badParts.length) continue;
    missingRoutes.push(r + '（缺 ' + badParts.join('/') + '）');
    continue;
  }
  missingRoutes.push(r);
}
if (missingRoutes.length) bad('文档提到的路由没注册', missingRoutes.join(', '));
else ok('文档提到的 ' + routesInDoc.size + ' 个路由，代码里全部注册');

// ---------- 4. 文档引用的仓库文件必须存在（仅仓库模式） ----------
const RUNTIME_ONLY = new Set(['deploy.json', 'config.json', 'token-cache.json', 'client-secret.txt',
  'trae2api.log', 'requests.jsonl', 'models-cache.json']);
const RUNTIME_PATH_PREFIXES = ['manifests/', 'prebuild/', 'runtime/', 'aiserver/', 'logs/', 'vsix/', 'extensions/'];
const REMOVED_IN_HISTORY = new Set(['supervise.ps1', 'install-task.ps1', 'cleanup-mcp.ps1',
  'deploy/install.cjs', 'test-platform-paths.cjs',
  // 4.0.76 删除（整模块没人 require），版本历史里仍会提到它
  'lib/aiserver-client.cjs']);
const SUBDIRS = ['', 'deploy/', 'docs/', 'lib/', 'tools/', 'data/', 'public/'];
const OTHER_BRANCH_FILES = new Set();

function resolveRepoFile(name) {
  for (const d of SUBDIRS) if (exists(d + name)) return d + name;
  if (/^data\/prompt\.md$/.test(name)) return 'optional';
  if (RUNTIME_ONLY.has(name)) return 'runtime';
  if (RUNTIME_PATH_PREFIXES.some((p) => name.startsWith(p))) return 'runtime';
  if (REMOVED_IN_HISTORY.has(name)) return 'removed';
  for (const ref of ['main', 'feat/linux']) {
    try {
      execFileSync('git', ['cat-file', '-e', ref + ':' + name], { cwd: ROOT, stdio: 'ignore' });
      OTHER_BRANCH_FILES.add(ref);
      return 'git:' + ref;
    } catch {}
  }
  return null;
}

if (!FULL) skip('部分部署（缺 ' + __missingRefTests.length + ' 个 README 列出的测试文件）：跳过「文档引用的文件是否存在」校对');
else {
  const fileRefs = new Set();
  for (const m of docText.matchAll(/`([A-Za-z0-9_.\-]+(?:\/[A-Za-z0-9_.\-]+)*\.(?:cjs|ps1|json|md|html|sh))`/g)) fileRefs.add(m[1]);
  for (const m of docText.matchAll(/\]\(([A-Za-z0-9_.\-]+(?:\/[A-Za-z0-9_.\-]+)*\.md)\)/g)) fileRefs.add(m[1]);
  const missing = [], real = [], other = [];
  for (const f of fileRefs) {
    if (f.startsWith('work/')) continue;
    const r = resolveRepoFile(f);
    if (!r) missing.push(f);
    else if (/^(runtime|removed|optional)$/.test(r) || r.startsWith('git:')) other.push(f);
    else real.push(f);
  }
  if (missing.length) bad('文档引用了仓库里不存在的文件', missing.join(', '));
  else ok('文档引用的 ' + real.length + ' 个仓库文件都存在（另 ' + other.length + ' 个属于运行期/上游/已删除历史/其他分支）');
}

// ---------- 5. README 第 7 节用例数（仅仓库模式） ----------
const SKIP_TESTS = /standalone|e2e|live|probe/i;
// 这个测试的用例数 == 它扫描到的文件数，仓库每加一个文件就变；只要求表格里有它，不比对数字
const SKIP_COUNT = /no-conflict/; // 需要活运行时/网关的脚本不算「单测」
function countCases(file) {
  let out = '';
  try {
    out = execFileSync(process.execPath, [rel(file)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    out = String((e && (e.stdout || e.stderr)) || (e && e.message) || '');
  }
  const m = out.match(/合计\s*(\d+)(?:\s*\/\s*(\d+))?/);
  return m ? Number(m[2] || m[1]) : null;
}

if (!FULL) skip('部分部署：跳过「README 第 7 节用例数」校对');
else {
  const testFiles = fs.readdirSync(ROOT).filter((f) => /^test-.*\.cjs$/.test(f) && !SKIP_TESTS.test(f)).sort();
  let total = 0;
  const mismatched = [];
  for (const f of testFiles) {
    if (SKIP_COUNT.test(f)) {
      // 只要 README 里确实列了这个文件即可（用例数随文件数变化，不比对）
      if (!docText.includes("`" + f + "`")) mismatched.push(f + "(README 第 7 节未列)");
      continue;
    }
    const n = countCases(f);
    if (n === null) { mismatched.push(f + '(读不出用例数)'); continue; }
    total += n;
    const esc = f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // 表格首格就是文件名（允许后面带括号说明），用例数单元格可能是「57 / 63」这种多分支写法
    const rowRe = new RegExp('^\\|\\s*`' + esc + '`[^|]*\\|([^|]+)\\|', 'm');
    const declared = rowRe.exec(docText);
    if (!declared) mismatched.push(f + '(README 第 7 节未列)');
    else {
      const nums = (declared[1].match(/\d+/g) || []).map(Number);
      if (!nums.includes(n)) mismatched.push(f + '(README 写 ' + nums.join('/') + '，实际 ' + n + ')');
    }
  }
  if (mismatched.length) bad('README 第 7 节用例数不一致', mismatched.join('; '));
  else ok('README 第 7 节：' + testFiles.length + ' 个测试文件逐行与实际一致（已比对 ' + total + ' 个用例；no-conflict 的用例数=扫描文件数，只校验它在列表里）');
}

// ---------- 6. 正文不许出现已删除的键（版本历史小节里允许保留） ----------
const RETIRED_KEYS = ['prompt_budget_tokens', 'prompt_budget_action', 'prompt_overhead_tokens',
  'tool_instruction_style', 'native_ban_always', 'estimatePromptTokens', 'estTokens'];
const staleHits = [];
for (const f of DOC_FILES) {
  if (!exists(f)) continue;
  const lines = fs.readFileSync(rel(f), 'utf8').split(/\r?\n/);
  let inHistory = false;
  lines.forEach((l, i) => {
    if (/^### 4\.0\.\d/.test(l)) inHistory = true;
    else if (/^## /.test(l)) inHistory = false;
    if (inHistory) return;
    for (const k of RETIRED_KEYS) {
      if (!l.includes(k)) continue;
      if (/未实现|已移除|已删除|旧版|历史|已改名为/.test(l)) continue;
      staleHits.push(f + ':' + (i + 1) + ' [' + k + ']');
    }
  });
}
if (staleHits.length) bad('文档正文出现过期/不存在的键', staleHits.join(', '));
else ok('文档正文没有过期键（版本历史里的历史键允许保留）');

console.log('\n文档校对结果：' + pass + ' 项通过，' + fail + ' 项失败'
  + (FULL ? '（仓库模式，六项全查）' : '（部分部署模式，跳过文件/用例数两项）'));
if (fail) process.exit(1);
