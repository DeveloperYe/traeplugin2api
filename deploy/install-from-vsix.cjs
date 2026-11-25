#!/usr/bin/env node
/**
 * 从 Trae/MarsCode 的 VSIX 一键部署「网关自带运行时」。
 *
 * 做什么：
 *   1. 解析 VSIX（zip），取出 extension/resource/aiserver（只留目标平台的二进制与原生模块）
 *   2. 用 VSIX 自带的 7z 解开 resources/binaries/<os>-<arch>.7z → 得到 ai-agent / ckg
 *   3. 给 aiserver 打「无连接不退出」补丁
 *   4. 生成启动脚本 + 看护脚本（Windows 生成 .cmd/.ps1，Linux/macOS 生成 .sh）+ 配置
 *
 * 用法：
 *   node deploy/install-from-vsix.cjs --vsix <你的vsix> [--dest <仓库>/runtime] [--platform win32-x64|linux-x64|linux-arm64|darwin-x64|darwin-arm64]
 *                                     [--install-task]
 *
 * 说明：
 *   - --platform 默认取本机（win32 → win32-x64；linux → linux-<arch>；darwin → darwin-<arch>）
 *   - 7z 解包工具按「本机」选（Windows 用 7za.exe，Linux/macOS 用 7zz），与目标平台无关
 *   - --install-task 只在 Windows 生效；Linux/macOS 请用 deploy/linux/install-systemd.sh
 */
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { listEntries, extractEntry } = require("./lib/unzip.cjs");

const args = process.argv.slice(2);
const arg = (k, d) => {
  const i = args.indexOf(k);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const flag = (k) => args.includes(k);

const HOST_OS = process.platform;                       // win32 | linux | darwin
const HOST_ARCH = process.arch === "arm64" ? "arm64" : "x64";
function defaultTarget() {
  if (HOST_OS === "win32") return "win32-x64";
  if (HOST_OS === "linux") return "linux-" + HOST_ARCH;
  return "darwin-" + HOST_ARCH;
}
const TARGET = arg("--platform", defaultTarget());
const [PLAT_OS, PLAT_ARCH] = TARGET.split("-");
const IS_WIN_TARGET = PLAT_OS === "win32";
const VSIX = arg("--vsix", "");
const DEST = path.resolve(arg("--dest", path.join(__dirname, "..", "runtime")));
const INSTALL_TASK = flag("--install-task");
const TASK_ONLY = flag("--task-only");

if (!["win32-x64", "linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64"].includes(TARGET)) {
  console.error("不支持的 --platform：" + TARGET + "（可选 win32-x64 / linux-x64 / linux-arm64 / darwin-x64 / darwin-arm64）");
  process.exit(2);
}

const log = (m) => console.log(m);
const step = (n, m) => console.log(`\n[${n}] ${m}`);

if (TASK_ONLY) {
  const dest = DEST;
  const supPath = path.join(dest, IS_WIN_TARGET ? "supervise.ps1" : "supervise.sh");
  if (!fs.existsSync(supPath)) {
    console.error("--task-only 需要已部署的目录（缺 " + path.basename(supPath) + "）: " + dest);
    process.exit(1);
  }
  if (!IS_WIN_TARGET) {
    console.error("--task-only 只支持 Windows；Linux/macOS 请用 deploy/linux/install-systemd.sh");
    process.exit(2);
  }
  try { execFileSync("schtasks", ["/delete", "/tn", "trae2api-runtime", "/f"], { stdio: "ignore" }); } catch {}
  execFileSync("schtasks", ["/create", "/tn", "trae2api-runtime",
    "/tr", `pwsh.exe -NoProfile -ExecutionPolicy Bypass -File "${supPath}"`,
    "/sc", "onstart", "/ru", "SYSTEM", "/rl", "HIGHEST", "/f"], { stdio: "inherit" });
  execFileSync("schtasks", ["/run", "/tn", "trae2api-runtime"], { stdio: "inherit" });
  console.log("\n✅ 计划任务 trae2api-runtime 已创建并启动（目录 " + dest + "）");
  process.exit(0);
}

if (!VSIX || !fs.existsSync(VSIX)) {
  console.error("用法: node deploy/install-from-vsix.cjs --vsix <path-to.vsix> [--dest <仓库>/runtime] [--platform " + defaultTarget() + "] [--install-task]");
  process.exit(1);
}

// ---------- 1. 读 VSIX 目录 ----------
step(1, "解析 VSIX（目标平台 " + TARGET + "）");
const entries = listEntries(VSIX);
const extPkg = entries.find((e) => e.name === "extension/package.json");
if (!extPkg) throw new Error("VSIX 结构异常：找不到 extension/package.json");
const tmpPkg = path.join(DEST, ".tmp-package.json");
extractEntry(VSIX, extPkg, tmpPkg);
const pkg = JSON.parse(fs.readFileSync(tmpPkg, "utf8"));
fs.rmSync(tmpPkg, { force: true });
const VERSION = pkg.version;
log(`  扩展: ${pkg.publisher || ""}.${pkg.name}  版本 ${VERSION}`);
log(`  条目: ${entries.length} 个`);

const AISERVER_PREFIX = "extension/resource/aiserver/";

// 与目标平台无关的文件一律保留；平台专属文件只留目标平台的（7z 工具额外保留本机平台那份，
// 否则「Windows 上装 Linux 运行时」这种交叉场景会缺解包工具）
const isPlatformSpecific = (rel) =>
  /^resources\/binaries\//.test(rel) ||
  /^resources\/tools\/7z\//.test(rel) ||
  /^(zmq|index)\.[a-z0-9]+-.*\.node$/.test(rel) ||
  // prebuild 下只按平台丢 *.node；像 prebuild/manifest.json 这种索引文件必须保留，
  // 否则 aiserver 的 zeromq 加载器找不到 addon（实测：缺 manifest.json → Failed to load zeromq）
  /^prebuild\/.*\.node$/.test(rel);

const belongsToTarget = (rel) =>
  rel.includes(TARGET) ||
  rel.startsWith(`prebuild/${PLAT_OS}/${PLAT_ARCH}/`) ||
  new RegExp(`^resources/tools/7z/${PLAT_OS}(-${PLAT_ARCH})?/`).test(rel) ||
  // 7z 工具按「本机」选，交叉安装时两边都要留着，否则缺解包器
  new RegExp(`^resources/tools/7z/${HOST_OS}(-${HOST_ARCH})?/`).test(rel) ||
  (HOST_OS === PLAT_OS && rel.includes(`${HOST_OS}-${HOST_ARCH}`));

// ---------- 2. 解出 aiserver ----------
step(2, "解出 aiserver（只留 " + TARGET + " 与通用文件）");
const serverDir = path.join(DEST, "aiserver");
let kept = 0, dropped = 0, bytes = 0;
for (const e of entries) {
  if (!e.name.startsWith(AISERVER_PREFIX) || e.name.endsWith("/")) continue;
  const rel = e.name.slice(AISERVER_PREFIX.length);
  if (isPlatformSpecific(rel) && !belongsToTarget(rel)) { dropped++; continue; }
  const out = path.resolve(serverDir, rel.replace(/\//g, path.sep));
  // zip-slip 防护：条目名可能带 ../ 跳出目标目录
  if (!out.startsWith(path.resolve(serverDir) + path.sep)) { dropped++; continue; }
  const n = extractEntry(VSIX, e, out);
  kept++; bytes += n;
}
log(`  解出 ${kept} 个文件（${(bytes / 1048576).toFixed(1)} MB），跳过其它平台 ${dropped} 个`);

const mainJs = path.join(serverDir, "aiServerMainV2.js");
if (!fs.existsSync(mainJs)) throw new Error("解出来的 aiserver 里没有 aiServerMainV2.js");
const cueCfg = path.join(serverDir, "resources", "cue", "lintErrorCategory.config.json");
if (!fs.existsSync(cueCfg)) console.warn("  ⚠ 缺少 resources/cue/lintErrorCategory.config.json（启动会失败）");

// ---------- 3. 解二进制包 ----------
step(3, "解二进制包 " + TARGET + ".7z（ai-agent + ckg）");
// 7z 工具按本机选：Windows 用 7za.exe，Linux/macOS 用 7zz
const sevenZipRel = HOST_OS === "win32"
  ? "resources/tools/7z/win32-x64/7za.exe"
  : HOST_OS === "linux" ? "resources/tools/7z/linux-x64/7zz" : "resources/tools/7z/darwin/7zz";
const sevenZip = path.join(serverDir, sevenZipRel);
const archiveName = AISERVER_PREFIX + `resources/binaries/${TARGET}.7z`;
const archiveEntry = entries.find((e) => e.name === archiveName);
if (!archiveEntry) throw new Error("VSIX 里没有 resources/binaries/" + TARGET + ".7z");
if (!fs.existsSync(sevenZip)) throw new Error("VSIX 里没有 7z 工具（" + sevenZipRel + "）");

const tmpArc = path.join(DEST, `.tmp-${TARGET}.7z`);
log("  正在从 VSIX 取出 7z 包…");
extractEntry(VSIX, archiveEntry, tmpArc);
const binDest = path.join(DEST, "profile", ".trae-runtime", "ai-chat", "binary", VERSION);
fs.mkdirSync(binDest, { recursive: true });
log(`  解包到 ${binDest} …`);
if (HOST_OS !== "win32") { try { fs.chmodSync(sevenZip, 0o755); } catch {} }   // VSIX 里的 7zz 默认没有可执行位
execFileSync(sevenZip, ["x", tmpArc, `-o${binDest}`, "-y"], { stdio: "inherit" });
fs.rmSync(tmpArc, { force: true });

const agentExe = IS_WIN_TARGET
  ? path.join(binDest, "modules", "ai-agent", "ai-agent.exe")
  : path.join(binDest, "modules", "ai-agent", "ai-agent");
const ckgExe = IS_WIN_TARGET
  ? path.join(binDest, "modules", "ckg", "binary", "ckg_server_windows_x64.exe")
  : path.join(binDest, "modules", "ckg", "binary", "ckg_server");
if (!fs.existsSync(agentExe)) throw new Error("解包后找不到 ai-agent 可执行文件（" + agentExe + "）");
log(`  ai-agent: ${(fs.statSync(agentExe).size / 1048576).toFixed(0)} MB ✅`);
log(`  ckg     : ${fs.existsSync(ckgExe) ? "✅" : "⚠ 缺失"}`);

// 非 Windows 的可执行位在 zip 里丢了，解出来后要自己加
if (!IS_WIN_TARGET) {
  for (const f of [agentExe, ckgExe, path.join(binDest, "modules", "ai-agent", "start.sh"),
    path.join(binDest, "modules", "ckg", "start.sh")]) {
    try { if (fs.existsSync(f)) fs.chmodSync(f, 0o755); } catch {}
  }
}

// 运行时要求 binary 目录里有 monitor.js（ai-agent 的包装器），它不在 7z 包里，来自 aiserver/resources/scripts
const monSrc = path.join(serverDir, "resources", "scripts", "monitor.js");
const monDst = path.join(binDest, "monitor.js");
if (fs.existsSync(monSrc)) {
  fs.copyFileSync(monSrc, monDst);
  log("  monitor.js  ✅ 已从 resources/scripts 复制");
} else {
  log("  ⚠ 找不到 resources/scripts/monitor.js（运行时会报 MODULE_NOT_FOUND）");
}

// ---------- 4. 打补丁 ----------
step(4, "给 aiserver 打「无连接不退出」补丁");
const FROM = "$Ur=0x3c*0x3e8";
const TO = "$Ur=0x7fffffff";
let js = fs.readFileSync(mainJs, "utf8");
if (js.includes(TO)) {
  log("  已打过补丁，跳过");
} else if (!js.includes(FROM)) {
  log("  ⚠ 找不到锚点（版本结构变了），未打补丁 —— 可能需要人工确认");
} else {
  fs.writeFileSync(mainJs + ".bak-original", js, "utf8");
  const n = js.split(FROM).length - 1;
  js = js.split(FROM).join(TO);
  fs.writeFileSync(mainJs, js, "utf8");
  log(`  已替换 ${n} 处（60 秒 → ≈24.8 天），原件备份 aiServerMainV2.js.bak-original`);
}

// ---------- 5. 生成启动与看护 ----------
step(5, "生成启动脚本 / 看护脚本 / 配置");
const ahaDir = path.join(DEST, "aha");
fs.mkdirSync(ahaDir, { recursive: true });
fs.mkdirSync(path.join(DEST, "logs"), { recursive: true });

const MACHINE_ID = process.env.TRAE_MACHINE_ID || require("crypto").randomBytes(32).toString("hex");
const SERVER_NAME = "trae-standalone-1";
const LOG_FILE = path.join(DEST, "logs", "aiserver.log");

// aiserver 的公共参数（两个平台一致）
const commonArgs = [
  "aiServerMainV2.js",
  "--pluginHomePathName", ".trae-runtime",
  "--isExternal", "true",
  "--server-root", `"${serverDir}"`,
  "--extension-version", VERSION,
  "--logFile", "true",
  "--channel", "vscode",
  "--product-name", "vscode",
  "--env-name", '""',
  "--is-remote", "false",
  "--enable-event-verify", "false",
  "--log-level", "3",
  "--event-verify-host", '""',
  "--machine-id", MACHINE_ID,
  "--region", "cn",
  "--ideType", "vscode-external",
  "--aha-ipc-runtime-dir", `"${ahaDir}"`,
  "--aha-ipc-server-name", SERVER_NAME,
].join(" ");

let supervisorPath = "";
if (IS_WIN_TARGET) {
  const runCmd = `@echo off
rem 由 install-from-vsix.cjs 生成
set USERPROFILE=${DEST}\\profile
set HOME=${DEST}\\profile
set APPDATA=${DEST}\\profile\\AppData\\Roaming
set LOCALAPPDATA=${DEST}\\profile\\AppData\\Local
set HOMEDRIVE=${DEST.slice(0, 2)}
set HOMEPATH=${DEST.slice(2)}
cd /d "${serverDir}"
"${process.execPath}" ${commonArgs} >> "${LOG_FILE}" 2>&1
`;
  fs.writeFileSync(path.join(DEST, "run-aiserver.cmd"), runCmd, "ascii");

  const supervise = `# 由 install-from-vsix.cjs 生成：确保 aiserver 常驻
$ErrorActionPreference = 'Continue'
$log = '${path.join(DEST, "logs", "supervise.log")}'
function Log($m) { Add-Content -Path $log -Value ("[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m) -Encoding utf8 }
Log "看护器启动"
while ($true) {
    $p = Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'aiServerMainV2' -and $_.CommandLine -match [regex]::Escape('${DEST}\\aha') } | Select-Object -First 1
    if (-not $p) {
        Log "未发现运行时，拉起"
        Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', '${path.join(DEST, "run-aiserver.cmd")}' -WindowStyle Hidden
        Start-Sleep -Seconds 25
    } else { Start-Sleep -Seconds 15 }
}
`;
  supervisorPath = path.join(DEST, "supervise.ps1");
  fs.writeFileSync(supervisorPath, "\ufeff" + supervise, "utf8");
} else {
  const runSh = `#!/usr/bin/env bash
# 由 install-from-vsix.cjs 生成（目标平台 ${TARGET}）
set -u
export HOME="${DEST}/profile"
export XDG_CONFIG_HOME="$HOME/.config"
export XDG_DATA_HOME="$HOME/.local/share"
export XDG_CACHE_HOME="$HOME/.cache"
export ICUBE_MODULAR_DATA_DIR="$HOME/.icube"
export AI_NATIVE_ENV="\${AI_NATIVE_ENV:-desktop}"
mkdir -p "$ICUBE_MODULAR_DATA_DIR/ai-agent" "$ICUBE_MODULAR_DATA_DIR/ai-chat"
# 插件主目录必须存在：缺失时 aiserver 会 path.join(undefined) → exit(15)，且日志里什么都不写
mkdir -p "$HOME/.trae-runtime"
cd "${serverDir}" || exit 1
exec "${process.execPath}" ${commonArgs} >> "${LOG_FILE}" 2>&1
`;
  const runShPath = path.join(DEST, "run-aiserver.sh");
  fs.writeFileSync(runShPath, runSh, "utf8");
  fs.chmodSync(runShPath, 0o755);

  const superviseSh = `#!/usr/bin/env bash
# 由 install-from-vsix.cjs 生成：确保 aiserver 常驻（Linux/macOS）
LOG="${DEST}/logs/supervise.log"
log() { printf '[%s] %s\\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$1" >> "$LOG"; }
log "看护器启动"
while true; do
  if ! pgrep -f "aiServerMainV2.*${ahaDir}" >/dev/null 2>&1; then
    log "未发现运行时，拉起"
    nohup "${DEST}/run-aiserver.sh" >/dev/null 2>&1 &
    sleep 25
  else
    sleep 15
  fi
done
`;
  supervisorPath = path.join(DEST, "supervise.sh");
  fs.writeFileSync(supervisorPath, superviseSh, "utf8");
  fs.chmodSync(supervisorPath, 0o755);
  log("  Linux/macOS：启动用 run-aiserver.sh，看护用 supervise.sh（或 deploy/linux/install-systemd.sh）");
}

log(`  运行时目录: ${DEST}`);
log(`  启动脚本  : ${path.join(DEST, IS_WIN_TARGET ? "run-aiserver.cmd" : "run-aiserver.sh")}`);
log(`  看护脚本  : ${supervisorPath}`);

// ---------- 6. 计划任务（可选，仅 Windows） ----------
if (INSTALL_TASK) {
  if (!IS_WIN_TARGET) {
    log("  --install-task 只适用于 Windows；Linux 请改用 deploy/linux/install-systemd.sh");
  } else {
    step(6, "安装计划任务（开机自启，不登录也跑）");
    try {
      execFileSync("schtasks", ["/delete", "/tn", "trae2api-runtime", "/f"], { stdio: "ignore" });
    } catch {}
    execFileSync("schtasks", [
      "/create", "/tn", "trae2api-runtime",
      "/tr", `pwsh.exe -NoProfile -ExecutionPolicy Bypass -File "${supervisorPath}"`,
      "/sc", "onstart", "/ru", "SYSTEM", "/rl", "HIGHEST", "/f",
    ], { stdio: "inherit" });
    execFileSync("schtasks", ["/run", "/tn", "trae2api-runtime"], { stdio: "inherit" });
    log("  任务 trae2api-runtime 已创建并启动");
  }
}

// ---------- 完成提示 ----------
console.log(`
================ 部署完成 ================
运行时目录 : ${DEST}
目标平台   : ${TARGET}
扩展版本   : ${VERSION}
二进制     : ${binDest}

接着做两件事：
1) 启动运行时${INSTALL_TASK && IS_WIN_TARGET ? "（已装计划任务，无需手动）" : ""}
   ${IS_WIN_TARGET ? path.join(DEST, "run-aiserver.cmd") : "bash " + path.join(DEST, "run-aiserver.sh")}

2) 让网关用上这份运行时：**不需要手工配置**
   start-trae2api.ps1 / 启动脚本会自适应探测 <网关目录>/runtime（或 deploy.json 的 root）；
   只有想放到别处时才需要显式指定：
   ${IS_WIN_TARGET ? "set" : "export"} TRAE2API_AHA_DIR=${path.join(ahaDir, "aha")}

首次使用需要登录：profile 在 ${path.join(DEST, "profile")}，登录后凭据落该目录。
==========================================
`);
