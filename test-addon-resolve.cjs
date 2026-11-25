// 回归测试：zmq addon 的三条解析路径（这是 2026-11-23 漏掉的那个 bug 的固化）
//   ① 自包含部署：<dest>/aiserver/prebuild/<os>/<arch>/node/<toolchain>/addon.node（机器上没有 .vscode 扩展）
//   ② 扩展式部署：<HOME>/.vscode/extensions/marscode.marscode-extension-*/resource/aiserver/prebuild/...
//   ③ 显式 TRAE2API_AHA_ADDON
//   ④ 都没有 → 必须抛错，且错误信息提示可用的解决方式
// 每个用例用独立子进程（AHA_DIR 在模块加载时求值，不能在同一进程里切换）。
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const REPO = path.resolve(__dirname);
const PLAT = process.platform;
const ARCH = process.arch;
const TC = PLAT === "win32" ? "msvc-115-Release" : "glibc-127-Release";

let pass = 0, fail = 0;
const ck = (name, cond, extra = "") => {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (extra ? "  → " + extra : "")); }
};

function mkTemp(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), "t2a-addon-" + tag + "-"));
}

// 子进程里跑 findAddon，环境变量由我们控制（隔离 HOME，模拟没装 VS Code 的机器）
function runFindAddon({ home, ahaDir, envAddon }) {
  const script = `
    const { findAddon } = require(${JSON.stringify(path.join(REPO, "lib", "aha.cjs"))});
    try { console.log("OK:" + findAddon()); } catch (e) { console.log("ERR:" + e.message); }
  `;
  const env = { ...process.env, HOME: home, USERPROFILE: home, TRAE2API_AHA_DIR: ahaDir || path.join(home, "aha", "aha") };
  if (envAddon) env.TRAE2API_AHA_ADDON = envAddon; else delete env.TRAE2API_AHA_ADDON;
  const out = execFileSync(process.execPath, ["-e", script], { encoding: "utf8", env, timeout: 30000 });
  return out.trim();
}

console.log("平台: " + PLAT + "/" + ARCH + "  toolchain 示例: " + TC);

// ---------- ① 自包含布局：只有运行时自带的 prebuild，没有 .vscode ----------
console.log("\n=== ① 自包含部署（无 .vscode 扩展）===");
{
  const root = mkTemp("self");
  const dest = path.join(root, "dest");
  const addon = path.join(dest, "aiserver", "prebuild", PLAT, ARCH, "node", TC, "addon.node");
  fs.mkdirSync(path.dirname(addon), { recursive: true });
  fs.writeFileSync(addon, "fake");
  const home = path.join(root, "home-empty");
  fs.mkdirSync(home, { recursive: true });
  const out = runFindAddon({ home, ahaDir: path.join(dest, "aha", "aha") });
  ck("能解析到运行时自带的 addon", out.startsWith("OK:") && out.includes(addon), out);
  fs.rmSync(root, { recursive: true, force: true });
}

// ---------- ② 扩展式布局 ----------
console.log("\n=== ② 扩展式部署（%HOME%/.vscode/extensions）===");
{
  const home = mkTemp("ext");
  const addon = path.join(home, ".vscode", "extensions", "marscode.marscode-extension-1.7.16",
    "resource", "aiserver", "prebuild", PLAT, ARCH, "node", TC, "addon.node");
  fs.mkdirSync(path.dirname(addon), { recursive: true });
  fs.writeFileSync(addon, "fake");
  const out = runFindAddon({ home, ahaDir: path.join(home, "aha", "aha") });
  ck("能解析到扩展目录里的 addon", out.startsWith("OK:") && out.includes(addon), out);
  fs.rmSync(home, { recursive: true, force: true });
}

// ---------- ③ 显式环境变量 ----------
console.log("\n=== ③ 显式 TRAE2API_AHA_ADDON ===");
{
  const root = mkTemp("env");
  const explicit = path.join(root, "custom-addon.node");
  fs.writeFileSync(explicit, "fake");
  const home = path.join(root, "home");
  fs.mkdirSync(home, { recursive: true });
  const out = runFindAddon({ home, envAddon: explicit });
  ck("显式路径优先命中", out.startsWith("OK:") && out.includes(explicit), out);
  fs.rmSync(root, { recursive: true, force: true });
}

// ---------- ④ 都没有：必须报错且给可操作提示 ----------
console.log("\n=== ④ 三种都没有 → 报错且可操作 ===");
{
  const home = mkTemp("none");
  const out = runFindAddon({ home });
  ck("抛错而不是静默", out.startsWith("ERR:"), out);
  ck("错误信息提到 TRAE2API_AHA_ADDON", out.includes("TRAE2API_AHA_ADDON"), out);
  fs.rmSync(home, { recursive: true, force: true });
}

console.log("\n合计 " + (pass + fail) + " 项：" + pass + " 通过，" + fail + " 失败");
process.exit(fail ? 1 : 0);
