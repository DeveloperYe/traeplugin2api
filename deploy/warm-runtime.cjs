#!/usr/bin/env node
// 独立预热：不依赖网关进程，直接连 AHA 把模型目录 + 聊天链路焐热。
// 用途：看护器/watcher 拉起 aiserver 之后立刻跑一次，避免「第一个用户请求撞冷启 37–50s」。
//
// 用法：
//   node deploy/warm-runtime.cjs --dest <运行时目录>            # 正常预热
//   node deploy/warm-runtime.cjs --dest <运行时目录> --dry-run   # 只打印解析结果
//   node deploy/warm-runtime.cjs --dest <运行时目录> --model Doubao-Seed-Code
//
// 退出码：0 预热成功；1 失败（失败不影响网关，只是第一个请求会慢）。
const fs = require("fs");
const path = require("path");

function parseArgs(argv) {
  const out = { dest: "", model: "", dryRun: false, timeoutMs: 20000 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dest") out.dest = argv[++i] || "";
    else if (a === "--model") out.model = argv[++i] || "";
    else if (a === "--timeout-ms") out.timeoutMs = Number(argv[++i]) || out.timeoutMs;
    else if (a === "--dry-run") out.dryRun = true;
    else if (a === "--help" || a === "-h") { console.log("用法: node deploy/warm-runtime.cjs --dest <运行时目录> [--model 名字] [--timeout-ms 20000] [--dry-run]"); process.exit(0); }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const repo = path.resolve(__dirname, "..");
const dest = path.resolve(args.dest || path.join(repo, "runtime"));
const ahaDir = path.join(dest, "aha", "aha");

// 只有「自包含布局」（运行时目录里有 profile/）才把 HOME 指过去；
// 否则保留当前 HOME —— 扩展式部署的 zmq addon 就在 .vscode/extensions 里，改了 HOME 反而找不到。
const selfContained = fs.existsSync(path.join(dest, "profile"));
if (selfContained) {
  process.env.HOME = path.join(dest, "profile");
  process.env.USERPROFILE = path.join(dest, "profile");
  process.env.APPDATA = path.join(dest, "profile", "AppData", "Roaming");
  process.env.LOCALAPPDATA = path.join(dest, "profile", "AppData", "Local");
}
process.env.TRAE2API_AHA_DIR = ahaDir;
// 自包含布局下 addon 在 <dest>/aiserver/prebuild/**，显式给 aha 一个候选
try {
  const pre = path.join(dest, "aiserver", "prebuild");
  if (fs.existsSync(pre)) process.env.TRAE2API_AHA_ADDON = "";
} catch {}

const t0 = Date.now();
const say = (m) => console.log(`[warm ${new Date().toISOString().slice(11, 19)}] ${m}`);

if (args.dryRun) {
  say("dry-run：仓库=" + repo);
  say("dry-run：运行时=" + dest);
  say("dry-run：aha 目录=" + ahaDir + "（存在：" + fs.existsSync(ahaDir) + "）");
  say("dry-run：config=" + path.join(repo, "data", "config.json") + "（存在：" + fs.existsSync(path.join(repo, "data", "config.json")) + "）");
  process.exit(0);
}

(async () => {
  if (!fs.existsSync(ahaDir)) { say("找不到 aha 目录，预热放弃：" + ahaDir); process.exit(1); }
  let aha, creds, trae;
  try {
    const { AhaClient } = require(path.join(repo, "lib", "aha.cjs"));
    const { Creds } = require(path.join(repo, "lib", "creds.cjs"));
    const { TraeService } = require(path.join(repo, "lib", "trae.cjs"));
    aha = new AhaClient({ log: (m) => say("aha: " + m) });
    creds = new Creds({ log: (m) => say("creds: " + m) });
    trae = new TraeService({ aha, creds, log: (m) => say("trae: " + m), projectIdKey: "local_project_id" });
  } catch (e) {
    say("加载 lib 失败：" + e.message);
    process.exit(1);
  }

  try {
    await aha.connect();
    say("已连上 socket（" + (aha.addr || "?") + "，" + (Date.now() - t0) + "ms）");
  } catch (e) {
    say("连接失败：" + e.message);
    process.exit(1);
  }

  try {
    const tm = Date.now();
    const list = await trae.listModels(true, args.timeoutMs);
    say("模型目录 " + list.length + " 个（" + (Date.now() - tm) + "ms）");
    // workspace_folder 不存在就建：create_chat_session 会校验项目目录（code 992501）
    try {
      const ws = (trae.cfg && trae.cfg.workspace_folder) || path.join(process.env.HOME || "", "trae2api-workspace");
      if (ws && !fs.existsSync(ws)) { fs.mkdirSync(ws, { recursive: true }); say("已创建工作区目录：" + ws); }
    } catch {}

    const model = args.model || (trae.cfg && trae.cfg.default_model) || list[0]?.name;
    if (!model) { say("没有可用模型，跳过聊天预热"); process.exit(0); }
    const tc = Date.now();
    await trae.chat({
      model, prompt: "只回答：好",
      agentType: (trae.cfg && (trae.cfg.default_agent_type || trae.cfg.agent_type)) || "chat",
      agentId: (trae.cfg && (trae.cfg.default_agent_type || trae.cfg.agent_type)) || "chat",
      onThinking: () => {}, onContent: () => {}, onUsage: () => {},
    });
    say("聊天预热完成（" + (Date.now() - tc) + "ms，模型 " + model + "）");
    say("总耗时 " + (Date.now() - t0) + "ms");
    process.exit(0);
  } catch (e) {
    say("预热失败：" + e.message);
    process.exit(1);
  } finally {
    try { aha.close(); } catch {}
  }
})();
