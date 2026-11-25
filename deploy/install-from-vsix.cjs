#!/usr/bin/env node
/**
 * 从 Trae/MarsCode 的 VSIX 一键部署「网关自带运行时」。
 *
 * 做什么：
 *   1. 解析 VSIX（zip），取出 extension/resource/aiserver（只留 win32-x64，省 ~270 MB）
 *   2. 用 VSIX 自带的 7za.exe 解开 resources/binaries/win32-x64.7z → 得到 ai-agent.exe + ckg
 *   3. 给 aiserver 打「无连接 60s 退出」补丁
 *   4. 生成启动脚本 + 看护脚本 + 配置（可选装计划任务）
 *
 * 用法：
 *   node deploy/install-from-vsix.cjs --vsix <你的vsix> [--dest <仓库>/runtime] [--install-task]
 *
 * 装完把网关指向 <dest>：
 *   TRAE2API_AHA_DIR=<dest>\aha\aha
 *   TRAE2API_AHA_PREFIX=vscode_ai_agent_
 *   TRAE2API_AGENT_PREF=extension,standalone
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

const VSIX = arg("--vsix", "");
const DEST = path.resolve(arg("--dest", path.join(__dirname, "..", "runtime")));
const INSTALL_TASK = flag("--install-task");
const TASK_ONLY = flag("--task-only");

if (TASK_ONLY) {
  const dest = DEST;
  const runCmdPath = path.join(dest, "run-aiserver.cmd");
  const supPath = path.join(dest, "supervise.ps1");
  if (!fs.existsSync(runCmdPath) || !fs.existsSync(supPath)) {
    console.error("--task-only 需要已部署的目录（缺 run-aiserver.cmd 或 supervise.ps1）: " + dest);
    process.exit(1);
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
  console.error("用法: node deploy/install-from-vsix.cjs --vsix <path-to.vsix> [--dest C:\\trae2api-runtime] [--install-task]");
  process.exit(1);
}

const log = (m) => console.log(m);
const step = (n, m) => console.log(`\n[${n}] ${m}`);

// ---------- 1. 读 VSIX 目录 ----------
step(1, "解析 VSIX");
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
// 只保留 win32-x64 需要的东西
const DROP = [
  /^resources\/binaries\/(darwin|linux)/,          // 其他平台二进制包（每个 ~85-92 MB）
  /^resources\/tools\/7z\/(darwin|linux)/,         // 其他平台 7z
  /^(index|zmq)\.(darwin|linux)/,                  // 其他平台原生模块
  /^index\.win32-ia32/,                            // 32 位
  /^prebuild\/(darwin|linux)\//,                   // 其他平台预编译
];

// ---------- 2. 解出 aiserver ----------
step(2, "解出 aiserver（只留 win32-x64）");
const serverDir = path.join(DEST, "aiserver");
let kept = 0, dropped = 0, bytes = 0;
for (const e of entries) {
  if (!e.name.startsWith(AISERVER_PREFIX) || e.name.endsWith("/")) continue;
  const rel = e.name.slice(AISERVER_PREFIX.length);
  if (DROP.some((re) => re.test(rel))) { dropped++; continue; }
  const out = path.resolve(serverDir, rel.replace(/\//g, path.sep));
  // zip-slip 防护：条目名可能带 ../ 跳出目标目录
  if (!out.startsWith(path.resolve(serverDir) + path.sep)) { dropped++; continue; }
  const n = extractEntry(VSIX, e, out);
  kept++; bytes += n;
}
log(`  解出 ${kept} 个文件（${(bytes / 1048576).toFixed(1)} MB），跳过其他平台 ${dropped} 个`);

const mainJs = path.join(serverDir, "aiServerMainV2.js");
if (!fs.existsSync(mainJs)) throw new Error("解出来的 aiserver 里没有 aiServerMainV2.js");
const cueCfg = path.join(serverDir, "resources", "cue", "lintErrorCategory.config.json");
if (!fs.existsSync(cueCfg)) console.warn("  ⚠ 缺少 resources/cue/lintErrorCategory.config.json（启动会失败）");

// ---------- 3. 解二进制包 ----------
step(3, "解二进制包 win32-x64.7z（ai-agent + ckg）");
const sevenZa = path.join(serverDir, "resources", "tools", "7z", "win32-x64", "7za.exe");
const archiveEntry = entries.find((e) => e.name === AISERVER_PREFIX + "resources/binaries/win32-x64.7z");
if (!archiveEntry) throw new Error("VSIX 里没有 resources/binaries/win32-x64.7z");
if (!fs.existsSync(sevenZa)) throw new Error("VSIX 里没有 7za.exe");

const tmpArc = path.join(DEST, ".tmp-win32-x64.7z");
log("  正在从 VSIX 取出 7z 包…");
extractEntry(VSIX, archiveEntry, tmpArc);
const binDest = path.join(DEST, "profile", ".trae-runtime", "ai-chat", "binary", VERSION);
fs.mkdirSync(binDest, { recursive: true });
log(`  解包到 ${binDest} …`);
execFileSync(sevenZa, ["x", tmpArc, `-o${binDest}`, "-y"], { stdio: "inherit" });
fs.rmSync(tmpArc, { force: true });
const agentExe = path.join(binDest, "modules", "ai-agent", "ai-agent.exe");
const ckgExe = path.join(binDest, "modules", "ckg", "binary", "ckg_server_windows_x64.exe");
if (!fs.existsSync(agentExe)) throw new Error("解包后找不到 ai-agent.exe");
log(`  ai-agent: ${(fs.statSync(agentExe).size / 1048576).toFixed(0)} MB ✅`);
log(`  ckg     : ${fs.existsSync(ckgExe) ? "✅" : "⚠ 缺失"}`);

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

const runCmd = `@echo off
rem 由 install-from-vsix.cjs 生成
set USERPROFILE=${DEST}\\profile
set HOME=${DEST}\\profile
set APPDATA=${DEST}\\profile\\AppData\\Roaming
set LOCALAPPDATA=${DEST}\\profile\\AppData\\Local
set HOMEDRIVE=${DEST.slice(0, 2)}
set HOMEPATH=${DEST.slice(2)}
cd /d "${serverDir}"
"${process.execPath}" aiServerMainV2.js --pluginHomePathName .trae-runtime --isExternal true --server-root "${serverDir}" --extension-version ${VERSION} --logFile true --channel vscode --product-name vscode --env-name "" --is-remote false --enable-event-verify false --log-level info --event-verify-host "" --machine-id ${MACHINE_ID} --region cn --ideType vscode-external --aha-ipc-runtime-dir "${ahaDir}" --aha-ipc-server-name ${SERVER_NAME} >> "${path.join(DEST, "logs", "aiserver.log")}" 2>&1
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
fs.writeFileSync(path.join(DEST, "supervise.ps1"), "\ufeff" + supervise, "utf8");

log(`  运行时目录: ${DEST}`);
log(`  启动脚本  : ${path.join(DEST, "run-aiserver.cmd")}`);
log(`  看护脚本  : ${path.join(DEST, "supervise.ps1")}`);

// ---------- 6. 计划任务（可选） ----------
if (INSTALL_TASK) {
  step(6, "安装计划任务（开机自启，不登录也跑）");
  try {
    execFileSync("schtasks", ["/delete", "/tn", "trae2api-runtime", "/f"], { stdio: "ignore" });
  } catch {}
  execFileSync("schtasks", [
    "/create", "/tn", "trae2api-runtime",
    "/tr", `pwsh.exe -NoProfile -ExecutionPolicy Bypass -File "${path.join(DEST, "supervise.ps1")}"`,
    "/sc", "onstart", "/ru", "SYSTEM", "/rl", "HIGHEST", "/f",
  ], { stdio: "inherit" });
  execFileSync("schtasks", ["/run", "/tn", "trae2api-runtime"], { stdio: "inherit" });
  log("  任务 trae2api-runtime 已创建并启动");
}

// ---------- 完成提示 ----------
console.log(`
================ 部署完成 ================
运行时目录 : ${DEST}
扩展版本   : ${VERSION}
二进制     : ${binDest}

接着做两件事：
1) 启动运行时（若没装计划任务）
   ${path.join(DEST, "run-aiserver.cmd")}

2) 让网关指向它（start-trae2api.ps1 里加这三行后重启网关）
   TRAE2API_AHA_DIR=${path.join(ahaDir, "aha")}
   TRAE2API_AHA_PREFIX=vscode_ai_agent_
   TRAE2API_AGENT_PREF=extension,standalone

首次使用需要登录：运行时的 profile 是 ${path.join(DEST, "profile")}，
登录后凭据会落在该目录（与桌面 VS Code 的 ~/.marscode 互不影响）。
==========================================
`);
