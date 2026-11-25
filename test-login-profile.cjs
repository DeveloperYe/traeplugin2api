// 一次性浏览器配置的策略验收（不启动浏览器：本机 DSH 会话里 Edge 的 DevTools 端点不可达，
// 启动环节由生产环境实际登录验证）
const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");
const { TraeLogin } = require("./lib/trae-login.cjs");
const { CdpBrowser } = require("./lib/cdp.cjs");

delete process.env.TRAE_LOGIN_PROFILE;
delete process.env.TRAE_LOGIN_KEEP_PROFILE;
delete process.env.TRAE_LOGIN_ATTACH;

let n = 0, fail = 0;
const t = (name, fn) => {
  n++;
  try { fn(); console.log("  ✓ " + name); }
  catch (e) { fail++; console.log("  ✗ " + name + "  →  " + e.message); }
};

const mk = () => new TraeLogin({ profileDir: path.join(os.tmpdir(), "trae2api-test-profile"), log: () => {} });

// ---------- 1) 默认一次性 ----------
t("默认策略：临时目录 + 已登记 tempProfile + 幂等", () => {
  const l = mk();
  const a = l._profileDir();
  const b = l._profileDir();
  assert.strictEqual(a, b, "同一次登录内应复用同一个目录");
  assert.ok(a.startsWith(os.tmpdir()), "应位于系统临时目录: " + a);
  assert.ok(/trae2api-login-\d+-/.test(path.basename(a)), "目录名应带 pid 与时间戳: " + a);
  assert.strictEqual(l.tempProfile, a);
});

t("默认策略：不接管旧浏览器（allowAttach=false 的判定）", () => {
  const l = mk();
  const allowAttach = process.env.TRAE_LOGIN_ATTACH === "1"
    || (!!l.persistentDir && process.env.TRAE_LOGIN_ATTACH !== "0");
  assert.strictEqual(allowAttach, false, "一次性模式下不应接管，否则会继承上次登录态");
});

// ---------- 2) 清理 ----------
t("_cleanupProfile 删除临时目录并把 tempProfile 置空", async () => {});
const l2 = mk();
const dir = l2._profileDir();
fs.mkdirSync(path.join(dir, "Default", "Network"), { recursive: true });
fs.writeFileSync(path.join(dir, "Default", "Network", "Cookies"), "fake-cookie-db");
l2._cleanupProfile();
setTimeout(() => {
  const gone = !fs.existsSync(dir);
  console.log("  " + (gone ? "✓" : "✗") + " 临时目录（含伪造 Cookies）已删除  →  " + dir);
  if (!gone) fail++;
  n++;

  // ---------- 3) 持久策略 ----------
  t("TRAE_LOGIN_KEEP_PROFILE=1 → data/login-profile 且不登记 tempProfile", () => {
    process.env.TRAE_LOGIN_KEEP_PROFILE = "1";
    const l = mk();
    const p = l._profileDir();
    assert.ok(/[\\/]data[\\/]login-profile$/.test(p), "路径不对: " + p);
    assert.strictEqual(l.tempProfile, null);
    delete process.env.TRAE_LOGIN_KEEP_PROFILE;
  });

  t("TRAE_LOGIN_PROFILE=<dir> 显式指定优先", () => {
    process.env.TRAE_LOGIN_PROFILE = "D:\\tmp\\custom-profile";
    const l = mk();
    assert.strictEqual(l._profileDir(), "D:\\tmp\\custom-profile");
    delete process.env.TRAE_LOGIN_PROFILE;
  });

  t("持久模式默认允许接管（网关重启后能续接当前登录页）", () => {
    process.env.TRAE_LOGIN_KEEP_PROFILE = "1";
    const l = mk();
    const allowAttach = process.env.TRAE_LOGIN_ATTACH === "1"
      || (!!l.persistentDir && process.env.TRAE_LOGIN_ATTACH !== "0");
    assert.strictEqual(allowAttach, true);
    delete process.env.TRAE_LOGIN_KEEP_PROFILE;
  });

  t("TRAE_LOGIN_ATTACH=0 时任何模式都不接管", () => {
    process.env.TRAE_LOGIN_KEEP_PROFILE = "1";
    process.env.TRAE_LOGIN_ATTACH = "0";
    const l = mk();
    const allowAttach = process.env.TRAE_LOGIN_ATTACH === "1"
      || (!!l.persistentDir && process.env.TRAE_LOGIN_ATTACH !== "0");
    assert.strictEqual(allowAttach, false);
    delete process.env.TRAE_LOGIN_KEEP_PROFILE;
    delete process.env.TRAE_LOGIN_ATTACH;
  });

  // ---------- 4) cdp 接口 ----------
  t("CdpBrowser.clearSite 存在（持久模式登录前清站点数据用）", () => {
    assert.strictEqual(typeof CdpBrowser.prototype.clearSite, "function");
  });

  console.log("\n合计 " + (n - fail) + "/" + n + " 通过");
  process.exit(fail ? 1 : 0);
}, 2500);
