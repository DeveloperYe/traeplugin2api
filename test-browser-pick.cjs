// 浏览器选择与启动参数的回归测试（自带内核 + 系统浏览器回退）
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { pickBrowser, bundledCandidates, isHeadlessShell, launchArgs } = require("./lib/cdp.cjs");

let n = 0, fail = 0;
const t = (name, fn) => {
  n++;
  try { fn(); console.log("  ✓ " + name); }
  catch (e) { fail++; console.log("  ✗ " + name + "  →  " + e.message); }
};

const EXE_NAME = process.platform === "win32" ? "chrome-headless-shell.exe" : "chrome-headless-shell";
const VER = "158.0.8127.36";
const PLAT = process.platform === "win32" ? "win64" : "linux64";

function makeFakeInstall(root) {
  const dir = path.join(root, VER, PLAT);
  fs.mkdirSync(dir, { recursive: true });
  const exe = path.join(dir, EXE_NAME);
  fs.writeFileSync(exe, "fake");
  return exe;
}

// ---------- 1) 自带内核探测 ----------
t("bundledCandidates 能找到 <root>/<版本>/<平台>/chrome-headless-shell", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "t2a-b-"));
  const exe = makeFakeInstall(root);
  const old = process.env.TRAE2API_BROWSER_DIR;
  process.env.TRAE2API_BROWSER_DIR = root;
  try {
    const found = bundledCandidates();
    assert.ok(found.includes(exe), "没找到 " + exe + "，实际: " + JSON.stringify(found));
  } finally {
    if (old === undefined) delete process.env.TRAE2API_BROWSER_DIR; else process.env.TRAE2API_BROWSER_DIR = old;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

t("版本目录名不合规时跳过（不会误认成内核）", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "t2a-b2-"));
  fs.mkdirSync(path.join(root, "not-a-version", PLAT), { recursive: true });
  fs.writeFileSync(path.join(root, "not-a-version", PLAT, EXE_NAME), "x");
  const old = process.env.TRAE2API_BROWSER_DIR;
  process.env.TRAE2API_BROWSER_DIR = root;
  try { assert.strictEqual(bundledCandidates().length, 0); }
  finally {
    if (old === undefined) delete process.env.TRAE2API_BROWSER_DIR; else process.env.TRAE2API_BROWSER_DIR = old;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------- 2) 优先级 ----------
t("显式 TRAE_LOGIN_BROWSER 优先于自带内核", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "t2a-b3-"));
  makeFakeInstall(root);
  const explicit = path.join(root, "explicit.exe");
  fs.writeFileSync(explicit, "x");
  const oldB = process.env.TRAE2API_BROWSER_DIR, oldE = process.env.TRAE_LOGIN_BROWSER;
  process.env.TRAE2API_BROWSER_DIR = root;
  process.env.TRAE_LOGIN_BROWSER = explicit;
  try { assert.strictEqual(pickBrowser(), explicit); }
  finally {
    if (oldB === undefined) delete process.env.TRAE2API_BROWSER_DIR; else process.env.TRAE2API_BROWSER_DIR = oldB;
    if (oldE === undefined) delete process.env.TRAE_LOGIN_BROWSER; else process.env.TRAE_LOGIN_BROWSER = oldE;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

t("没有自带内核时回退到系统浏览器（返回非空路径）", () => {
  const oldB = process.env.TRAE2API_BROWSER_DIR, oldE = process.env.TRAE_LOGIN_BROWSER, oldC = process.env.CDP_EXE;
  delete process.env.TRAE2API_BROWSER_DIR; delete process.env.TRAE_LOGIN_BROWSER; delete process.env.CDP_EXE;
  process.env.TRAE2API_BROWSER_DIR = path.join(os.tmpdir(), "definitely-missing-dir");
  try {
    const p = pickBrowser();
    assert.ok(typeof p === "string" && p.length > 0, "应返回兜底路径");
  } finally {
    if (oldB !== undefined) process.env.TRAE2API_BROWSER_DIR = oldB;
    if (oldE !== undefined) process.env.TRAE_LOGIN_BROWSER = oldE;
    if (oldC !== undefined) process.env.CDP_EXE = oldC;
    delete process.env.TRAE2API_BROWSER_DIR;
  }
});

// ---------- 3) headless shell 判定 ----------
t("isHeadlessShell 识别正反例", () => {
  assert.strictEqual(isHeadlessShell("/opt/b/chrome-headless-shell"), true);
  assert.strictEqual(isHeadlessShell("D:\\b\\chrome-headless-shell.exe"), true);
  assert.strictEqual(isHeadlessShell("C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"), false);
  assert.strictEqual(isHeadlessShell("/usr/bin/chromium"), false);
  assert.strictEqual(isHeadlessShell(null), false);
});

// ---------- 4) 启动参数 ----------
const SHELL = "/opt/b/chrome-headless-shell";
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";

t("headless shell 不能再传 --headless=new（它本身无头）", () => {
  const a = launchArgs({ exe: SHELL, port: 9333, userDataDir: "/tmp/p" });
  assert.ok(!a.includes("--headless=new"), "不应包含 --headless=new: " + a.join(" "));
  assert.ok(a.includes("--disable-dev-shm-usage"), "应带 --disable-dev-shm-usage");
});

t("普通浏览器仍要 --headless=new", () => {
  const a = launchArgs({ exe: EDGE, port: 9333, userDataDir: "D:\\p" });
  assert.ok(a.includes("--headless=new"));
  assert.ok(!a.includes("--disable-dev-shm-usage"));
});

t("非 headless 模式两种都不传 --headless=new", () => {
  for (const exe of [SHELL, EDGE]) {
    const a = launchArgs({ exe, port: 1, userDataDir: "x", headless: false });
    assert.ok(!a.includes("--headless=new"), exe);
  }
});

t("Linux 下 root 自动加 --no-sandbox；其他平台不加", () => {
  const old = process.env.TRAE_LOGIN_NO_SANDBOX;
  delete process.env.TRAE_LOGIN_NO_SANDBOX;
  const a = launchArgs({ exe: SHELL, port: 1, userDataDir: "x" });
  const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
  if (process.platform === "linux" && isRoot) assert.ok(a.includes("--no-sandbox"));
  else assert.ok(!a.includes("--no-sandbox") || process.platform === "linux");
  if (old !== undefined) process.env.TRAE_LOGIN_NO_SANDBOX = old;
});

t("TRAE_LOGIN_NO_SANDBOX=1 时才强制加 --no-sandbox", () => {
  const old = process.env.TRAE_LOGIN_NO_SANDBOX;
  process.env.TRAE_LOGIN_NO_SANDBOX = "1";
  try {
    const a = launchArgs({ exe: SHELL, port: 1, userDataDir: "x" });
    assert.strictEqual(a.includes("--no-sandbox"), process.platform === "linux");
  } finally {
    if (old === undefined) delete process.env.TRAE_LOGIN_NO_SANDBOX; else process.env.TRAE_LOGIN_NO_SANDBOX = old;
  }
});

t("参数以 about:blank 结尾、端口/目录都带上了", () => {
  const a = launchArgs({ exe: SHELL, port: 9444, userDataDir: "/tmp/zz" });
  assert.strictEqual(a[a.length - 1], "about:blank");
  assert.ok(a.includes("--remote-debugging-port=9444"));
  assert.ok(a.includes("--user-data-dir=/tmp/zz"));
});

console.log(`\n合计 ${n - fail}/${n} 通过`);
process.exit(fail ? 1 : 0);
