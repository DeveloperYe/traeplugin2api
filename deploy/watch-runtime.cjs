#!/usr/bin/env node
// 常驻「短周期」看护：每 N 秒（默认 5s）检查运行时；崩了立刻拉起并自动预热。
// 与旧的 supervise.ps1（15s 轮询、只拉起不预热）相比：
//   1) 周期更短（默认 5s）；
//   2) 拉起后自动跑 warm-runtime.cjs 预热（模型目录 + 极小 chat）；
//   3) 进程还活着但「链路挂死」时，通过网关 /api/status 的 modelsError / heal.recentFailures
//      判断，并让网关自己执行 /api/heal（网关知道有没有请求在跑，不会掐断回答）。
//
// 用法：
//   node deploy/watch-runtime.cjs --dest <运行时目录>                       # 常驻（默认 5s）
//   node deploy/watch-runtime.cjs --dest <运行时目录> --interval 3          # 更激进
//   node deploy/watch-runtime.cjs --dest <运行时目录> --dry-run             # 只自检一次并退出
//   node deploy/watch-runtime.cjs --dest <运行时目录> --no-heal --no-warm   # 只保进程
const fs = require("fs");
const path = require("path");
const { spawn, execFile, execFileSync } = require("child_process");

function parseArgs(argv) {
  const o = {
    dest: "", interval: 5, gateway: "http://127.0.0.1:18790", key: "",
    warm: true, heal: true, dryRun: false, healCooldownMs: 60e3,
    graceHealMs: 90e3, badStreak: 2,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dest") o.dest = argv[++i] || "";
    else if (a === "--interval") o.interval = Math.max(2, Number(argv[++i]) || 5);
    else if (a === "--gateway") o.gateway = (argv[++i] || o.gateway).replace(/\/$/, "");
    else if (a === "--key") o.key = argv[++i] || "";
    else if (a === "--no-warm") o.warm = false;
    else if (a === "--no-heal") o.heal = false;
    else if (a === "--grace-heal") o.graceHealMs = Math.max(0, Number(argv[++i]) || 0) * 1000;
    else if (a === "--bad-streak") o.badStreak = Math.max(1, Number(argv[++i]) || 1);
    else if (a === "--dry-run") o.dryRun = true;
    else if (a === "--help" || a === "-h") {
      console.log("用法: node deploy/watch-runtime.cjs --dest <运行时目录> [--interval 5] [--gateway http://127.0.0.1:18790] [--key api_key] [--no-warm] [--no-heal] [--dry-run]");
      process.exit(0);
    }
  }
  return o;
}

const args = parseArgs(process.argv.slice(2));
const repo = path.resolve(__dirname, "..");
const dest = path.resolve(args.dest || path.join(repo, "runtime"));
const logDir = path.join(dest, "logs");
const logFile = path.join(logDir, "watch.log");
const runner = path.join(dest, process.platform === "win32" ? "run-aiserver.cmd" : "run-aiserver.sh");
const warmScript = path.join(__dirname, "warm-runtime.cjs");

if (!args.key) {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(repo, "data", "config.json"), "utf8"));
    args.key = cfg.api_key || cfg.pwd || "";
  } catch {}
}

function log(msg) {
  const line = `[${new Date().toISOString().replace("T", " ").slice(0, 19)}] ${msg}`;
  console.log(line);
  try {
    fs.mkdirSync(logDir, { recursive: true });
    if (fs.existsSync(logFile) && fs.statSync(logFile).size > 2 * 1024 * 1024) {
      try { fs.renameSync(logFile, logFile + ".1"); } catch {}
    }
    fs.appendFileSync(logFile, line + "\n", "utf8");
  } catch {}
}

function isAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}

function findAiserverPid() {
  try {
    if (process.platform === "win32") {
      const out = execFileSync("powershell.exe", ["-NoProfile", "-Command",
        "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -match 'aiServerMainV2' } | ForEach-Object { $_.ProcessId }",
      ], { encoding: "utf8", timeout: 25000 });
      const pids = String(out).split(/\s+/).filter(Boolean).map(Number).filter(Boolean);
      return pids[0] || 0;
    }
    const out = execFileSync("pgrep", ["-f", "aiServerMainV2"], { encoding: "utf8", timeout: 10000 });
    return Number(String(out).split(/\s+/).filter(Boolean)[0]) || 0;
  } catch {
    return 0;
  }
}

// 异步查 pid：CIM 首次调用可能要 10s+，不能阻塞 5s 的 tick
function findAiserverPidAsync() {
  return new Promise((resolve) => {
    if (process.platform !== "win32") {
      execFile("pgrep", ["-f", "aiServerMainV2"], { timeout: 10000 }, (err, stdout) => {
        if (err) return resolve(0);
        return resolve(Number(String(stdout).split(/\s+/).filter(Boolean)[0]) || 0);
      });
      return;
    }
    execFile("powershell.exe", ["-NoProfile", "-Command",
      "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -match 'aiServerMainV2' } | ForEach-Object { $_.ProcessId }",
    ], { timeout: 25000 }, (err, stdout) => {
      if (err) return resolve(0);
      return resolve(Number(String(stdout).split(/\s+/).filter(Boolean)[0]) || 0);
    });
  });
}

function launch() {
  if (!fs.existsSync(runner)) { log("✗ 找不到启动脚本：" + runner + "（运行时还没部署？）"); return false; }
  log("启动运行时：" + runner);
  try {
    if (process.platform === "win32") {
      spawn("cmd.exe", ["/c", runner], { detached: true, stdio: "ignore", windowsHide: true }).unref();
    } else {
      spawn("sh", ["-c", `nohup "${runner}" >/dev/null 2>&1 &`], { detached: true, stdio: "ignore" }).unref();
    }
    return true;
  } catch (e) {
    log("✗ 启动失败：" + e.message);
    return false;
  }
}

function warm(tag) {
  if (!args.warm || !fs.existsSync(warmScript)) return;
  log("预热开始（" + tag + "）");
  const child = spawn(process.execPath, [warmScript, "--dest", dest], { detached: true, stdio: ["ignore", "pipe", "pipe"] });
  let buf = "";
  const onData = (d) => { buf += String(d); };
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);
  child.on("exit", (code) => {
    const tail = buf.trim().split("\n").slice(-3).join(" | ");
    log((code === 0 ? "✅ 预热完成 " : "⚠ 预热失败(" + code + ") ") + tail);
  });
}

// 是否该让网关自愈：宽限期内不动手、且要连续 N 次都坏（2026-11-24 加，避免单次抖动就杀 aiserver）
function shouldHeal({ status, uptimeMs, badStreak, graceMs, minStreak, cooldownOk }) {
  const up = Number(uptimeMs);
  if (Number.isFinite(up) && up < Number(graceMs || 0)) return { heal: false, why: '宽限期内（uptime ' + Math.round(up / 1000) + 's < ' + Math.round(Number(graceMs) / 1000) + 's）' };
  if (!cooldownOk) return { heal: false, why: '冷却中' };
  if (Number(badStreak) < Number(minStreak || 1)) return { heal: false, why: '连续坏次数不足（' + badStreak + '/' + minStreak + '）' };
  return { heal: true, why: '连续 ' + badStreak + ' 次异常' };
}
async function gatewayStatus() {
  try {
    const r = await fetch(args.gateway + "/api/status", {
      headers: args.key ? { Authorization: "Bearer " + args.key } : {},
      signal: AbortSignal.timeout(6000),
    });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

async function askGatewayHeal(reason) {
  try {
    const r = await fetch(args.gateway + "/api/heal", {
      method: "POST",
      headers: args.key ? { Authorization: "Bearer " + args.key } : {},
      signal: AbortSignal.timeout(120000),
    });
    const j = await r.json().catch(() => null);
    let brief = "";
    try {
      brief = JSON.stringify((j && (j.heals != null ? { heals: j.heals } : (j.after && j.after.heals != null ? { heals: j.after.heals } : (j.error || j)))) || "");
    } catch { brief = ""; }
    log("[heal] 让网关自愈（" + reason + "）→ HTTP " + r.status + " " + String(brief).slice(0, 120));
    return r.ok;
  } catch (e) {
    log("[heal] 调用 /api/heal 失败：" + e.message);
    return false;
  }
}

async function main() {
  if (!fs.existsSync(dest)) { log("✗ 运行时目录不存在：" + dest); process.exit(1); }
  log("看护启动：dest=" + dest + " interval=" + args.interval + "s gateway=" + args.gateway +
      " warm=" + args.warm + " heal=" + args.heal + " key=" + (args.key ? "有" : "无"));

  if (args.dryRun) {
    const pid = findAiserverPid();
    const st = await gatewayStatus();
    log("dry-run：aiserver pid=" + (pid || "无") + "（存活=" + isAlive(pid) + "）");
    log("dry-run：启动脚本存在=" + fs.existsSync(runner) + " 预热脚本存在=" + fs.existsSync(warmScript));
    log("dry-run：网关 " + (st ? "可达，connected=" + st.connected + " modelsError=" + JSON.stringify(st.modelsError || null) + " heal=" + JSON.stringify(st.heal || null) : "不可达"));
    process.exit(0);
  }

  let pid = findAiserverPid();
  let lastHealAt = 0;
  let badStreak = 0;
  let lastGateLog = 0;
  let lastBeat = 0;
  let launches = 0, heals = 0;

  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
    // 1) 进程级：崩了立刻拉起 + 预热
    if (!isAlive(pid)) {
      // pid 未知/已死：先异步确认一次（避免把「pid 没取到」误判成崩溃）
      if (!pid || pid === 0) { pid = await findAiserverPidAsync(); }
      if (isAlive(pid)) return;
      log("检测到 aiserver 不在运行（pid=" + (pid || "无") + "），立即拉起");
      if (launch()) {
        launches++;
        pid = 0;
        // 给 aiserver 一点启动时间再找 pid/预热
        setTimeout(async () => { pid = await findAiserverPidAsync(); log("拉起后 aiserver pid=" + (pid || "未取到")); warm("crash-restart"); }, 2500);
      }
      return;
    }

    // 2) 链路级：进程活着，问网关看链路是否挂死
    if (args.heal && Date.now() - lastHealAt > args.healCooldownMs) {
      const st = await gatewayStatus();
      if (st) {
        // 判据：有任意失败记录、或已断开、或有 modelsError
        const bad = (st.connected === false) || !!st.modelsError ||
          (st.heal && (Number(st.heal.recentFailures) > 0 || Number(st.heal.recentWeight) > 0)) ||
          (st.heal && Number(st.heal.healing) > 0);
        if (bad) badStreak += 1; else badStreak = 0;
        // 宽限期内（网关刚起）+ 连续坏次数不足时都不动手，只在日志里说明
        const gate = shouldHeal({
          status: st, uptimeMs: st.uptimeMs, badStreak,
          graceMs: args.graceHealMs, minStreak: args.badStreak,
          cooldownOk: Date.now() - lastHealAt > args.healCooldownMs,
        });
        const why = "connected=" + st.connected + " modelsError=" + JSON.stringify(st.modelsError || null) +
          " recentFailures=" + (st.heal ? st.heal.recentFailures : "?") +
          " recentWeight=" + (st.heal ? st.heal.recentWeight : "?") +
          " uptime=" + (Number.isFinite(Number(st.uptimeMs)) ? Math.round(Number(st.uptimeMs) / 1000) + "s" : "?") +
          " badStreak=" + badStreak;
        if (bad && !gate.heal) {
          if (badStreak === 1 || Date.now() - lastGateLog > 60e3) { lastGateLog = Date.now(); log("[heal] 暂缓（" + gate.why + "）：" + why); }
        } else if (bad && gate.heal) {
          lastHealAt = Date.now();
          badStreak = 0;
          if (await askGatewayHeal(why)) heals++;
        }
      }
    }

    // 3) 心跳（每 60s 一条，避免刷日志）
    if (Date.now() - lastBeat > 60e3) {
      lastBeat = Date.now();
      const st = await gatewayStatus();
      log("心跳：aiserver pid=" + pid + " 存活，网关 " + (st ? ("connected=" + st.connected + " 模型 " + (st.models ? st.models.length : "?") + " 个") : "不可达") +
        "｜累计拉起 " + launches + " 次，触发自愈 " + heals + " 次");
    }
    } finally { busy = false; }
  };

  await tick();
  setInterval(() => { tick().catch((e) => log("tick 异常：" + e.message)); }, args.interval * 1000);
}

// 只有直接运行才进主循环（被 require 时只导出判定函数，方便单测）
if (require.main === module) {
  main().catch((e) => { log("主循环异常：" + ((e && e.message) || e)); process.exit(1); });
}

module.exports = { shouldHeal };
