#!/usr/bin/env node
/**
 * 按需下载并裁剪 chrome-headless-shell（Chromium 的无 UI 变体），供面板内登录使用。
 *
 * 为什么用它：登录流程要真实像素渲染（截图抓二维码 + 面板实时画面），
 * 所以只能是 Chromium 家族；chrome-headless-shell 是这个家族里最小的可用形态。
 * 体积（实测，CfT 158）：linux64 zip 126 MB → 解压 282 MB → 裁剪后 228 MB。
 *
 * 用法：
 *   node deploy/fetch-browser.cjs                     # 装到 <仓库>/runtime/browser/
 *   node deploy/fetch-browser.cjs --dir D:\rt\browser # 指定目录
 *   node deploy/fetch-browser.cjs --version 158.0.8127.36
 *   node deploy/fetch-browser.cjs --platform linux64  # 默认取本机
 *   node deploy/fetch-browser.cjs --from-7z <路径|URL> # 用离线/自建压缩包
 *   node deploy/fetch-browser.cjs --status            # 只看已装了什么
 *   node deploy/fetch-browser.cjs --force             # 强制重装
 *
 * 下载源顺序：npmmirror（国内快）→ 官方 storage.googleapis.com。
 * 校验：解包成功 + 可执行文件存在 + `--version` 以 0 退出并打印版本号，否则报错并给依赖提示。
 *
 * 注意：Linux 上它仍依赖少数系统库（NSS/NSPR/GTK 子集），缺了会启动即报 .so not found；
 * 脚本会把缺的库和对应的 apt/yum 命令直接打出来。
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { listEntries, extractEntry } = require("./lib/unzip.cjs");

const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf(k); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const flag = (k) => args.includes(k);

const REPO = path.join(__dirname, "..");
const HOST_OS = process.platform;
const HOST_ARCH = process.arch === "arm64" ? "arm64" : "x64";

const PLATFORMS = {
  "win32-x64": "win64",
  "win32-arm64": "win64",
  "linux-x64": "linux64",
  "linux-arm64": "linux-arm64",
  "darwin-x64": "mac-x64",
  "darwin-arm64": "mac-arm64",
};
const PLATFORM = arg("--platform", PLATFORMS[`${HOST_OS}-${HOST_ARCH}`] || "linux64");
const DEST_ROOT = path.resolve(arg("--dir", path.join(REPO, "runtime", "browser")));
const VERSION_ARG = arg("--version", process.env.TRAE2API_BROWSER_VERSION || "");
const FROM_7Z = arg("--from-7z", "");
const META_URL = "https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json";
const MIRROR_LIST = "https://registry.npmmirror.com/-/binary/chrome-for-testing/";
const MIRRORS = [
  (v, p) => `https://registry.npmmirror.com/-/binary/chrome-for-testing/${v}/${p}/chrome-headless-shell-${p}.zip`,
  (v, p) => `https://storage.googleapis.com/chrome-for-testing-public/${v}/${p}/chrome-headless-shell-${p}.zip`,
];

// Linux 上 headless shell 仍需要的系统库 → 发行版包名
const LINUX_DEPS = {
  "libnspr4.so": "libnspr4",
  "libnss3.so": "libnss3",
  "libnssutil3.so": "libnss3",
  "libsmime3.so": "libnss3",
  "libasound.so.2": "libasound2t64",
  "libatk-1.0.so.0": "libatk1.0-0t64",
  "libatk-bridge-2.0.so.0": "libatk-bridge2.0-0t64",
  "libatspi.so.0": "libatspi2.0-0t64",
  "libcups.so.2": "libcups2t64",
  "libdrm.so.2": "libdrm2",
  "libgbm.so.1": "libgbm1",
  "libxkbcommon.so.0": "libxkbcommon0",
  "libXcomposite.so.1": "libxcomposite1",
  "libXdamage.so.1": "libxdamage1",
  "libXfixes.so.3": "libxfixes3",
  "libXrandr.so.2": "libxrandr2",
  "libpango-1.0.so.0": "libpango-1.0-0",
  "libcairo.so.2": "libcairo2",
};

const log = (m) => console.log(m);
const fail = (m) => { console.error("❌ " + m); process.exit(1); };

// 从 stderr 里抽出缺失的 .so，给出可粘贴的安装命令
function libHint(stderrText) {
  const miss = [...new Set(String(stderrText).match(/[\w.+-]+\.so(\.[\d.]+)?/g) || [])];
  if (!miss.length) return "";
  const pkgs = [...new Set(miss.map((m) => LINUX_DEPS[m]).filter(Boolean))];
  const lines = ["  缺少系统库: " + miss.join(", ")];
  if (pkgs.length) lines.push("  安装（Debian/Ubuntu）: sudo apt-get install -y " + pkgs.join(" "));
  lines.push("  安装（RHEL/CentOS）: sudo yum install -y nss nspr atk at-spi2-atk cups-libs libdrm libgbm libxkbcommon libXcomposite libXdamage libXfixes libXrandr pango cairo alsa-lib");
  return lines.join("\n");
}

function exeName() {
  return HOST_OS === "win32" || PLATFORM.startsWith("win") ? "chrome-headless-shell.exe" : "chrome-headless-shell";
}

function dirSize(dir) {
  let sum = 0;
  const walk = (d) => {
    let list = [];
    try { list = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of list) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else { try { sum += fs.statSync(p).size; } catch {} }
    }
  };
  walk(dir);
  return sum;
}

function installedDir() {
  const vers = [];
  try { for (const d of fs.readdirSync(DEST_ROOT)) if (/^\d+\.\d+\.\d+\.\d+$/.test(d)) vers.push(d); } catch { return []; }
  const hits = [];
  for (const v of vers) {
    let plats = [];
    try { plats = fs.readdirSync(path.join(DEST_ROOT, v)); } catch { continue; }
    for (const p of plats) {
      const dir = path.join(DEST_ROOT, v, p);
      const exe = path.join(dir, exeName());
      if (fs.existsSync(exe)) hits.push({ version: v, platform: p, dir, exe });
    }
  }
  return hits;
}

function selfCheck(dir) {
  const exe = path.join(dir, exeName());
  if (!fs.existsSync(exe)) throw new Error("裁剪后找不到可执行文件: " + exe);
  if (HOST_OS !== "win32") { try { fs.chmodSync(exe, 0o755); } catch {} }
  const r = spawnSync(exe, ["--version"], { encoding: "utf8", timeout: 30000 });
  const out = String(r.stdout || "").trim();
  const err = String(r.stderr || "").trim();
  if (r.status !== 0 || !out) {
    const hint = libHint(err);
    throw new Error(
      "内核跑不起来（exit " + r.status + "）" +
      (err ? "\n  原因: " + err.split("\n")[0] : "") +
      (hint ? "\n" + hint : "") +
      "\n  文件已保留在 " + dir + "，装完依赖后跑 --status 复查即可"
    );
  }
  const version = out.split("\n")[0];
  if (!/\d+\.\d+\.\d+\.\d+/.test(version)) throw new Error("`--version` 输出异常: " + version.slice(0, 80));
  return { exe, version };
}

function find7z() {
  const cands = [
    process.env.SEVEN_ZIP,
    path.join(REPO, "runtime", "aiserver", "resources", "tools", "7z", "win32-x64", "7za.exe"),
    path.join(REPO, "runtime", "aiserver", "resources", "tools", "7z", "linux-x64", "7zz"),
    "/usr/bin/7z", "/usr/bin/7za", "/usr/bin/7zz", "/usr/local/bin/7zz",
  ].filter(Boolean);
  for (const c of cands) { try { if (fs.existsSync(c)) return c; } catch {} }
  return null;
}

async function resolveVersion() {
  if (VERSION_ARG) return VERSION_ARG;
  log("  → 取 CfT 版本清单…");
  try {
    const r = await fetch(META_URL, { signal: AbortSignal.timeout(20000) });
    if (r.ok) {
      const j = await r.json();
      const v = j && j.channels && j.channels.Stable && j.channels.Stable.version;
      if (v) return v;
    }
  } catch (e) { log("    官方清单失败: " + e.message); }
  const r2 = await fetch(MIRROR_LIST, { signal: AbortSignal.timeout(20000) });
  const list = await r2.json();
  const vers = list.map((x) => String(x.name || "").replace(/\/$/, "")).filter((v) => /^\d+\.\d+\.\d+\.\d+$/.test(v));
  vers.sort((a, b) => {
    const A = a.split(".").map(Number), B = b.split(".").map(Number);
    for (let i = 0; i < 4; i++) if (A[i] !== B[i]) return A[i] - B[i];
    return 0;
  });
  if (!vers.length) throw new Error("拿不到任何 CfT 版本号（可加 --version 手动指定）");
  return vers[vers.length - 1];
}

async function download(url, file) {
  log("  ↓ " + url);
  const r = await fetch(url, { signal: AbortSignal.timeout(900000), redirect: "follow" });
  if (!r.ok) throw new Error("HTTP " + r.status);
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length < 20 * 1048576) throw new Error("文件过小（" + (buf.length / 1048576).toFixed(1) + " MB），可能不是安装包");
  fs.writeFileSync(file, buf);
  return buf.length;
}

function extractAll(archive, outDir) {
  const seven = find7z();
  if (seven) {
    log("  解包（7z: " + path.basename(seven) + "）…");
    const r = spawnSync(seven, ["x", archive, "-o" + outDir, "-y"], { stdio: "inherit" });
    if (r.status !== 0) throw new Error("7z 解包失败（exit " + r.status + "）");
    return;
  }
  log("  解包（内置 zip 解析，较慢）…");
  const entries = listEntries(archive);
  let n2 = 0;
  for (const e of entries) {
    if (e.name.endsWith("/")) continue;
    const out = path.resolve(outDir, e.name);
    if (!out.startsWith(path.resolve(outDir) + path.sep)) continue;
    extractEntry(archive, e, out);
    n2++;
  }
  log("    解出 " + n2 + " 个文件");
}

// 裁剪：locale 只留 en-US、删无 GPU 用不上的 SwiftShader
function trim(dir) {
  let removed = 0, bytes = 0;
  const rm = (p) => {
    try {
      const st = fs.statSync(p);
      if (st.isDirectory()) {
        for (const n2 of fs.readdirSync(p)) rm(path.join(p, n2));
        fs.rmdirSync(p);
      } else {
        bytes += st.size; fs.unlinkSync(p); removed++;
      }
    } catch {}
  };
  const loc = path.join(dir, "locales");
  if (fs.existsSync(loc)) {
    for (const f of fs.readdirSync(loc)) if (!/^en-US\.pak$/.test(f)) rm(path.join(loc, f));
  }
  for (const n2 of ["libvk_swiftshader.so", "vk_swiftshader.dll", "vk_swiftshader_icd.json", "vulkan-1.dll", "libvulkan.so.1", "swiftshader"]) {
    const p = path.join(dir, n2);
    if (fs.existsSync(p)) rm(p);
  }
  return { removed, bytes };
}

// ---------- 主流程 ----------
(async () => {
  if (flag("--status")) {
    const hits = installedDir();
    if (!hits.length) { log("  未安装（" + DEST_ROOT + " 下没有可用内核）"); process.exit(0); }
    for (const h of hits) {
      log("  " + h.version + "  " + h.platform + "  " + (dirSize(h.dir) / 1048576).toFixed(1) + " MB  → " + h.exe);
      try { log("    自检: " + selfCheck(h.dir).version); }
      catch (e) { log("    ⚠ " + e.message.split("\n").join("\n    ")); }
    }
    process.exit(0);
  }

  log("=== 获取 chrome-headless-shell（" + PLATFORM + "）===");

  if (!flag("--force")) {
    const has = installedDir().find((h) => h.platform === PLATFORM);
    if (has) {
      log("  已安装: " + has.version + " → " + has.exe + "（想重装加 --force）");
      try { log("  自检: " + selfCheck(has.dir).version); return; }
      catch (e) { log("  ⚠ " + e.message); process.exit(3); }
    }
  }

  const version = FROM_7Z ? "custom" : await resolveVersion();
  log("  版本: " + version);
  const outDir = path.join(DEST_ROOT, version, PLATFORM);
  fs.mkdirSync(outDir, { recursive: true });

  const tmp = path.join(os.tmpdir(), "cft-" + Date.now() + (FROM_7Z ? ".7z" : ".zip"));
  let tmpOut = null;
  try {
    let sizeMB = 0;
    if (FROM_7Z) {
      if (/^https?:\/\//.test(FROM_7Z)) sizeMB = (await download(FROM_7Z, tmp)) / 1048576;
      else { fs.copyFileSync(FROM_7Z, tmp); sizeMB = fs.statSync(tmp).size / 1048576; }
    } else {
      let lastErr = null;
      for (const mk of MIRRORS) {
        try { sizeMB = (await download(mk(version, PLATFORM), tmp)) / 1048576; lastErr = null; break; }
        catch (e) { lastErr = e; log("    ✗ " + e.message); }
      }
      if (lastErr) throw new Error("所有下载源都失败: " + lastErr.message);
    }
    log("  下载完成: " + sizeMB.toFixed(1) + " MB");

    // 先解到临时目录，确认能跑再落到最终位置（避免半成品占着目录导致下次误判已装）
    tmpOut = path.join(os.tmpdir(), "cft-out-" + Date.now());
    fs.mkdirSync(tmpOut, { recursive: true });
    extractAll(tmp, tmpOut);
    const inner = path.join(tmpOut, "chrome-headless-shell-" + PLATFORM);
    const srcDir = fs.existsSync(inner) && fs.statSync(inner).isDirectory() ? inner : tmpOut;

    const t = trim(srcDir);
    log("  裁剪: 删 " + t.removed + " 个文件 / " + (t.bytes / 1048576).toFixed(1) + " MB");

    // 从临时目录搬到最终目录（同盘 rename，跨盘则复制）
    fs.rmSync(outDir, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(outDir), { recursive: true });
    try { fs.renameSync(srcDir, outDir); }
    catch { fs.cpSync(srcDir, outDir, { recursive: true }); fs.rmSync(srcDir, { recursive: true, force: true }); }
    tmpOut = null;

    const ok = selfCheck(outDir);
    log("  自检通过: " + ok.version);
    const after = dirSize(outDir);

    fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify({
      version, platform: PLATFORM, exe: ok.exe, exeVersion: ok.version,
      downloadedMB: +sizeMB.toFixed(1), sizeBytes: after,
      source: FROM_7Z ? FROM_7Z : "chrome-for-testing (npmmirror → googleapis)",
      fetchedAt: new Date().toISOString(),
    }, null, 2), "utf8");

    console.log(`
================ 完成 ================
  内核   : chrome-headless-shell ${ok.version}
  目录   : ${outDir}
  体积   : ${(after / 1048576).toFixed(1)} MB（下载 ${sizeMB.toFixed(1)} MB）
  使用   : 网关自动探测 <仓库>/runtime/browser/**/chrome-headless-shell*
          也可显式指定 TRAE_LOGIN_BROWSER=<exe 路径>
======================================`);
  } finally {
    try { fs.rmSync(tmp, { force: true }); } catch {}
    if (tmpOut) { try { fs.rmSync(tmpOut, { recursive: true, force: true }); } catch {} }
  }
})().catch((e) => fail(e.message));
