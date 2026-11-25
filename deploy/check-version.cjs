#!/usr/bin/env node
// 版本/功能自检：某个部署目录里到底有没有这些修复。
// 用途：多机部署时确认「本机跟上仓库了没」，比逐文件比 hash 靠谱
//（发布仓库是脱敏副本，注释/路径不同也会让 hash 不一致）。
//
// 用法：
//   node deploy/check-version.cjs                 # 检查本脚本所在仓库
//   node deploy/check-version.cjs --dir D:\apps\trae2api
//   node deploy/check-version.cjs --json
//
// 退出码：0 全部具备；1 有缺失。

const fs = require("fs");
const path = require("path");

const args = process.argv.slice(2);
const dirArg = args.indexOf("--dir");
const dir = path.resolve(dirArg >= 0 ? args[dirArg + 1] : path.join(__dirname, ".."));
const asJson = args.includes("--json");

// [标签, 文件, 检查内容(字符串或正则), 说明]
const FEATURES = [
  ["creds.bundleCandidates", "lib/creds.cjs", "function bundleCandidates", "clientSecret 多路径探测（修 20107）"],
  ["creds.saveTokenCache", "lib/creds.cjs", "function saveTokenCache", "面板登录后写网关自己的凭据缓存"],
  ["creds.tightenAcl", "lib/creds.cjs", "function tightenAcl", "ACL 收紧但保留当前用户（修「读不到自己的缓存」）"],
  ["creds.aclPrincipals", "lib/creds.cjs", "function aclPrincipals", "内置主体用 SID 表达，跨语言系统可用"],
  ["creds.selfHeal", "lib/creds.cjs", "补授当前用户", "老坏 ACL 文件读时自动修复"],
  ["server.diagnoseEmpty", "server.cjs", "function diagnoseEmpty", "空结果按证据归因，不再一律怪输入超限"],
  ["server.statusDetail", "server.cjs", "statusDetail", "请求日志记录失败细节"],
  ["server.onCredsSaved", "server.cjs", "onCredsSaved", "登录成功即时切凭据，不用重启网关"],
  ["tools.budget24000", "lib/tools-bridge.cjs", "const DEFAULT_BUDGET = 24000", "工具块兜底预算与默认配置一致"],
  ["model.aliasGuard", "lib/models.cjs", "function resolveModel", "未知模型显式拦截 + 别名映射（防静默替换）"],
  ["model.checkModel", "server.cjs", "async function checkModel", "两处入口都做模型名校验"],
  ["heal.auto", "lib/healer.cjs", "function createHealer", "运行时挂死自动自愈（AHA 链路断开 → 重启 aiserver）"],
  ["heal.endpoint", "server.cjs", "/api/heal", "手动触发自愈的接口"],
  ["heal.probe", "server.cjs", "function startRuntimeProbe", "空闲期主动存活探测（缓存热时也能发现链路挂死）"],
  ["heal.weighted", "lib/healer.cjs", "recentWeight", "失败带权重：真实对话单次即触发自愈"],
  ["ws.check", "lib/workspace-check.cjs", "checkWorkspace", "声明的工作目录不存在时明确报错"],
  ["ws.notice", "lib/workspace-notice.cjs", "buildNotice", "提示词层声明锚点不是工作目录"],
  ["ws.declare", "lib/workspace-declare.cjs", "matchInLine", "声明识别收紧：关键词+分隔符+绝对路径，默认只看 system"],
  ["rzn.context", "lib/trae.cjs", "flattenMessages", "历史思考回填（reasoning_context）"],
  ["test.reasoningContext", "test-reasoning-context.cjs", null, "思考回填回归测试"],
  ["test.workspaceDeclare", "test-workspace-declare.cjs", null, "防误命中回归测试"],
  ["test.workspaceNotice", "test-workspace-notice.cjs", null, "工作区归属提示词回归测试"],
  ["test.workspaceCheck", "test-workspace-check.cjs", null, "工作区校验回归测试"],
  ["aha.addonCandidates", "lib/aha.cjs", "TRAE2API_AHA_ADDON", "zmq addon 支持自包含运行时与显式指定"],
  ["test.addonResolve", "test-addon-resolve.cjs", null, "addon 三条解析路径的回归测试"],
  ["runtime.restartSwitch", "start-runtime.ps1", "-Restart", "手动强制重启运行时"],
  ["runtime.warmAfterRestart", "server.cjs", "async function warmupRuntime", "重启后自动预热，中断从 ~40s 降到几秒"],
  ["watch.runtime", "deploy/watch-runtime.cjs", "短周期", "5s 周期：崩溃即拉起 + 自动预热"],
  ["warm.runtime", "deploy/warm-runtime.cjs", "--dry-run", "不依赖网关的独立预热脚本"],
  ["cdp.bundled", "lib/cdp.cjs", "function bundledCandidates", "自带 chrome-headless-shell 探测"],
  ["cdp.launchArgs", "lib/cdp.cjs", "function launchArgs", "headless-shell 专用启动参数"],
  ["login.ephemeralProfile", "lib/trae-login.cjs", "_cleanupProfile", "登录用完即删浏览器配置（不残留登录态）"],
  ["panel.statusLabel", "public/index.html", "STATUS_LABEL", "结果列不再把失败显示成绿色 ok"],
  ["panel.toolBlockCol", "public/index.html", "<th>工具块</th>", "请求日志列名准确"],
  ["panel.safekeyHint", "public/index.html", "可缺", "safekey.bin 缺失不再被误判为故障"],
  ["deploy.fetchBrowser", "deploy/fetch-browser.cjs", null, "按需下载浏览器内核"],
  ["deploy.bootstrapBrowser", "deploy/bootstrap-runtime.ps1", "6.5) 自带浏览器内核", "自举路径也会拉内核"],
  ["deploy.setupBrowser", "deploy/setup.ps1", "5.5) 可选：自带浏览器内核", "一键部署带内核"],
  ["start.runtimeStarter", "start-runtime.ps1", null, "一条命令拉起运行时并等 connected"],
  ["start.autoRuntime", "start-trae2api.ps1", "start-runtime.ps1", "网关启动时自动拉起运行时"],
  ["docs.aiDeploy", "docs/AI-DEPLOY.md", null, "给 AI 的部署指令"],
  ["test.credsAcl", "test-creds-acl.cjs", null, "凭据 ACL 回归测试"],
  ["test.browserPick", "test-browser-pick.cjs", null, "浏览器选择回归测试"],
  // 4.0.60–4.0.71 新增能力（缺了这些说明部署落后于 README 4.0.71）
  ["toolcall.early", "server.cjs", "earlyCall", "工具调用早公告（检测到 CALL 先发 name-only tool_calls）"],
  ["stream.keepalive", "server.cjs", "stream_keepalive_ms", "静默期发 delta:{} 空帧（修客户端 idle timeout）"],
  ["idle.timeoutCfg", "lib/trae.cjs", "idle_timeout_ms", "空闲看门狗阈值可配（默认 600s，生产 240s）"],
  ["cap.lengthMark", "server.cjs", "capHit", "打满模型输出上限标 finish_reason=length"],
  ["models.capacity", "server.cjs", "function modelCapacity", "按模型覆盖上下文/输出容量并统一下发"],
  ["models.aliasFields", "server.cjs", "max_input_tokens", "兼容别名 context_length / max_input_tokens / limit.*"],
  ["config.jsonc", "lib/trae.cjs", "function stripJsonc", "config.json 支持 JSONC（注释/尾逗号）"],
  ["health.checks", "lib/health.cjs", "function computeChecks", "/healthz 输出通道/工作区/凭据三项自检"],
  ["tool.undeclaredGuard", "lib/tool-guard.cjs", "function partitionCalls", "未声明工具名回灌给上游（undeclared_tool_mode）"],
  ["lib.caps", "lib/caps.cjs", "function computeCapHit", "容量口径与打满上限判定（可单测）"],
  ["lib.streamMeta", "lib/stream-meta.cjs", "function shouldKeepalive", "保活判定与状态词表"],
  ["lib.ratelimit", "lib/ratelimit.cjs", "function createLimiter", "/v1 每分钟与并发限流"],
  ["log.rotate", "server.cjs", "rotateLogIfNeeded", "日志与 requests.jsonl 轮转"],
  ["fatal.guard", "server.cjs", "unhandledRejection", "全局异常兜底"],
  ["journal.reload", "server.cjs", "loadJournal();", "启动时回读 requests.jsonl（否则重启后面板日志为空）"],
  ["cookie.secure", "lib/cookie.cjs", "function buildSessionCookie", "HTTPS 时给会话 Cookie 自动加 Secure"],
  ["config.limitKeys", "config.example.json", "rate_limit_per_min", "示例配置含限流两个键"],
  ["config.toolAliasKeys", "config.example.json", "tool_aliases", "示例配置含未声明工具的三个键"],
  ["panel.newStatus", "public/index.html", "undeclared_tool", "面板状态标签覆盖 undeclared_tool"],
  ["test.silentCatch", "test-silent-catch.cjs", null, "静默 catch 闸门测试"],
  ["test.cookie", "test-cookie.cjs", null, "会话 Cookie 属性测试"],
  ["test.noDeadCode", "test-no-dead-code.cjs", null, "死代码守卫（未用导入/未引用函数/孤儿模块）"],
  ["client.gone", "server.cjs", "client_gone", "客户端断开即中止上游"],
  ["test.panelTables", "test-panel-tables.cjs", null, "面板表格与状态标签一致性测试"],
  ["test.caps", "test-caps.cjs", null, "容量口径测试"],
  ["test.keepalive", "test-keepalive.cjs", null, "保活与状态词表测试"],
  ["test.ratelimit", "test-ratelimit.cjs", null, "限流器测试"],
  ["test.toolWhitelist", "test-tool-whitelist.cjs", null, "工具名守卫回归测试"],
  ["test.configJsonc", "test-config-jsonc.cjs", null, "配置 JSONC 容错回归测试"],
  ["docs.config", "docs/CONFIG.md", null, "配置权威清单（键/环境变量/生效方式）"],
  ["tools.verifyDocs", "tools/verify-docs.cjs", null, "文档校对工具（键/路由/文件/用例数）"],
];

const rows = [];
let ok = 0, miss = 0;
for (const [label, rel, needle, note] of FEATURES) {
  const file = path.join(dir, rel);
  let state, extra = "";
  if (!fs.existsSync(file)) {
    state = "缺失文件"; miss++;
  } else if (needle === null) {
    state = "具备"; ok++;
  } else {
    let text = "";
    try { text = fs.readFileSync(file, "utf8"); } catch (e) { state = "读取失败"; miss++; rows.push({ label, rel, state, note }); continue; }
    const hit = needle.startsWith("^") || needle.includes(".*")
      ? new RegExp(needle).test(text)
      : text.includes(needle);
    state = hit ? "具备" : "未包含"; hit ? ok++ : miss++;
  }
  rows.push({ label, rel, state, note });
}

if (asJson) {
  console.log(JSON.stringify({ dir, ok, miss, rows }, null, 2));
} else {
  console.log("部署目录: " + dir);
  console.log("");
  const w = Math.max(...rows.map((r) => r.label.length));
  for (const r of rows) {
    const mark = r.state === "具备" ? "✓" : "✗";
    console.log("  " + mark + " " + r.label.padEnd(w) + "  " + r.state.padEnd(6) + "  " + r.note + "  (" + r.rel + ")");
  }
  console.log("");
  console.log("合计 " + rows.length + " 项：具备 " + ok + "，缺 " + miss);
  if (miss) {
    console.log("");
    console.log("缺的项说明这份部署早于对应修复 → 从仓库更新这些文件后重启网关（配置/文件改动无需改 data/）。");
  }
}
process.exit(miss ? 1 : 0);
