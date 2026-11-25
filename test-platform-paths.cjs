// 跨平台路径与依赖的回归测试（feat/linux 分支的核心保障）
// 目标：Linux 侧逻辑可验证，同时确保 Windows 现有行为完全不回归。
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

// aha.cjs 在加载时读这些环境变量，必须先设好
process.env.TRAE2API_AHA_DIR = process.env.TRAE2API_AHA_DIR || path.join(os.homedir(), '.marscode', 'server-main', 'aha');
const aha = require('./lib/aha.cjs');

let n = 0, fail = 0;
const t = (name, fn) => {
  n++;
  try { fn(); console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + '  →  ' + e.message); }
};

// ---------- 1) zmq addon 候选路径（平台感知） ----------
t('显式路径与 TRAE2API_AHA_ADDON 排在最前', () => {
  const c1 = aha.addonCandidates('/explicit/addon.node', 'linux', 'x64');
  assert.strictEqual(c1[0], '/explicit/addon.node');
  process.env.TRAE2API_AHA_ADDON = '/env/addon.node';
  const c2 = aha.addonCandidates(null, 'linux', 'x64');
  assert.strictEqual(c2[0], '/env/addon.node');
  delete process.env.TRAE2API_AHA_ADDON;
});

t('Linux 候选里出现 linux/x64 的 prebuild 布局', () => {
  const c = aha.addonCandidates(null, 'linux', 'x64');
  assert.ok(c.some((p) => p.includes(path.join('prebuild', 'linux', 'x64', 'node'))), '缺少 prebuild/linux/x64/node');
});

t('Linux 与 Windows 候选不会互相污染', () => {
  const lin = aha.addonCandidates(null, 'linux', 'x64').join('\n');
  const win = aha.addonCandidates(null, 'win32', 'x64').join('\n');
  assert.ok(!lin.includes('win32'), 'Linux 候选里不该出现 win32');
  assert.ok(!win.includes(path.join('prebuild', 'linux')), 'Windows 候选里不该出现 linux prebuild');
});

t('arm64 架构单独成路径', () => {
  const c = aha.addonCandidates(null, 'linux', 'arm64');
  assert.ok(c.some((p) => p.includes(path.join('prebuild', 'linux', 'arm64', 'node'))));
});

t('本机（当前平台）能真的找到 addon', () => {
  const p = aha.findAddon();
  assert.ok(fs.existsSync(p), 'findAddon 返回的路径不存在: ' + p);
  console.log('      → ' + p);
});

// ---------- 2) 凭据模块：任何平台都能加载，不再因 %APPDATA% 缺失而崩 ----------
t('creds.cjs 在本机能加载并给出状态', () => {
  const { Creds } = require('./lib/creds.cjs');
  const c = new Creds({ log: () => {} });
  const st = c.status();
  assert.ok(typeof st === 'object' && 'hasCreds' in st);
});

t('非 Windows 平台没有 DPAPI 时给出可读错误', () => {
  const { Creds } = require('./lib/creds.cjs');
  const c = new Creds({ log: () => {} });
  if (process.platform === 'win32') {
    // Windows 上走真实 DPAPI，这里只验证方法存在且能调用不抛未定义错误
    assert.strictEqual(typeof c._safeKey, 'function');
  } else {
    assert.throws(() => c._safeKey(true), /DPAPI/);
  }
});

// ---------- 3) 浏览器探测：Windows 命中 msedge，Linux 走 chromium 清单 ----------
t('浏览器探测在当前平台返回可读路径', () => {
  const { pickBrowser } = require('./lib/cdp.cjs');
  const p = pickBrowser();
  assert.ok(typeof p === 'string' && p.length > 0, 'pickBrowser 返回空');
  if (process.platform === 'win32') assert.ok(/msedge|chrome/i.test(p), 'Windows 上应命中 Edge/Chrome: ' + p);
  console.log('      → ' + p + (fs.existsSync(p) ? ' (存在)' : ' (不存在，仅提示用)'));
});

console.log(`\n合计 ${n - fail}/${n} 通过`);
process.exit(fail ? 1 : 0);
