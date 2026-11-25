// server.cjs —— trae2api：把 Trae 的 lite 通道包成 OpenAI 兼容接口 + 自带面板
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// 后端选择要在 require lib 之前决定：aha.cjs 在加载时读 AHA_DIR / 前缀
function readConfigFile() {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'config.json'), 'utf8')); } catch { return {}; }
}
const BOOTED_AT = Date.now();   // 网关进程启动时刻（/api/status 暴露，供看护器做宽限判断）
const BOOT_CFG = readConfigFile();

const { AhaClient } = require('./lib/aha.cjs');
const { Creds } = require('./lib/creds.cjs');
const { TraeService } = require('./lib/trae.cjs');
const { buildToolInstruction, parseCalls, toOpenAIToolCalls } = require('./lib/tools-bridge.cjs');
const { computeChecks } = require('./lib/health.cjs');
const { resolveToolName, partitionCalls, feedbackHint, stripIllegalCalls } = require('./lib/tool-guard.cjs');
const { capacityOf, computeCapHit, modelAliasFields } = require('./lib/caps.cjs');
const { shouldKeepalive, shouldPing, levelOf, isFailure } = require('./lib/stream-meta.cjs');
const { createLimiter } = require('./lib/ratelimit.cjs');
const { isSecureRequest, buildSessionCookie, clearSessionCookie } = require('./lib/cookie.cjs');
const WSC = require('./lib/workspace-check.cjs');
const WSN = require('./lib/workspace-notice.cjs');
const WD = require('./lib/workspace-declare.cjs');
const { hasUnterminatedCall } = require('./lib/call-parse.cjs');
const attachments = require('./lib/attachments.cjs');
const { TraeLogin } = require('./lib/trae-login.cjs');

const PORT = Number(process.env.PORT || 18790);
const HOST = process.env.HOST || '0.0.0.0';
const VERSION = '0.1.0';
const LOG_RING = [];

// ---------------- 首次运行自动生成配置 ----------------
// 没有 data/config.json 时，以前会「无口令裸奔」（authCfg().enabled=false → 面板与 /v1/* 全部放行）。
// 这里改为：文件不存在就生成一份，口令与 api_key 都用随机值，并打印出来。
function ensureConfig() {
  const f = path.join(__dirname, 'data', 'config.json');
  try {
    if (fs.existsSync(f)) return;
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const pwd = crypto.randomBytes(16).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, 16);
    const cfg = {
      port: PORT,
      host: HOST,
      panel_password: pwd,
      api_key: pwd,
      workspace_folder: path.join(require('os').homedir(), 'trae2api-workspace').replace(/\\/g, '/'),
      agent_type: 'builder',
      default_agent_type: 'builder',
      creds_auto_renew_hours: 24,
      native_ban: true,
      tool_schema_depth: 3,
      tool_block_budget: 24000,
      model_aliases: {},
      model_strict: true,
      runtime_heal: true,
      runtime_warmup_after_restart: true,
      runtime_restart_wait_sec: 90,
      runtime_heal_threshold: 2,
      runtime_heal_window_sec: 300,
      runtime_probe_sec: 15,
      runtime_probe_timeout_ms: 10000,
      runtime_heal_cooldown_sec: 120,
      image_passthrough: true,
    };
    fs.writeFileSync(f, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
    console.log('[boot] 首次运行：已生成 data/config.json');
    console.log('[boot] 面板口令 / api_key = ' + pwd + '（建议改成你自己的）');
  } catch (e) {
    console.log('[boot] 生成配置失败: ' + e.message);
  }
}
ensureConfig();

// ---------------- 启动前置校验：没口令就不启动 ----------------
// 安全底线：panel_password 同时是面板登录口令和 /v1/* 的 Bearer key，
// 为空（或还是模板里的 CHANGE_ME）就等于把网关对任何来源开放。
// 首次运行已由 ensureConfig() 自动生成随机口令，所以正常安装不会走到这里。
(function requirePassword() {
  const cfg = readConfigFile();
  const pwd = typeof cfg.panel_password === 'string' ? cfg.panel_password.trim() : '';
  const bad = !pwd || /^(change[_-]?me|password|123456)?$/i.test(pwd);
  if (!bad) {
    if (pwd.length < 8) {
      console.log('[SECURITY] ⚠ 面板口令只有 ' + pwd.length + ' 位，建议至少 8 位（面板与 /v1/* 共用它）');
    }
    return;
  }
  if (process.env.TRAE2API_ALLOW_NO_AUTH === '1') {
    console.log('[SECURITY] ⚠ 未设置 panel_password，但 TRAE2API_ALLOW_NO_AUTH=1：以无鉴权模式启动（仅限本机临时调试）');
    return;
  }
  console.error('');
  console.error('============ 启动中止：没有设置面板口令 ============');
  console.error('  data/config.json 里的 panel_password 为空或仍是模板占位值。');
  console.error('  它同时用于面板登录和 /v1/* 的 Bearer key，为空时网关对任何来源开放。');
  console.error('');
  console.error('  修法任选其一：');
  console.error('   1) 删掉 data/config.json 后重启：会自动生成随机口令并打印在日志里；');
  console.error('   2) 手动填：{"panel_password":"你的口令","api_key":"同一个口令"}');
  console.error('   3) 仅本机临时调试：先 set TRAE2API_ALLOW_NO_AUTH=1 再启动（会持续告警）');
  console.error('====================================================');
  process.exit(2);
})();

// ---------------- 请求日志（journal） ----------------
// 内存环形 + JSONL 落盘，供面板「请求日志 / 错误汇总」两个页签使用
const JOURNAL_FILE = path.join(__dirname, 'data', 'requests.jsonl');
const JOURNAL = [];
const JOURNAL_MAX = 500;

function loadJournal() {
  try {
    if (!fs.existsSync(JOURNAL_FILE)) return;
    const lines = fs.readFileSync(JOURNAL_FILE, 'utf8').split('\n').filter(Boolean);
    for (const line of lines.slice(-JOURNAL_MAX)) {
      try { JOURNAL.push(JSON.parse(line)); } catch {}
    }
  } catch {}
}

// 启动时把落盘的历史读回内存（以前这个函数定义了却从没被调用 → 每次重启面板日志都是空的）
loadJournal();

// 模型名解析：别名 → 目录精确匹配 → 未知则拒绝（附近似名）。
// 目录拉取失败时不再静默放行，而是打日志并（默认）拒绝，避免又一次「名字是 A、跑的是 B」。
async function checkModel(requested) {
  let catalog = [];
  let catalogObjs = [];
  let catalogErr = null;
  try {
    const list = await trae.listModels();
    catalogObjs = (list || []).filter((m) => m && m.name);
    catalog = catalogObjs.map((m) => m.name);
  } catch (e) {
    catalogErr = e.message;
    if (/RPC 超时|超时/.test(String(e.message))) healer.noteFailure('model_list');
  }
  const aliases = (trae.cfg && trae.cfg.model_aliases) || {};
  const strict = trae.cfg && trae.cfg.model_strict === false ? false : true;
  const r = resolveModel({ requested, catalog, aliases, displayNames: catalogObjs, strict });

  if (r.reason === 'alias') {
    log('[model] 别名 ' + requested + ' → ' + r.name);
    return { ok: true, name: r.name };
  }
  if (r.reason === 'display') {
    log('[model] 显示名 "' + requested + '" → ' + r.name + '（上游 slug 与显示名不同，属正常）');
    return { ok: true, name: r.name };
  }
  if (r.ok) return { ok: true, name: r.name };

  if (r.reason === 'catalog-empty') {
    log('[model] ⚠ 模型目录为空（' + (catalogErr || '上游未返回') + '），无法校验 ' + requested + '；已按 model_strict 处理');
    return {
      ok: false,
      detail: 'catalog-empty: ' + (catalogErr || 'empty'),
      message: '读不到模型目录（' + (catalogErr || '上游未返回列表') + '），暂时无法确认模型 ' + requested + ' 是否存在；请稍后重试，或在 data/config.json 设 "model_strict": false 跳过校验',
    };
  }

  const sug = r.suggestions.length ? r.suggestions : catalog.slice(0, 6);
  log('[model] 未知模型 ' + requested + '（目录 ' + catalog.length + ' 个）→ 拒绝；近似: ' + sug.join(', '));
  return {
    ok: false,
    detail: 'unknown: ' + requested + (sug.length ? ' ~ ' + sug.join('|') : ''),
    message: 'model not found: ' + requested + '（上游目录里没有这个名字；上游不会报错、会用默认模型代替，所以网关直接拦下）。'
      + (sug.length ? ' 近似可用: ' + sug.join(', ') : '')
      + '。当前目录共 ' + catalog.length + ' 个模型，可 GET /v1/models 查看；也可以在 data/config.json 的 model_aliases 里把自定义名映射到真实模型。',
  };
}

// 空结果的归因：只报证据，不猜。抽成纯函数便于单测。
//   status: 上游返回的状态（'error' / 'completed' / 'stream_end' / null…）
//   errMsg: 上游 error 的摘要（有则几乎可以确定是连接/会话层失败）
function diagnoseEmpty({ status, errMsg } = {}) {
  const base = '上游没有返回任何内容（既无正文也无 usage）';
  const tips = [];

  // ① 上游明确报错 → 不是空回答，是失败
  if (status === 'error' || errMsg) {
    tips.push(errMsg ? ('上游错误: ' + errMsg) : '上游返回 status=error');
    tips.push('多半是运行时/套接字问题：看日志里同时间的 [aha] 行，确认面板「IPC 连接」是否已连接');
    return {
      status: 'upstream_error',
      detail: errMsg || 'status=error',
      message: base + '，且上游返回了错误：' + (errMsg || 'status=error') +
        '。排查顺序：① 面板 IPC 是否「已连接」；② 日志里 [aha] RPC 失败/重连记录；' +
        '③ 运行时是否刚被重启（登录后会重启一次，约 15–20 秒）。',
    };
  }


  // ② 没有错误、就是空：给出更可能的三种原因（网关不再做 token 估算，见 README 4.0.55）
  tips.push('常见原因：① 运行时刚重启/通道未就绪（重试一次多半就好）');
  tips.push('② 该模型不在当前账号/租户的白名单里（换一个模型试试）');
  tips.push('③ 上游瞬时故障或输入过长（同 prompt 重试；确需处理长输入就先压缩上下文）');
  return {
    status: 'upstream_empty',
    detail: 'empty',
    message: base + '。' + tips.join('；') + '。',
  };
}

function recordRequest(rec) {
  const row = { ts: Date.now(), ...rec };
  JOURNAL.push(row);
  if (JOURNAL.length > JOURNAL_MAX) JOURNAL.shift();
  try {
    fs.appendFileSync(JOURNAL_FILE, JSON.stringify(row) + '\n');
    // 超过 5MB 滚成 .1，避免请求记录无限增长
    try {
      const st = fs.statSync(JOURNAL_FILE);
      if (st.size > 5 * 1024 * 1024) {
        const bak = JOURNAL_FILE + '.1';
        try { fs.unlinkSync(bak); } catch {}
        fs.renameSync(JOURNAL_FILE, bak);
      }
    } catch {}
  } catch {}
}
const LOG_FILE = path.join(__dirname, 'data', 'trae2api.log');
const LOG_MAX_BYTES = Number(process.env.TRAE2API_LOG_MAX_MB || 10) * 1024 * 1024;
let logWrites = 0;
// 日志轮转：单文件超过 LOG_MAX_BYTES（默认 10MB）滚成 .1（只留一份历史），避免无限增长
function rotateLogIfNeeded() {
  try {
    const st = fs.statSync(LOG_FILE);
    if (st.size < LOG_MAX_BYTES) return;
    const bak = LOG_FILE + '.1';
    try { fs.unlinkSync(bak); } catch {}
    fs.renameSync(LOG_FILE, bak);
  } catch (e) {
    if (!rotateLogIfNeeded.warned) { rotateLogIfNeeded.warned = true; console.log('[log] 轮转失败（只提示一次）: ' + (e && e.message)); }
  }
}
function log(...args) {
  const line = `[${new Date().toISOString()}] ` + args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
  LOG_RING.push(line);
  if (LOG_RING.length > 500) LOG_RING.shift();
  console.log(line);
  if (++logWrites % 200 === 0) rotateLogIfNeeded();
}
// 全局兜底：漏 catch 的异常不能把进程带走（在途请求会全断）；记日志后继续跑。
process.on('unhandledRejection', (e) => { try { log('[fatal] 未处理的 Promise 拒绝: ' + ((e && e.stack) || e)); } catch {} });
process.on('uncaughtException', (e) => { try { log('[fatal] 未捕获异常: ' + ((e && e.stack) || e)); } catch {} });

const { resolveModel } = require('./lib/models.cjs');
const { createHealer } = require('./lib/healer.cjs');
const creds = new Creds({ log });
const aha = new AhaClient({ log });
const trae = new TraeService({ aha, creds, log, projectIdKey: 'local_project_id' });
// 工作区目录必须真实存在：指向不存在的目录时，上游项目元数据会让对话直接返回空结果
// （2026-11-21 实测：workspace 不存在 → 每轮 1 帧 0 字；mkdir 后同样请求 24 帧 1884 字）
(function ensureWorkspace() {
  try {
    const ws = String(trae.cfg.workspace_folder || '').trim();
    if (!ws) return;
    if (!fs.existsSync(ws)) {
      fs.mkdirSync(ws, { recursive: true });
      console.log('[boot] 已创建工作区目录 ' + ws);
    }
  } catch (e) {
    console.log('[boot] 创建工作区目录失败: ' + e.message);
  }
})();

startRuntimeProbe();

// 启动时预热模型目录：冷启动一次 model_list 要 ~30 s，热了就 4 s 级
log('[boot] AHA 目录 = ' + (process.env.TRAE2API_AHA_DIR || '自动探测'));
attachments.cleanup();
setInterval(() => attachments.cleanup(), 3600e3).unref?.();
setTimeout(() => {
  trae.listModels().then((l) => log(`[boot] 模型目录预热完成：${l.length} 个`)).catch((e) => log('[boot] 预热失败: ' + e.message));

// 聊天链路预热：冷启动后第一个真实请求要 ~49 秒（agent 侧首次初始化），
// 用一次性极小请求把它焐热，避免用户的第一句话撞上冷启动。模型名必须真实存在。
// warmup_chat=false 可关掉这次真实 chat 预热（占住 agent 数十秒，实测 55.7s）。
// 注：曾怀疑它导致 ai-agent 被杀，已复查推翻（README 4.0.58）；现在改成「有真实请求就不预热」。
if (process.env.TRAE2API_WARMUP !== '0' && trae.cfg.warmup_chat !== false) {
  setTimeout(async () => {
    const t0 = Date.now();
    try {
    if (Number(trae.stats.requests) > 0) { log('[boot] 聊天预热跳过：启动后已有真实请求，链路已被焐热'); return; }
      const l = await trae.listModels(true);
      const m = trae.cfg.default_model || l[0]?.name;
      if (!m) { log('[boot] 聊天预热跳过：没有可用模型'); return; }
      await trae.chat({ model: m, prompt: '只回答：好', onThinking: () => {}, onContent: () => {}, onUsage: () => {} });
      log('[boot] 聊天链路预热完成 ' + (Date.now() - t0) + 'ms（模型 ' + m + '）');
    } catch (e) { log('[boot] 聊天预热失败: ' + e.message); }
  }, 500);
}
}, 500);




// ---------------- usage 规范化 ----------------
// 上游用的是 cache_read_input_tokens / reasoning_tokens（Trae 命名），
// 而 OpenAI 兼容客户端（含 DSH 的 pi-ai）只认 prompt_tokens_details.cached_tokens
// 与 completion_tokens_details.reasoning_tokens。两套都发，客户端能读、排查也方便。
// builder 模式实测会把平台自己执行工具的结果以 <result>…</result> 塞进正文，
// 对「模型只给调用、客户端自己执行」的语义是污染，这里剔除。
function stripToolResult(text) {
  if (!text || typeof text !== 'string') return text || '';
  return text
    .replace(/<result>[\s\S]*?<\/result>/gi, '')
    .replace(/<\/?result>/gi, '')
    .trim();
}

function toClientUsage(u) {
  if (!u) return { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  const cached = u.cache_read_input_tokens || u.prompt_tokens_details?.cached_tokens || 0;
  const reasoning = u.reasoning_tokens || u.completion_tokens_details?.reasoning_tokens || 0;
  return {
    ...u,                                    // 上游字段全量透传（含 input/output、max_tokens…）
    prompt_tokens: u.prompt_tokens || 0,
    completion_tokens: u.completion_tokens || 0,
    total_tokens: u.total_tokens || ((u.prompt_tokens || 0) + (u.completion_tokens || 0)),
    prompt_tokens_details: { cached_tokens: cached, cache_creation_tokens: u.cache_creation_input_tokens || 0 },
    completion_tokens_details: { reasoning_tokens: reasoning },
    reasoning_tokens: reasoning,
    cache_read_input_tokens: cached,
  };
}
// ---------------- 图片附件 ----------------
// 把 OpenAI 的 image_url 部件落盘，并把本地路径拼进文本：
// Trae agent 拿到路径后会自己上传到对象存储、过合规检查再喂给模型（含 OCR 级验证）。
async function attachImages(messages) {
  const out = [];
  for (const m of messages) {
    if (!m || typeof m !== 'object' || !Array.isArray(m.content)) { out.push(m); continue; }
    const paths = await attachments.extractImagePaths(m.content);
    if (!paths.length) { out.push(m); continue; }
    const texts = m.content
      .filter((c) => c && typeof c === 'object' && (c.type === 'text' || typeof c.text === 'string'))
      .map((c) => c.text || '');
    const lines = paths.map((p, i) => (p.startsWith('[') ? p : `[图片${i + 1}] 本地路径：${p} —— 请用你的读图能力查看这张图片`));
    out.push({ ...m, content: [...texts, '', ...lines].join('\n').trim(), __images: paths });
  }
  return out;
}
// ---------------- 工具 ----------------
function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}
function readBody(req, limit = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    req.on('data', c => { n += c.length; if (n > limit) { reject(new Error('body too large')); req.destroy(); return; } chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}
const sseHead = (res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
};
// 在途流式响应登记表：优雅停机时先把它们正常收尾（补 finish + [DONE]），
// 否则客户端会看到 "Stream ended without finish_reason" 这类传输层重试。
const activeStreams = new Set();
const DUMP_SSE = process.env.TRAE2API_DUMP_SSE === '1';
let lastChunkAt = Date.now();
const sendSse = (res, obj) => {
  lastChunkAt = Date.now();
  const body = typeof obj === 'string' ? obj : JSON.stringify(obj);
  if (DUMP_SSE) log('[sse-out] ' + body.slice(0, 300));
  res.write('data: ' + body + '\n\n');
};

// ---------------- OpenAI 兼容 ----------------
// 按模型算「上下文窗口 / 输入预算 / 输出上限」：配置里的三张覆盖表优先，其次上游 model_list 的声明值。
// 为什么要覆盖：上游对 11 个模型一律声明 116000，实测可容纳 1,048,576（README 4.0.67）；输出侧也一律声明 16000，
// 而 DeepSeek-V4-Pro 实测单轮已到 134,997（README 4.0.68）。集中在这里算，/v1/models 与 /api/status 共用同一份口径。
function modelCapacity(m) {
  return capacityOf(m, trae.cfg || {});   // 口径在 lib/caps.cjs（可单测）
}

async function handleModels(req, res) {
  try {
    const list = await trae.listModels(true);
    healer.noteSuccess();
    json(res, 200, {
      object: 'list',
      data: list.map(m => {
        const cap = modelCapacity(m);
        return {
          id: m.name, object: 'model', created: Math.floor(Date.now() / 1000), owned_by: 'trae',
          display_name: m.display_name, multimodal: !!m.multimodal, is_beta: !!m.is_beta,
          // 上游 model_list 给的 116000 是它的预算口径；实测真实上限 1,048,576（见 README），
          // 这里按模型覆盖，避免客户端点「获取可用模型」时把窗口冲回 116k。
          context_window: cap.context_window,
          prompt_max_tokens: cap.prompt_max_tokens,
          max_turns: m.max_turns?.default ?? m.max_turns ?? null,
          max_tokens: cap.max_tokens,
          // 备注：标注值可能低于真实上限时说明一下（客户端可展示，缺省不输出）
          ...(cap.max_tokens_note ? { max_tokens_note: cap.max_tokens_note } : {}),
          // 兼容别名：不同客户端认不同字段名（DSH 读 context_window/context_length/max_tokens/max_output_tokens，
          // Cline/Roo 读 context_length，LiteLLM 风格读 max_input_tokens/limit.*）。多给几份，省得各自解析不到退回默认值。
          ...modelAliasFields(cap),
        };
      }),
    });
  } catch (e) {
    if (/RPC 超时|超时/.test(String(e.message))) healer.noteFailure('model_list');
    json(res, 500, { error: { message: e.message, type: 'upstream_error' } });
  }
}

// /v1 限流：rate_limit_per_min 按 key（Bearer 或客户端 IP），max_concurrent 是全局在飞上限。
// 两者默认 0 = 不限制（保持旧行为）；生产在 data/config.json 里显式开启。
let v1Limiter = null;
function v1LimiterOf() {
  const perMin = Math.max(0, Number(trae.cfg.rate_limit_per_min) || 0);
  const maxConcurrent = Math.max(0, Number(trae.cfg.max_concurrent) || 0);
  if (!v1Limiter || v1Limiter.config.perMin !== perMin || v1Limiter.config.maxConcurrent !== maxConcurrent) {
    v1Limiter = createLimiter({ perMin, maxConcurrent });
  }
  return v1Limiter;
}
async function handleChat(req, res) {
  // 限流闸门：超限直接 429（带 Retry-After），并记一笔审计
  const limiter = v1LimiterOf();
  const authKey = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const limKey = authKey || (req.socket.remoteAddress || '?');
  const lim = limiter.acquire(limKey);
  if (!lim.ok) {
    const sec = Math.max(1, Math.ceil((lim.retryAfterMs || 1000) / 1000));
    log('[ratelimit] ' + (lim.reason === 'concurrency' ? '并发已满' : '每分钟请求数超限') + '，key=' + String(limKey).slice(0, 8) + '***');
    res.setHeader('Retry-After', String(sec));
    recordRequest({ kind: 'json', model: '-', status: 'error', ms: 0, tools: 0, callNames: [], error: 'ratelimit:' + lim.reason });
    return json(res, 429, { error: { message: '请求过于频繁（' + lim.reason + '），请 ' + sec + ' 秒后重试', type: 'rate_limit' } });
  }
  inflightChats += 1;
  try {
    return await handleChatInner(req, res);
  } finally {
    inflightChats -= 1;
    limiter.release();
  }
}

async function handleChatInner(req, res) {
  let body;
  try { body = await readBody(req); } catch (e) { return json(res, 400, { error: { message: 'invalid json: ' + e.message } }); }
  let model = body.model || 'Doubao-Seed-Code';
  // 模型名校验：上游对未知模型名不报错，而是用账号默认模型回答（静默替换），
  // 所以必须在这里拦住：先查别名表，再对目录做精确匹配，未知则 404 并给出近似名。
  if (body.model) {
    const r = await checkModel(model);
    if (!r.ok) {
      trae.stats.fail++;
      recordRequest({ kind: 'json', model, status: 'error', ms: 0, tools: 0, callNames: [], error: r.message, statusDetail: r.detail });
      return json(res, 404, { error: { message: r.message, type: 'invalid_request_error', code: 'model_not_found' } });
    }
    model = r.name;
  }
  const stream = !!body.stream;
  const tools = Array.isArray(body.tools) ? body.tools.filter(t => (t.function || t).name) : [];
  const toolChoice = body.tool_choice;
  const useTools = tools.length > 0 && toolChoice !== 'none';
  // 工具块渲染参数：native_ban / tool_schema_depth / tool_block_budget（都在 data/config.json）
  let nativeBan = true, schemaDepth, blockBudget;
  try {
    const c = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'config.json'), 'utf8'));
    if (c.native_ban === false) nativeBan = false;
    if (Number.isFinite(Number(c.tool_schema_depth))) schemaDepth = Number(c.tool_schema_depth);
    if (Number.isFinite(Number(c.tool_block_budget))) blockBudget = Number(c.tool_block_budget);
  } catch (e) {
    // 读配置失败不该阻断请求（用默认值继续），但要留痕：以前这里彻底静默，配置坏了完全看不出来
    log('[config] 读取工具块参数失败，按默认值继续: ' + (e && e.message));
  }
  const blockReport = {};
  // 工作区校验（只校验、不改行为）：客户端若声明了一个不存在的工作目录，直接告诉它，
  // 而不是把假路径发给上游换回一个空结果/莫名的项目错误（实测 create_chat_session 会报 992501）。
  // workspace_check: "error"（默认，HTTP 400 明确报错）| "warn"（放行 + 响应头 + 日志）| "off"
  const wsCheckMode = String(trae.cfg.workspace_check || 'error').toLowerCase();
  if (wsCheckMode !== 'off') {
    try {
      const declared = WD.extractDeclared(body.messages, { scope: trae.cfg.workspace_declare_scope === 'system' ? 'system' : 'all' });
      if (declared) {
        const chk = WSC.checkWorkspace(declared, { requireWritable: trae.cfg.workspace_check_writable === true });
        res.setHeader('x-trae-workspace-check', chk.kind);
        if (!chk.ok) {
          const msg = WSC.describe(chk);
          log('[ws-check] ' + chk.kind + ': ' + declared + '（action=' + wsCheckMode + '）');
          if (wsCheckMode === 'error') {
            trae.stats.fail++;
            return json(res, 400, { error: { message: msg, type: 'invalid_workspace', code: 'workspace_' + chk.kind.replace(/-/g, '_'), workspace: declared } });
          }
        }
      }
    } catch (e) { log('[ws-check] 校验异常: ' + e.message); }
  }
  // 工作区归属（只写提示词，不改请求参数）：仿照 CALL 禁令的写法，把"锚点不是工作目录"讲死。
  // 开关 workspace_notice（默认开）。实测：路径名里写指令无效，提示词段落有效。
  let wsNotice = '';
  if (trae.cfg.workspace_notice !== false) {
    const anchor = String(trae.cfg.workspace_folder || '').trim();
    // 2026-11-24：不再按「是否识别到声明」分支（用户要求去掉兜底，怕误识别）。
    // 提示词只说明「网关目录无效、以调用方声明为准」，不再决定用哪个目录、也不反问。
    wsNotice = WSN.buildNotice({ anchor });
  }
  const toolInstr = useTools
    ? buildToolInstruction(tools, toolChoice, { nativeBan, depth: schemaDepth, budget: blockBudget, report: blockReport, style: trae.cfg.instruction_style || 'aligned' })
    : '';
  const extraSystem = [wsNotice, toolInstr].filter(Boolean).join('\n\n');
  // 工具名守卫：把「模型写的名字」对齐到「本次请求声明的名字」（完全相等 / 忽略大小写与下划线 / tool_aliases）
  const declaredToolNames = (tools || []).map((t) => (t && t.function && t.function.name) || (t && t.name) || "").filter(Boolean);
  const toolAliases = (trae.cfg && trae.cfg.tool_aliases) || {};
  const undeclaredMode = String((trae.cfg && trae.cfg.undeclared_tool_mode) || "feedback").toLowerCase();
  const undeclaredRetriesMax = Math.max(0, Number((trae.cfg && trae.cfg.undeclared_tool_retries) ?? 1) || 0);
  if (useTools) {
    trae.stats.lastToolBlock = blockReport;   // 供 /api/status 观察：full/signature + 字符数
    log(`[tools] ${blockReport.toolCount} 个工具 → ${blockReport.mode} ${blockReport.chars} 字符（depth=${blockReport.depth}）`);
  }
  // 图片：OpenAI 的 image_url 部件先落盘，再把本地路径写进提示词（agent 自带读图/上传能力）
  let messagesForPrompt = body.messages;
  if (trae.cfg.image_passthrough !== false) {
    try {
      const before = JSON.stringify(body.messages || []).length;
      messagesForPrompt = await attachImages(body.messages || []);
      const paths = [];
      for (const m of messagesForPrompt) for (const p of m.__images || []) paths.push(p);
      if (paths.length) log(`[image] ${paths.length} 张图已落盘: ${paths.map(p => p.split('/').pop()).join(', ')}（输入 ${before} 字节）`);
    } catch (e) {
      if (e && e.code === 'AGENT_OFFLINE') {
        const msg = '上游 AI agent 未运行（本地 Trae 扩展/独立 agent 都没有响应握手）：' + e.message;
        log('[agent-offline] ' + msg);
        recordRequest({ kind: stream ? 'stream' : 'json', model, status: 'agent_offline', ms: Date.now() - t0, tools: tools.length, callNames: [], error: msg });
        if (stream) { stopHeartbeat(); sendSse(res, { error: { message: msg, type: 'agent_offline' } }); sendSse(res, '[DONE]'); res.end(); }
        else json(res, 503, { error: { message: msg, type: 'agent_offline', code: 'agent_offline' } });
        return;
      }
      log('[image] 处理失败，按纯文本继续: ' + e.message);
      messagesForPrompt = body.messages;
    }
  }
  // 没声明工作区时，把一句提醒贴到末条用户消息前（贴着问题的指令更有效）
  // （末尾提醒已移除：实测只要开头那段说明就够，避免往用户消息里塞内容）
  // 思考回填（用户要求按正常 agent 行为：把历史各轮的思考一并带给上游）
  //   reasoning_context: 'off' | 'last' | 'all'（默认 all）
  //   reasoning_context_max_chars: 单轮截断（默认 0 = 不限）
  //   reasoning_context_total_max_chars: 思考总量上限（默认 0 = 不限）
  const rznMode = String(trae.cfg.reasoning_context || 'all').toLowerCase();
  let prompt = TraeService.flattenMessages(messagesForPrompt, extraSystem, {
    includeReasoning: ['off', 'last', 'all'].includes(rznMode) ? rznMode : 'all',
    reasoningMaxChars: Number(trae.cfg.reasoning_context_max_chars || 0),
    reasoningTotalMaxChars: Number(trae.cfg.reasoning_context_total_max_chars || 0),
  });
  if (rznMode !== 'off') {
    const inChars = (Array.isArray(messagesForPrompt) ? messagesForPrompt : [])
      .filter(m => m && m.role === 'assistant')
      .reduce((a, m) => a + String(m.reasoning_content || m.reasoning || '').length, 0);
    log('[rzn] 模式=' + rznMode + ' 历史思考字符=' + inChars + ' prompt字符=' + prompt.length);
  }
  // 末尾再贴一句工作区提醒（workspace_notice_tail，默认开）：拼在 prompt 最后，不动客户端消息，
  // 并明确「只用于自我约束，不要写进回答正文」，避免它被复述到用户可见的答案里。
  if (trae.cfg.workspace_notice !== false && trae.cfg.workspace_notice_tail !== false) {
    try {
      const wsTail = WSN.buildTailNotice();
      if (wsTail) prompt = prompt + '\n\n' + wsTail;
    } catch (e) { log('[ws-notice] 末尾提醒失败: ' + e.message); }
  }
  if (!prompt.trim()) return json(res, 400, { error: { message: 'messages 为空' } });

  const id = 'chatcmpl-' + crypto.randomUUID().replace(/-/g, '').slice(0, 24);
  const created = Math.floor(Date.now() / 1000);
  trae.stats.requests++;
  const t0 = Date.now();

  /** 跑一次模型，收集 thinking/content/usage */
  // 实测（2026-11-20）：builder 模式的平台提示词没有 "Chat Mode - Read-Only" 那条与 CALL 协议冲突的约束，
  // 同一重任务下思考量从 ~51,000 字符降到 ~15,000（3.4×）、耗时 274s → 68s，且 CALL 协议行为完全一致。
  const agentType = body.agent_type || trae.cfg.default_agent_type || 'chat';
  // project_id 与具体 agent 通道（扩展 / 独立）绑定：换通道后旧 id 会 "Project not found"，
  // 因此记录它是哪个通道申请的，不一致就清空让 ensureProjectId 重新申请。
  {
    const chanTag = 'extension';   // 只有 extension 一条通道（自包含运行时由 aiserver 拉起 ai-agent）
    if (trae.cfg.local_project_id && trae.cfg.local_project_id_tag !== chanTag) {
      log('[project] 通道切换为 ' + chanTag + '，清空旧 project_id ' + trae.cfg.local_project_id);
      trae.cfg.local_project_id = '';
      trae.cfg.local_project_id_tag = chanTag;
      require('./lib/trae.cjs').saveConfig(trae.cfg);
    } else if (!trae.cfg.local_project_id_tag) {
      trae.cfg.local_project_id_tag = chanTag;
    }
  }
  const agentId = body.agent_id || (agentType === 'builder' ? 'builder' : 'chat');

  // 真流式：思考与正文都边到边发。
  // 正文要先缓冲几个字符判断是不是 CALL 工具调用行（是则不流，留给 tool_calls 通道）。
  let headSent = false, pending = '', streaming = false, toolMode = false;
let earlyCall = null;   // 检测到 CALL 行后立刻公告的工具调用（name 先到，arguments 流尾补齐）
  const HOLD = 12;
  let holdBuf = '';
  let sseStarted = false;
  let heartbeat = null;
  const startHeartbeat = () => {
  if (heartbeat) return;
  // 每 1s 检查一次：超过 stream_keepalive_ms（默认 20s）没有任何数据帧，就发一个空 delta 帧。
  // 为什么不是只发 ': ping'：pi-ai 的 idle watchdog 只在解析到 chunk 时重置，SSE 注释不计入，
  // 于是 CALL 参数生成期（会把正文丢弃）或长思考期一超过客户端阈值（默认 300000ms）就报
  // 'pi-ai stream idle timeout'。空 delta 是合法 chunk，客户端会忽略内容但会重置 watchdog。
  let pingTick = 0;
  heartbeat = setInterval(() => {
    try {
      pingTick += 1;
      const ka = Number(trae.cfg.stream_keepalive_ms ?? 20000);
      if (shouldKeepalive(lastChunkAt, Date.now(), ka)) {
        sendSse(res, { id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: {}, finish_reason: null }] });
      } else if (shouldPing(pingTick, 15) && Date.now() - lastChunkAt >= 14000) {
        res.write(': ping\n\n');
      }
    } catch {}
  }, 1000);
};
  const stopHeartbeat = () => { if (heartbeat) { clearInterval(heartbeat); heartbeat = null; } };
  const beginSse = () => {
    if (sseStarted) return;
    sseStarted = true;
    res._traeModel = model;
    activeStreams.add(res);
    res.on('close', () => activeStreams.delete(res));
    sseHead(res);
    startHeartbeat();
  };
  const ensureHead = () => {
    if (headSent) return;
    beginSse();
    sendSse(res, { id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] });
    headSent = true;
  };
  const resetEmitter = () => { pending = ''; holdBuf = ''; streaming = false; toolMode = false; earlyCall = null; };
  const emit = stream ? {
    thinking: (d) => {
      ensureHead();
      sendSse(res, { id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { reasoning_content: d }, finish_reason: null }] });
    },
    content: (d) => {
      if (toolMode) return;
      // 没有声明工具时不需要判断 CALL 行，直接流（零缓冲）
      if (!useTools) {
        ensureHead();
        sendSse(res, { id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { content: d }, finish_reason: null }] });
        return;
      }
      // 关键：CALL 行可能出现在正文中间（模型先写一段前言再调工具）。
      // 因此始终保留尾部 HOLD 个字符，一边扫 "行首 CALL" 标记，一边把安全部分吐出去。
      holdBuf += d;
      const m = holdBuf.search(/(^|\n)[ \t]*CALL[\s{("']/i);
      if (m >= 0) {
        const upto = m === 0 ? 0 : m + (holdBuf[m] === '\n' ? 1 : 0);
        const head = holdBuf.slice(0, m);
        if (head.trim()) { streaming = true; ensureHead(); sendSse(res, { id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { content: head }, finish_reason: null }] }); }
        // 2026-11-24：检测到 CALL 行就立刻公告工具名。此前要等整段 JSON 参数生成完（实测静默 12.9s）
        // 才发 tool_calls，客户端这段时间零输出，表现为「流卡住」。先发 name（arguments 空），流尾再补参数。
        try {
          const nm = (holdBuf.slice(m).match(/CALL[ \t]*([A-Za-z0-9_.\-]+)/i) || [])[1];
          if (nm) {
            // 只对「本次请求声明过」的名字发早公告：否则客户端会先收到一个非法工具名，
            // 回灌重试后拿不到对应 id，客户端把两轮拼在一起。passthrough 模式保持旧行为。
            const resolvedEarly = resolveToolName(nm, declaredToolNames, toolAliases);
            if (!resolvedEarly && undeclaredMode !== "passthrough") {
              log("[toolcall] 早公告跳过：未在本次请求声明里 → " + nm + "（稍后回灌给上游）");
            } else {
            earlyCall = { id: 'call_' + Math.random().toString(36).slice(2, 10), name: resolvedEarly || nm, index: 0 };
            ensureHead();
            sendSse(res, { id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: earlyCall.id, type: 'function', function: { name: resolvedEarly || nm, arguments: '' } }] }, finish_reason: null }], usage: null });
            log('[toolcall] 早公告 ' + (resolvedEarly || nm) + '（' + (Date.now() - t0) + 'ms）');
            }
          }
        } catch {}
        toolMode = true;
        holdBuf = '';
        return;
      }
      if (holdBuf.length > HOLD) {
        const out = holdBuf.slice(0, holdBuf.length - HOLD);
        holdBuf = holdBuf.slice(-HOLD);
        streaming = true;
        ensureHead();
        sendSse(res, { id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { content: out }, finish_reason: null }] });
      }
    },
    flush: () => {
      // 收尾时把还在缓冲里的安全尾巴吐出去（工具模式则丢弃）
      if (toolMode || !useTools || !holdBuf) return;
      const out = holdBuf; holdBuf = '';
      if (!out) return;
      streaming = true; ensureHead();
      sendSse(res, { id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { content: out }, finish_reason: null }] });
    },
  } : null;

  // 客户端断开就中止上游：否则它会把这一轮生成完（长思考/长输出能烧几分钟并占账号池）
  let clientGone = false;
  let currentAbort = null;
  res.on('close', () => {
    if (res.writableEnded) return;
    clientGone = true;
    try { currentAbort?.abort(new Error('client gone')); } catch {}
    log('[client-gone] 客户端提前断开，已中止上游生成');
  });
  if (stream) beginSse();   // 立刻开 SSE + 心跳，长生成期间也保持连接活着

  // 思考预算看门狗：实测上游单轮输出硬上限是 16,000 tokens，而模型在"工具结果很多"的续跑里
  // 会把整份预算烧在思考上（reasoning 15,900+ 后直接结束，一个字正文都没有）。
  // 一旦思考字符数超过阈值且还没产出任何正文/调用，就主动掐断并用纠偏提示重试一次。
  // 客户端可以用 max_tokens 声明本轮的输出预算（上游没有这个参数，但我们可以拿它当"思考预算的上界"）：
  // 阈值 = min(配置值, max_tokens × 2)，避免客户端只要 2k 输出时仍允许思考 1 万 tokens。
  const clientMaxTokens = Number(body?.max_tokens ?? body?.max_completion_tokens ?? 0);
  // 0 或未配置 = 关闭（当前默认关闭，按用户要求"先不改掐断重试"）
  const REASONING_ABORT_CONFIG = Number(trae.cfg.reasoning_abort_chars ?? 0);
  const REASONING_ABORT_CHARS = !(REASONING_ABORT_CONFIG > 0)
    ? 0
    : (clientMaxTokens > 0
        ? Math.min(REASONING_ABORT_CONFIG, Math.max(4000, clientMaxTokens * 2))
        : REASONING_ABORT_CONFIG);
  const runOnce = async (p, opts = {}) => {
    let content = '', reason = '', usage = null, status = null, abortedForReasoning = false;
    const ac = new AbortController();
    currentAbort = ac;   // 供 res.close 中止
    const rr = await trae.chat({
      model, prompt: p,
      agentType,
      agentId,
      signal: ac.signal,
      onThinking: (d) => {
        reason += d;
        if (emit) emit.thinking(d);
        if (!opts.noAbort && REASONING_ABORT_CHARS > 0 && !content && reason.length > REASONING_ABORT_CHARS && !abortedForReasoning) {
          abortedForReasoning = true;
          log('[reasoning-abort] 思考已达 ' + reason.length + ' 字符仍未产出正文，掐断并重试');
          try { ac.abort(new Error('reasoning budget exceeded')); } catch {}
        }
      },
      onContent: (d) => { content += d; if (emit) emit.content(d); },
      onUsage: (u) => { usage = u; },
    }).catch((e) => ({ status: clientGone ? 'client_gone' : (abortedForReasoning ? 'reasoning_aborted' : 'error'), error: e }));
    status = rr?.status || null;
    // 保留上游 error 的摘要，空结果守卫要靠它区分「连接/会话错误」与「真·空回答」
    const errMsg = rr?.error
      ? String(rr.error.message || (rr.error.data && JSON.stringify(rr.error.data)) || JSON.stringify(rr.error)).slice(0, 240)
      : null;
    return { content, reason, usage, status, abortedForReasoning, errMsg };
  };

  try {
    let out = await runOnce(prompt);
    if (clientGone) {
      trae.stats.clientGone = (trae.stats.clientGone || 0) + 1;
      log('[client-gone] 首轮期间客户端已断开，放弃本次请求（上游已中止）');
      recordRequest({ kind: stream ? 'stream' : 'json', model, status: 'client_gone', ms: Date.now() - t0, tools: tools.length, blockMode: blockReport.mode || null, blockChars: blockReport.chars || null, promptTokens: out.usage?.prompt_tokens ?? null, completionTokens: out.usage?.completion_tokens ?? null, reasoningTokens: out.usage?.reasoning_tokens ?? null, cachedTokens: out.usage?.cache_read_input_tokens ?? null, finishReason: 'client_gone', callNames: [] });
      return;
    }

    // 思考预算超限被掐断 → 用强纠偏提示重试一次（禁止长篇思考，直接产出）
    if (out.abortedForReasoning && !clientGone) {
      trae.stats.reasoningAborts = (trae.stats.reasoningAborts || 0) + 1;
      resetEmitter();
      const forced = prompt + '\n\n【系统指令（高优先级）】上一次尝试把输出预算全部耗在内部思考上，用户什么都没收到。' +
        '这一次必须立刻产出结果：要么一行 CALL <工具名> <参数JSON>，要么一段可见正文。' +
        '严禁长篇推理，禁止复述本提示，思考不超过 200 字。';
      const retryOut = await runOnce(forced, { noAbort: true });
      if ((retryOut.content || '').trim()) { out = retryOut; }
      else if (out.content && !(retryOut.content || '').trim()) { /* 保留首次结果 */ }
      else { out = retryOut; }
    }

    // 解析工具调用；tool_choice=required 且解析失败时纠偏重试一次
    let parsed = { calls: [], content: (out.content || '').trim(), strict: false };
    if (useTools) {
      parsed = parseCalls(out.content);
      const needCall = toolChoice === 'required' || toolChoice === 'any' || (typeof toolChoice === 'object' && toolChoice?.function?.name);
      if (!parsed.calls.length && needCall && !clientGone) {
        const corrective = prompt + '\n\n【纠偏】上一次回答没有按格式输出 CALL。请只输出一行：CALL <工具名> <参数JSON>，不要输出其他内容。';
        resetEmitter();
        out = await runOnce(corrective);
        parsed = parseCalls(out.content);
        trae.stats.toolRetries = (trae.stats.toolRetries || 0) + 1;
      }
      // ---- 工具名守卫：挑出非法名字，按 undeclared_tool_mode 处置（默认回灌给上游让它自己改） ----
      let undeclared = [];
      if (parsed.calls.length) {
        const part0 = partitionCalls(parsed.calls, declaredToolNames, toolAliases);
        parsed.calls = part0.ok;
        undeclared = part0.illegal.map((x) => x.name).filter(Boolean);
        if (undeclared.length) {
          trae.stats.undeclaredCalls = (trae.stats.undeclaredCalls || 0) + 1;
          log("[toolcall] 未声明工具名: " + undeclared.join(",") + "（声明: " + declaredToolNames.join(",") + "，模式 " + undeclaredMode + "）");
          if (undeclaredMode === "feedback" && undeclaredRetriesMax > 0 && !earlyCall && !clientGone) {
            // 回灌：告诉上游「这个名字不在已声明列表里」（工具说明本来就在 prompt 里，不再复述清单）
            resetEmitter();
            const fbOut = await runOnce(prompt + "\n" + feedbackHint(undeclared));
            trae.stats.undeclaredRetries = (trae.stats.undeclaredRetries || 0) + 1;
            const fbParsed = parseCalls(fbOut.content);
            const part1 = partitionCalls(fbParsed.calls, declaredToolNames, toolAliases);
            if (part1.ok.length) {
              out = fbOut;
              parsed = { calls: part1.ok, content: fbParsed.content, strict: fbParsed.strict };
              undeclared = part1.illegal.map((x) => x.name).filter(Boolean);
              trae.stats.undeclaredFixed = (trae.stats.undeclaredFixed || 0) + 1;
              log("[toolcall] 回灌后改正: " + parsed.calls.map((c) => c.name).join(","));
            } else {
              out = fbOut;
              const allBad = undeclared.concat(part1.illegal.map((x) => x.name)).filter(Boolean);
              parsed = { calls: [], content: stripIllegalCalls(fbOut.content || "", allBad), strict: false };
              undeclared = allBad;
              log("[toolcall] 回灌后仍无合法调用，已剔除非法 CALL 按正文返回");
            }
          }
          if (!parsed.calls.length && undeclaredMode !== "passthrough") {
            parsed.content = stripIllegalCalls(parsed.content || out.content || "", undeclared);
          }
        }
      }
      parsed.undeclared = undeclared;
      if (parsed.calls.length) trae.stats.toolCalls = (trae.stats.toolCalls || 0) + 1;
      else if (needCall) trae.stats.toolMisses = (trae.stats.toolMisses || 0) + 1;
    }

    // 超时守卫：空闲看门狗（默认 10 分钟无任何上游事件）或绝对上限触发时，
    // 已收到的那点内容是残缺的，必须报错而不是当成正常回答。
    if (out.status === 'idle_timeout' || out.status === 'timeout') {
      const msg = out.status === 'idle_timeout'
        ? '上游连续无输出已超过看门狗阈值，连接已断开（TRAE2API_IDLE_TIMEOUT_MS 可调，默认 600000ms=10分钟）'
        : '上游达到绝对时长上限被强制结束（TRAE2API_REQUEST_TIMEOUT_MS）';
      log('[timeout] ' + msg + '，已收内容 ' + (out.content || '').length + ' 字符');
      trae.stats.fail++;
      recordRequest({
        kind: stream ? 'stream' : 'json', model, status: out.status,
        ms: Date.now() - t0, tools: tools.length, blockMode: blockReport.mode || null,
        blockChars: blockReport.chars || null, promptTokens: out.usage?.prompt_tokens ?? null,
        completionTokens: out.usage?.completion_tokens ?? null, reasoningTokens: out.usage?.reasoning_tokens ?? null,
        cachedTokens: out.usage?.cache_read_input_tokens ?? null, 
        finishReason: out.status, callNames: [],
      });
      if (stream) { stopHeartbeat(); sendSse(res, { error: { message: msg, type: 'upstream_timeout' } }); sendSse(res, '[DONE]'); res.end(); }
      else json(res, 504, { error: { message: msg, type: 'upstream_timeout' } });
      return;
    }

    // 空结果守卫：必须显式报错，否则客户端会把"什么都没有"当成正常空回答。
    // 但**不能一律归因于输入超限** —— 实测上游在「连接/会话出错」「模型无权限」「瞬时故障」时
    // 同样是空内容 + usage 全 0。这里按证据分级给出原因与排查顺序。
    const emptyAll = !(out.content || "").trim() && !(out.reason || "").trim() && !(out.usage?.prompt_tokens > 0);
    if (emptyAll) {
      const diag = diagnoseEmpty({ status: out.status, errMsg: out.errMsg });
      log('[empty] ' + diag.message + ' 上游状态=' + (out.status || 'null'));
      trae.stats.fail++;
      recordRequest({
        kind: stream ? 'stream' : 'json', model, status: diag.status,
        ms: Date.now() - t0, tools: tools.length, blockMode: blockReport.mode || null,
        blockChars: blockReport.chars || null, promptTokens: null, completionTokens: null,
        reasoningTokens: null, cachedTokens: null, 
        finishReason: diag.status, callNames: [], statusDetail: diag.detail,
      });
      if (stream) { stopHeartbeat(); sendSse(res, { error: { message: diag.message, type: diag.status } }); sendSse(res, '[DONE]'); res.end(); }
      else json(res, 502, { error: { message: diag.message, type: diag.status } });
      return;
    }

    // DSH 的上下文压缩请求：prompt 里带 compaction engine 指令（compaction-basic 的 COMPACTION_INSTRUCTION）。
  // 这类请求带 tools，模型可能把摘要写成 CALL，或被截断守卫误判 → 单独放行，按文本返回。
  const isCompactionReq = /compaction engine|<compacted-summary>/i.test(prompt);
  if (isCompactionReq) log('[compaction] 识别为摘要请求（跳过截断守卫，按文本返回）');
  // 截断守卫：模型输出在 CALL 的参数 JSON 里被切断（常见于长文件生成撞上超时上限），
    // 这时既解析不出工具调用、正文又是一段半截 JSON，绝不能当普通文本回给客户端。
    if (useTools && !parsed.calls.length && hasUnterminatedCall(out.content || '') && !isCompactionReq) {
      const msg = '上游回答在 CALL 参数内被截断（生成过长触发超时或上游中断），请重试或减少单次输出量';
      log('[truncated] ' + msg + ' (content ' + (out.content || '').length + ' 字符)');
      trae.stats.fail++;
      recordRequest({
        kind: stream ? 'stream' : 'json', model, status: 'truncated_call',
        ms: Date.now() - t0, tools: tools.length, blockMode: blockReport.mode || null,
        blockChars: blockReport.chars || null, promptTokens: out.usage?.prompt_tokens ?? null,
        completionTokens: out.usage?.completion_tokens ?? null, reasoningTokens: out.usage?.reasoning_tokens ?? null,
        cachedTokens: out.usage?.cache_read_input_tokens ?? null,
        finishReason: 'truncated_call', callNames: [],
      });
      if (stream) {
        stopHeartbeat();
        sendSse(res, { error: { message: msg, type: 'upstream_truncated' } });
        sendSse(res, '[DONE]');
        res.end();
      } else {
        json(res, 502, { error: { message: msg, type: 'upstream_truncated' } });
      }
      return;
    }

    // 只出思考、无正文无调用：**不再返回 502**。
    // 返回 5xx 会触发客户端"原样重试同一条请求"，模型很可能再做一次同样的长思考再失败（实测 5 连败）；
    // 而返回 200 + 空内容会让客户端走"续跑"路径，附上"上一轮只输出了内部推理，请给出可见回复或工具调用"这类
    // 针对性提示，实测能把它救回来。这里只做记录，便于统计发生率。
    const onlyThinking = !parsed.calls.length && !(parsed.content || '').trim() && !(out.content || '').trim();
    if (onlyThinking) {
      log('[empty-content] 只出思考无正文/无调用（reasoning ' + (out.reason || '').length + ' 字符），返回空内容交给客户端续跑');
      trae.stats.emptyContent = (trae.stats.emptyContent || 0) + 1;
    }

    const hasCalls = parsed.calls.length > 0;
    const toolCalls = hasCalls ? toOpenAIToolCalls(parsed, id) : null;
    const contentText = stripToolResult(hasCalls ? (parsed.content || '') : (out.content || ''));
    const usage = out.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  // 输出上限判定：上游 model_list 里每个模型声明 max_tokens（实测多为 16000，Pro 能到 43k），
  // 打满这个数就是被截断，必须把 finish_reason 标成 length，否则客户端会当成正常结束。
  const modelCap = Number((trae.cfg.max_tokens_override || {})[model] ?? ((trae.modelsCache && trae.modelsCache.list) || []).find((m) => m && m.name === model)?.max_tokens ?? trae.cfg.model_max_tokens ?? 16000);
  // 只有「恰好打到声明值」才算截断：DeepSeek-V4-Pro 实测能到 43,049，用 >= 会把它误标成 length。
  const capHit = computeCapHit(usage, modelCap);
  if (capHit) log('[cap] ' + model + ' completion=' + usage.completion_tokens + ' 达到声明上限 ' + modelCap + '，标记 length');

    if (usage) { trae.stats.promptTokens += usage.prompt_tokens || 0; trae.stats.completionTokens += usage.completion_tokens || 0; trae.stats.cachedTokens += usage.cache_read_input_tokens || 0; }

    if (stream) {
      ensureHead();
      if (emit && emit.flush) emit.flush();
      // 思考与正文已在生成过程中流式发出；这里只补未流出去的部分（工具调用模式 / 缓冲未定）
      if (!streaming && !toolMode && out.reason && !headSent) {
        sendSse(res, { id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { reasoning_content: out.reason }, finish_reason: null }] });
      }
      if (hasCalls) {
        // 顺序按 OpenAI 惯例：先正文，再 tool_calls；并且 arguments 分片发出（每片 800 字符）——
        // 一次性塞整段 arguments 是之前 DSH 侧收不到调用的可疑原因（20:32:31 的抓包证实我们发过、DSH 没记）。
        if (contentText && !streaming) {
          sendSse(res, { id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { content: contentText }, finish_reason: null }] });
        }
        // 工具调用一律「一帧发完」（含 id/name/完整 arguments）。
        // 教训：曾按 800 字符分片发送，结果客户端丢一个分片就拼出半截 JSON，
        // 报 "Unexpected token ..." 并可能把会话写坏；整帧丢失只会表现为"没有工具调用"，可安全重试。
        for (let i = 0; i < toolCalls.length; i++) {
          const c = toolCalls[i];
          const reuse = earlyCall && i === 0 && String(c.function.name) === earlyCall.name;
          if (reuse) c.id = earlyCall.id;   // 与早公告同 id，客户端按 id 归并
          let argsStr = String(c.function.arguments ?? '');
          try { JSON.parse(argsStr); } catch (e) {
            log('[toolcall] arguments 不是合法 JSON（' + String(e.message).slice(0, 60) + '），改用重序列化结果');
            argsStr = JSON.stringify(c.parsed ?? {});
          }
          sendSse(res, { id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { tool_calls: [{ index: i, id: c.id, type: 'function', function: (reuse ? { arguments: argsStr } : { name: c.function.name, arguments: argsStr }) }] }, finish_reason: null }] });
        }
        await new Promise((r) => setTimeout(r, 10));   // 给客户端一点消化时间，再发 finish
        sendSse(res, { id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: toClientUsage(usage) });
      } else {
        if (contentText && !streaming) {
          sendSse(res, { id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { content: contentText }, finish_reason: null }] });
        }
        sendSse(res, { id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: {}, finish_reason: (capHit ? 'length' : 'stop') }], usage: toClientUsage(usage) });
      }
      stopHeartbeat();
      sendSse(res, '[DONE]');
      res.end();
      trae.stats.ok++;
      recordRequest({
        kind: 'stream', model, status: hasCalls ? 'tool_calls' : ((parsed.undeclared && parsed.undeclared.length) ? 'undeclared_tool' : (onlyThinking ? 'empty_content' : (capHit ? 'truncated_output' : 'ok'))),
        ms: Date.now() - t0, tools: tools.length, blockMode: blockReport.mode || null,
        blockChars: blockReport.chars || null, promptTokens: usage?.prompt_tokens ?? null,
        completionTokens: usage?.completion_tokens ?? null, reasoningTokens: usage?.reasoning_tokens ?? null, reasoningChars: (out.reason || '').length, cachedTokens: usage?.cache_read_input_tokens ?? null,
        finishReason: hasCalls ? 'tool_calls' : (capHit ? 'length' : 'stop'), callNames: hasCalls ? parsed.calls.map(c => c.name) : [],
    undeclared: (parsed.undeclared && parsed.undeclared.length) ? parsed.undeclared : undefined,
      
        
      });
      log(`[chat] ${model} ${hasCalls ? 'tool_calls' : 'stream'} ok ${Date.now() - t0}ms${hasCalls ? ' -> ' + parsed.calls[0].name : ''}`);
      return;
    }

    const msg = { role: 'assistant', content: hasCalls ? (contentText || null) : contentText };
    if (out.reason) msg.reasoning_content = out.reason;
    if (hasCalls) msg.tool_calls = toolCalls;
    json(res, 200, {
      id, object: 'chat.completion', created, model,
      choices: [{ index: 0, message: msg, finish_reason: hasCalls ? 'tool_calls' : (capHit ? 'length' : 'stop') }],
      usage: toClientUsage(usage),
    });
    trae.stats.ok++;
    recordRequest({
      kind: 'json', model, status: hasCalls ? 'tool_calls' : 'ok',
      ms: Date.now() - t0, tools: tools.length, blockMode: blockReport.mode || null,
      blockChars: blockReport.chars || null, promptTokens: usage?.prompt_tokens ?? null,
      completionTokens: usage?.completion_tokens ?? null, reasoningTokens: usage?.reasoning_tokens ?? null, reasoningChars: (out.reason || '').length, cachedTokens: usage?.cache_read_input_tokens ?? null,
      finishReason: hasCalls ? 'tool_calls' : (capHit ? 'length' : 'stop'), callNames: hasCalls ? parsed.calls.map(c => c.name) : [],
      
    });
    log(`[chat] ${model} ${hasCalls ? 'tool_calls -> ' + parsed.calls[0].name : 'ok'} ${Date.now() - t0}ms chars=${(out.content || '').length} usage=${out.usage ? 'yes' : 'no'}`);
  } catch (e) {
    if (/RPC 超时|超时/.test(String(e.message))) healer.noteFailure('chat', 2);   // 用户已受影响：单次即触发自愈
    trae.stats.fail++;
    trae.stats.lastError = e.message;
    recordRequest({
      kind: stream ? 'stream' : 'json', model, status: 'error', ms: Date.now() - t0,
      tools: tools.length, blockMode: blockReport.mode || null, blockChars: blockReport.chars || null,
      callNames: [], error: e.message,
    });
    log('[chat] 失败: ' + e.message);
    if (stream) { sendSse(res, { error: { message: e.message, type: 'upstream_error' } }); sendSse(res, '[DONE]'); res.end(); }
    else json(res, 502, { error: { message: e.message, type: 'upstream_error' } });
  }
}

// ---------------- 面板 API ----------------
async function apiStatus(req, res) {
  let models = [], modelsError = null;
  try { models = await trae.listModels(false); } catch (e) { modelsError = e.message; }
  json(res, 200, {
    version: VERSION,
    port: PORT,
    bootedAt: BOOTED_AT,
    uptimeMs: Date.now() - BOOTED_AT,
    socket: aha.addr || null,
    connected: aha.connected,
    creds: creds.status(),
    heal: healer.status(),
    // 面板直接展示容量口径（与 /v1/models 同源），避免面板显示上游那个不可信的 116000
    models: models.map(m => ({ name: m.name, display_name: m.display_name, model_type: m.model_type || '', multimodal: !!m.multimodal, is_beta: !!m.is_beta, is_default: !!m.is_default, ...modelCapacity(m) })),
    modelsError,
    stats: { ...trae.stats, cacheHitRate: trae.stats.promptTokens > 0 ? Number((trae.stats.cachedTokens / trae.stats.promptTokens).toFixed(4)) : 0 },
    config: {
      workspace_folder: trae.cfg.workspace_folder,
      local_project_id: trae.cfg.local_project_id,
      version_code: trae.cfg.version_code,
      native_ban: trae.cfg.native_ban !== false,
      tool_schema_depth: Number.isFinite(Number(trae.cfg.tool_schema_depth)) ? Number(trae.cfg.tool_schema_depth) : 3,
      tool_block_budget: Number.isFinite(Number(trae.cfg.tool_block_budget)) ? Number(trae.cfg.tool_block_budget) : 24000,
    model_aliases: trae.cfg.model_aliases || {},
    model_strict: trae.cfg.model_strict !== false,
      agent_type: trae.cfg.default_agent_type || trae.cfg.agent_type || 'chat',
    effective_agent_type: trae.cfg.default_agent_type || trae.cfg.agent_type || 'chat',
      default_model: trae.cfg.default_model || '',
        undeclared_tool_mode: String(trae.cfg.undeclared_tool_mode || "feedback"),
    undeclared_tool_retries: Math.max(0, Number(trae.cfg.undeclared_tool_retries ?? 1) || 0),
    rate_limit_per_min: Math.max(0, Number(trae.cfg.rate_limit_per_min) || 0),
    max_concurrent: Math.max(0, Number(trae.cfg.max_concurrent) || 0),
    stream_keepalive_ms: Number(trae.cfg.stream_keepalive_ms ?? 20000),
    idle_timeout_ms: Number(trae.cfg.idle_timeout_ms ?? 600000),
    reasoning_abort_chars: Number(trae.cfg.reasoning_abort_chars ?? 0),
  runtime_heal: trae.cfg.runtime_heal !== false,
      runtime_heal_threshold: Number(trae.cfg.runtime_heal_threshold) || 2,
      runtime_heal_window_sec: Number(trae.cfg.runtime_heal_window_sec) || 300,
      runtime_probe_sec: Number(trae.cfg.runtime_probe_sec) || 15,
      runtime_probe_timeout_ms: Number(trae.cfg.runtime_probe_timeout_ms) || 10000,
      runtime_heal_cooldown_sec: Number(trae.cfg.runtime_heal_cooldown_sec) || 120,
      has_password: !!authCfg().pwd,
      aha_dir: process.env.TRAE2API_AHA_DIR || '',
      socket: aha.address || '',
    },
  });
}

function apiRequests(req, res, url) {
  const limit = Math.min(Number(url.searchParams.get('limit') || 100) || 100, JOURNAL_MAX);
  const status = url.searchParams.get('status');
  let rows = JOURNAL.slice(-limit).reverse();
  // status=error 兼容旧语义，现在表示「任何 err 级失败」；另支持 fail/warn/精确状态名
  if (status === 'error') rows = rows.filter(r => r.status === 'error' || levelOf(r.status) === 'err');
  else if (status === 'fail' || status === 'failure') rows = rows.filter(r => isFailure(r.status));
  else if (status === 'warn') rows = rows.filter(r => levelOf(r.status) === 'warn');
  else if (status === 'tool') rows = rows.filter(r => r.status === 'tool_calls');
  else if (status) rows = rows.filter(r => r.status === status);
  json(res, 200, { rows, total: JOURNAL.length });
}

function apiErrors(req, res) {
  const byType = new Map();
  for (const r of JOURNAL) {
    if (!isFailure(r.status)) continue;
    const key = String(r.error || r.statusDetail || r.status || '').replace(/\d+/g, 'N').slice(0, 80) || 'unknown';
    const cur = byType.get(key) || { type: key, level: levelOf(r.status) || 'err', status: r.status, count: 0, lastTs: 0, lastModel: '', sample: '' };
    cur.count++;
    if (r.ts >= cur.lastTs) { cur.lastTs = r.ts; cur.lastModel = r.model || ''; cur.sample = String(r.error || '').slice(0, 200); }
    byType.set(key, cur);
  }
  const rows = [...byType.values()].sort((a, b) => b.count - a.count);
  // 工具桥的"漏调/重试"也算异常信号，单独统计
  const toolSignals = {
    misses: trae.stats.toolMisses || 0,
    retries: trae.stats.toolRetries || 0,
    calls: trae.stats.toolCalls || 0,
    totalRequests: trae.stats.requests || 0,
    failed: trae.stats.fail || 0,
  };
  json(res, 200, { rows, toolSignals });
}

function settingsView() {
  const { pwd, key } = authCfg();
  return {
    native_ban: trae.cfg.native_ban !== false,
    tool_schema_depth: Number(trae.cfg.tool_schema_depth ?? 3),
    tool_block_budget: Number(trae.cfg.tool_block_budget ?? 24000),
    default_model: trae.cfg.default_model || '',
    // 请求路径实际读的是 default_agent_type，这里显示真实生效值
    agent_type: trae.cfg.default_agent_type || trae.cfg.agent_type || 'chat',
    effective_agent_type: trae.cfg.default_agent_type || trae.cfg.agent_type || 'chat',
    has_password: !!pwd,
    same_key: pwd === key,
    image_passthrough: trae.cfg.image_passthrough !== false,
    workspace_folder: trae.cfg.workspace_folder || '',
    version_code: trae.cfg.version_code || 0,
  };
}

function saveConfig(next) {
  const file = path.join(__dirname, 'data', 'config.json');
  try { fs.copyFileSync(file, file + '.bak'); } catch {}
  fs.writeFileSync(file, JSON.stringify(next, null, 2) + '\n');
  trae.cfg = next;
}

async function apiSettings(req, res) {
  if (req.method === 'GET') return json(res, 200, settingsView());
  let body;
  try { body = await readBody(req); } catch { return json(res, 400, { error: { message: 'invalid json' } }); }
  const file = path.join(__dirname, 'data', 'config.json');
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { cfg = {}; }
  const applied = [];

  if (typeof body.native_ban === 'boolean') { cfg.native_ban = body.native_ban; applied.push('native_ban'); }
  if (body.tool_schema_depth !== undefined) {
    const v = Number(body.tool_schema_depth);
    if (!Number.isInteger(v) || v < 0 || v > 6) return json(res, 400, { error: { message: 'tool_schema_depth 必须是 0-6 的整数' } });
    cfg.tool_schema_depth = v; applied.push('tool_schema_depth');
  }
  if (body.tool_block_budget !== undefined) {
    const v = Number(body.tool_block_budget);
    if (!Number.isFinite(v) || v < 500 || v > 200000) return json(res, 400, { error: { message: 'tool_block_budget 必须在 500-200000 之间' } });
    cfg.tool_block_budget = Math.round(v); applied.push('tool_block_budget');
  }
  if (typeof body.default_model === 'string') { cfg.default_model = body.default_model; applied.push('default_model'); }
  if (typeof body.agent_type === 'string' && body.agent_type) {
    // 请求路径读的是 default_agent_type，两个字段一起改，避免面板改了却不生效
    cfg.agent_type = body.agent_type;
    cfg.default_agent_type = body.agent_type;
    applied.push('agent_type');
  }
  if (typeof body.image_passthrough === 'boolean') { cfg.image_passthrough = body.image_passthrough; applied.push('image_passthrough'); }
  // 只有一种后端：忽略外部传入的 agent_backend 字段（旧版遗留）
  if (typeof body.workspace_folder === 'string' && body.workspace_folder.trim()) {
    cfg.workspace_folder = body.workspace_folder.trim().replace(/\\/g, '/');
    applied.push('workspace_folder');
  }
  if (typeof body.new_password === 'string' && body.new_password) {
    if (body.new_password.length < 4) return json(res, 400, { error: { message: '口令至少 4 位' } });
    cfg.panel_password = body.new_password;
    cfg.api_key = body.new_password;
    applied.push('panel_password');
  }

  saveConfig(cfg);
  log('[settings] 已应用: ' + applied.join(', '));
  json(res, 200, { ok: true, applied, settings: settingsView() });
}

// ---------- Trae 网页登录（无 VS Code） ----------
let _loginMgr = null;
function detectRuntimeProfile() {
  if (BOOT_CFG.runtime_profile) return BOOT_CFG.runtime_profile;
  const ahaDir = process.env.TRAE2API_AHA_DIR || '';
  const m = /^(.*)[\\/]aha[\\/]aha$/i.exec(ahaDir);
  if (m) {
    const cand = path.join(m[1], 'profile', '.trae-runtime');
    if (fs.existsSync(cand)) return cand;
  }
  return path.join(require('os').homedir(), '.marscode');
}

let lastRestartAt = 0;   // 上次重启时刻（探测宽限期用）
async function restartRuntimeForLogin() { return restartRuntime('login'); }

// 重启运行时（杀 aiserver，看护器 ~15s 内拉起新的 aiserver + agent）。
// 用途：① 登录后让运行时重读 jwt；② AHA 链路挂死时的自愈；③ 手动 /api/heal。
// 重连 AHA：反复 close+connect 直到 connected 或超时。
// 注意：**不能要求 socket 名字变化** —— 实测（2026-11-23 04:14）只重启 aiserver 时
// agent 和它的 .sock 都不变，按「等新地址」会一直等到超时，之后 connected 永远 false。
async function reconnectAha(timeoutMs) {
  const t0 = Date.now();
  let lastErr = null;
  while (Date.now() - t0 < timeoutMs) {
    try {
      try { aha.close(); } catch (e) { /* 重连循环里关旧 socket 失败属预期，下一轮还会重试 */ }
      await aha.connect();
      if (aha.connected) return { ok: true, addr: aha.addr || null, ms: Date.now() - t0 };
    } catch (e) { lastErr = e.message; }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return { ok: false, ms: Date.now() - t0, error: lastErr };
}

// 重启后的预热：先拉模型目录，再发一次极小 chat（agent 侧首次初始化很贵）
async function warmupRuntime(tag) {
  const t0 = Date.now();
  try {
    const list = await trae.listModels(true);
    const msModels = Date.now() - t0;
    const m = trae.cfg.default_model || list[0]?.name;
    if (!m) { log('[warm] ' + tag + ' 模型目录 ' + list.length + ' 个（' + msModels + 'ms），无可用模型，跳过聊天预热'); return; }
    const t1 = Date.now();
    await trae.chat({ model: m, prompt: '只回答：好', agentType: trae.cfg.default_agent_type || 'chat', agentId: trae.cfg.default_agent_type || 'chat',
      onThinking: () => {}, onContent: () => {}, onUsage: () => {} });
    log('[warm] ' + tag + ' 预热完成：模型目录 ' + list.length + ' 个 ' + msModels + 'ms，聊天 ' + (Date.now() - t1) + 'ms（模型 ' + m + '）');
  } catch (e) {
    log('[warm] ' + tag + ' 预热失败（不影响后续请求）: ' + e.message);
  }
}

async function restartRuntime(reason = 'manual') {
  lastRestartAt = Date.now();
  // 杀 aiserver，让看护器把它重新拉起（重新读 jwt.txt，并重建 aiserver→agent 的 AHA 链路）
  let prevAddr = null;
  try { prevAddr = aha.addr || null; } catch {}
  let killed = 0;
  try {
    const { execFileSync } = require('child_process');
    const out = execFileSync('powershell.exe', ['-NoProfile', '-Command',
      "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { \$_.CommandLine -match 'aiServerMainV2' } | Select-Object -ExpandProperty ProcessId"
    ], { encoding: 'utf8', timeout: 20000 });
    const pids = String(out).split(/\s+/).filter(Boolean).map(Number).filter(Boolean);
    for (const pid of pids) { try { process.kill(pid); log('[runtime] 已停止 aiserver pid=' + pid + '（' + reason + '），等待看护重启'); killed++; } catch (e) { log('[runtime] 停止 pid=' + pid + ' 失败: ' + e.message); } }
    if (!pids.length) log('[runtime] 未找到运行中的 aiserver（可能已停，reason=' + reason + '）');
  } catch (e) {
    log('[runtime] 重启运行时失败: ' + e.message);
    return { killed: 0, error: e.message };
  }

  // 反复重连直到连通（不要求 socket 名字变化；agent 可能没重启、socket 还是原来那个）
  const waitMs = Math.max(10, Number(trae.cfg.runtime_restart_wait_sec) || 90) * 1000;
  const rec = await reconnectAha(waitMs);
  if (rec.ok) log('[runtime] 网关已重连 ' + (rec.addr || '?') + '（' + rec.ms + 'ms）');
  else log('[runtime] ⚠ ' + Math.round(waitMs / 1000) + 's 内未能重连（' + (rec.error || 'unknown') + '），看护器可能在拉起中');

  if (!rec.ok) return { killed, reconnected: false, error: rec.error || null };
  if (trae.cfg.runtime_warmup_after_restart !== false) await warmupRuntime('after-restart(' + reason + ')');
  return { killed, reconnected: true, addr: rec.addr || null, readyMs: rec.ms };
}

// 有请求在跑就先不杀 aiserver（避免把正在生成的回答掐断）
let inflightChats = 0;
const healer = createHealer({
  log,
  restart: (why) => restartRuntime(why),
  enabled: trae.cfg.runtime_heal !== false,
  threshold: Math.max(1, Number(trae.cfg.runtime_heal_threshold) || 2),
  windowMs: Math.max(30e3, (Number(trae.cfg.runtime_heal_window_sec) || 600) * 1000),
  cooldownMs: Math.max(30e3, (Number(trae.cfg.runtime_heal_cooldown_sec) || 120) * 1000),
  canHeal: () => inflightChats === 0,
});

// 主动存活探测：
// 目录缓存（30 分钟内）命中时 listModels 不会发 RPC，healer 就拿不到失败样本 → 永远不会自愈。
// 所以空闲时定期用「短超时」强制拉一次 model_list，作为链路存活心跳。
let lastProbeOkAt = Date.now();
function startRuntimeProbe() {
  const intervalSec = Math.max(5, Number(trae.cfg.runtime_probe_sec) || 15);
  const timeoutMs = Math.max(3000, Number(trae.cfg.runtime_probe_timeout_ms) || 10000);
  setInterval(async () => {
    try {
      // 重启后的宽限期（默认 120s）里不要计失败：新 aiserver 要 20-40s 才会拉起 ai-agent，
      // 这期间「未连接」是正常的，计失败会把刚拉起的进程再杀掉（2026-11-24 实测的抖动死循环）
      const graceSec = Math.max(0, Number(trae.cfg.runtime_probe_grace_sec ?? 120));
      const graceLeft = lastRestartAt ? graceSec * 1000 - (Date.now() - lastRestartAt) : 0;
      if (graceLeft > 0) return;
      // 断连不能直接 return —— 否则「链路挂死」永远不会被记为失败，healer 也就永不触发（2026-11-24 修）
      if (!aha.connected) {
        try {
          await aha.connect();
          if (aha.connected) { log('[probe] 断连后已自动重连 ' + (aha.addr || '')); return; }
        } catch (e) { /* 落到下面计失败 */ }
        log('[probe] 处于未连接状态，记一次失败并尝试自愈');
        healer.noteFailure('probe');
        return;
      }
      if (inflightChats > 0) return;                    // 有请求在跑，它本身就是探针
      await trae.listModels(true, timeoutMs);           // 强制 + 短超时
      lastProbeOkAt = Date.now();
      healer.noteSuccess();
    } catch (e) {
      if (/RPC 超时|超时|not connected|socket 未连接/.test(String(e.message))) {
        log('[probe] 存活探测失败：' + e.message);
        healer.noteFailure('probe');
      }
    }
  }, intervalSec * 1000).unref?.();
  log('[probe] 运行时存活探测已启动：每 ' + intervalSec + 's 一次，超时 ' + timeoutMs + 'ms');
}

function getLoginMgr() {
  if (_loginMgr) return _loginMgr;
  _loginMgr = new TraeLogin({
    profileDir: detectRuntimeProfile(),
    log: (m) => log(m),
    onNeedRestart: restartRuntimeForLogin,
    // 登录成功写盘后立刻让网关切到新凭据（面板刷新即见 hasCreds=true，不必重启网关）
    onCredsSaved: () => {
      creds.cache = null;
      Promise.resolve(creds.ensure().catch((e) => log('[login] 加载新凭据失败: ' + e.message)))
        .then(() => log('[login] 网关已加载新凭据: hasCreds=' + !!creds.status().hasCreds));
    },
  });
  log('[login] 凭据写入目录: ' + _loginMgr.profileDir);
  return _loginMgr;
}


async function apiTraeLoginScreen(req, res) {
  try {
    const mgr = getLoginMgr();
    const png = await mgr.screenshot();
    if (!png) return json(res, 404, { ok: false, error: '登录页未打开' });
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
    return res.end(png);
  } catch (e) {
    return json(res, 500, { ok: false, error: e.message });
  }
}

async function apiTraeLoginPage(req, res) {
  try {
    const mgr = getLoginMgr();
    return json(res, 200, { ok: true, state: mgr.status(), page: await mgr.probePage() });
  } catch (e) {
    return json(res, 500, { ok: false, error: e.message });
  }
}

async function apiTraeLoginPhone(req, res) {
  try {
    const body = await readJsonBody(req);
    const phone = String(body.phone || '').trim();
    if (!/^\d{6,15}$/.test(phone)) return json(res, 400, { ok: false, error: '手机号格式不对' });
    const r = await getLoginMgr().fillPhone(phone);
    return json(res, 200, { ok: true, result: r, state: getLoginMgr().status() });
  } catch (e) {
    return json(res, 500, { ok: false, error: e.message });
  }
}

async function apiTraeLoginCode(req, res) {
  try {
    const body = await readJsonBody(req);
    const code = String(body.code || '').trim();
    if (!/^\d{4,8}$/.test(code)) return json(res, 400, { ok: false, error: '验证码格式不对' });
    const r = await getLoginMgr().fillCode(code);
    return json(res, 200, { ok: true, result: r, state: getLoginMgr().status() });
  } catch (e) {
    return json(res, 500, { ok: false, error: e.message });
  }
}

function apiTraeLoginOpen(req, res) {
  const { LOGIN_URL } = require('./lib/trae-login.cjs');
  res.writeHead(302, { Location: LOGIN_URL, 'Cache-Control': 'no-store' });
  return res.end();
}

async function apiTraeLoginStart(req, res) {
  try {
    const mgr = getLoginMgr();
    await mgr.start();
    return json(res, 200, { ok: true, state: mgr.status(), qr: mgr.qrDataUrl });
  } catch (e) {
    return json(res, 500, { ok: false, error: e.message, state: getLoginMgr().status() });
  }
}

async function apiTraeLoginState(req, res) {
  const mgr = getLoginMgr();
  await mgr.poll().catch(() => {});
  return json(res, 200, { ok: true, state: mgr.status(), qr: mgr.state === 'waiting_scan' ? mgr.qrDataUrl : null });
}

async function apiTraeLoginFinish(req, res) {
  const mgr = getLoginMgr();
  await mgr.poll().catch(() => {});
  if (mgr.state !== 'done') return json(res, 409, { ok: false, error: '尚未登录完成（state=' + mgr.state + '）', state: mgr.status() });
  return json(res, 200, { ok: true, state: mgr.status() });
}

async function apiTraeLoginCancel(req, res) {
  const mgr = getLoginMgr();
  await mgr.cancel();
  return json(res, 200, { ok: true, state: mgr.status() });
}

async function apiTraeLoginFromRefreshToken(req, res) {
  try {
    const body = await readJsonBody(req);
    const rt = String(body.refreshToken || '').trim();
    if (!rt) return json(res, 400, { ok: false, error: '缺少 refreshToken' });
    const mgr = getLoginMgr();
    const out = await mgr.exchangeRefreshToken(rt);
    return json(res, 200, { ok: true, jwtLen: out.jwt.length, exp: out.exp, profile: mgr.profileDir });
  } catch (e) {
    return json(res, 500, { ok: false, error: e.message });
  }
}

async function readJsonBody(req) {
  return await new Promise((resolve) => {
    let buf = '';
    req.on('data', (c) => { buf += c; if (buf.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(buf || '{}')); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

async function apiRefreshModels(req, res) {
  try {
    const list = await trae.listModels(true);
    log('[models] 手动刷新模型目录：' + list.length + ' 个');
    json(res, 200, { ok: true, count: list.length });
  } catch (e) {
    json(res, 502, { error: { message: e.message } });
  }
}

// 手动自愈：杀 aiserver 让看护器重建 agent 链路（AHA 挂死时唯一的有效动作）
async function apiHeal(req, res) {
  try {
    const before = healer.status();
    await healer.forceHeal('manual via /api/heal');
    json(res, 200, { ok: true, before, after: healer.status() });
  } catch (e) {
    json(res, 500, { error: { message: e.message } });
  }
}

async function apiRefreshCreds(req, res) {
  const t0 = Date.now();
  log('[creds] 收到续期请求');
  try {
    await creds.ensure({ force: true });
    const ms = Date.now() - t0;
    const exp = Number((creds.cache && creds.cache.jwtExp) || 0);
    log('[creds] 续期请求完成：' + ms + 'ms，lastRefreshAt=' + creds.lastRefreshAt +
        '，jwtExp=' + (exp ? new Date(exp).toLocaleString('zh-CN') : '—'));
    json(res, 200, { ok: true, elapsedMs: ms, refreshed: ms > 500 || creds.lastRefreshAt > 0, creds: creds.status() });
  } catch (e) {
    log('[creds] 续期失败: ' + e.message);
    json(res, 500, { ok: false, error: e.message });
  }
}

// 面板试聊：SSE，事件里区分 thinking / content / usage / done
async function apiPlayground(req, res) {
  let body;
  try { body = await readBody(req); } catch (e) { return json(res, 400, { error: e.message }); }
  let model = body.model || 'Doubao-Seed-Code';
  // 试聊也走同一套校验（用 JSON 报错，浏览器端会显示）
  if (body.model) {
    const r = await checkModel(model);
    if (!r.ok) return json(res, 404, { error: { message: r.message, code: 'model_not_found' } });
    model = r.name;
  }
  const prompt = String(body.prompt || '').trim();
  if (!prompt) return json(res, 400, { error: 'prompt 为空' });
  sseHead(res);
  const t0 = Date.now(); let first = 0; let n = 0;
  try {
    const r = await trae.chat({
      model, prompt,
      onThinking: (d) => { if (!first) first = Date.now() - t0; sendSse(res, { type: 'thinking', text: d }); },
      onContent: (d) => { if (!first) first = Date.now() - t0; n += d.length; sendSse(res, { type: 'content', text: d }); },
      onUsage: (u) => sendSse(res, { type: 'usage', usage: u }),
    });
    sendSse(res, { type: 'done', status: r.status, ms: Date.now() - t0, firstMs: first, chars: n, chatSessionId: r.chatSessionId });
    res.end();
  } catch (e) {
    sendSse(res, { type: 'error', message: e.message });
    res.end();
  }
}

// ---------------- 静态面板 ----------------
const PUBLIC = path.join(__dirname, 'public');
function serveStatic(req, res, urlPath) {
  const rel = urlPath === '/' ? '/index.html' : urlPath;
  const file = path.join(PUBLIC, rel.replace(/\.\./g, ''));
  if (!(file === PUBLIC || file.startsWith(PUBLIC + path.sep)) || !fs.existsSync(file)) { res.writeHead(404); return res.end('not found'); }
  const ext = path.extname(file);
  const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml' }[ext] || 'text/plain; charset=utf-8';
  res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-store' });
  fs.createReadStream(file).pipe(res);
}

// ---------------- 鉴权（口令门禁） ----------------
// 规则：本机回环免密；/v1/* 需 Bearer <api_key>；面板与 /api/* 需登录会话
const SESSIONS = new Map();          // token -> expireAt
const LOGIN_FAILS = new Map();         // ip -> { firstAt, count }（面板登录防爆破）
const SESSION_TTL = 7 * 24 * 3600e3;

// /healthz 的三项自检快照：通道 / 工作区 / 凭据（具体判定在 lib/health.cjs，可单测）
function healthSnapshot() {
  let credsStatus = {};
  try { credsStatus = creds.status() || {}; } catch (e) { log('[health] creds.status() 失败: ' + (e && e.message)); }
  const fsOk = require("fs");
  return computeChecks({
    connected: aha.connected,
    socket: aha.addr || null,
    workspaceFolder: trae.cfg.workspace_folder,
    hasCreds: !!credsStatus.hasCreds,
    credsError: credsStatus.lastError || null,
    fsExists: (p) => { try { return fsOk.existsSync(p); } catch { return false; } },
    fsWritable: (p) => { try { fsOk.accessSync(p, fsOk.constants.W_OK); return true; } catch { return false; } },
  });
}
// 过期面板会话每 10 分钟清一次（以前只在被访问/登出时删，长期不登录会缓慢堆积）
function sweepSessions() {
  const now = Date.now();
  let n = 0;
  for (const [tok, exp] of SESSIONS) {
    if (!exp || exp < now) { SESSIONS.delete(tok); n++; }
  }
  // 登录失败表同样清理：只按「新失败覆盖旧记录」，长期会把唯一 IP 都留在 Map 里
  let nf = 0;
  for (const [ip, rec] of LOGIN_FAILS) {
    if (!rec || now - rec.firstAt >= 600e3) { LOGIN_FAILS.delete(ip); nf++; }
  }
  if (n) log('[auth] 清理过期面板会话 ' + n + ' 个（剩余 ' + SESSIONS.size + '）');
  if (nf) log('[auth] 清理过期登录失败记录 ' + nf + ' 条（剩余 ' + LOGIN_FAILS.size + '）');
}
setInterval(sweepSessions, 600e3).unref?.();
function authCfg() {
  try {
    const c = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'config.json'), 'utf8'));
    const pwd = typeof c.panel_password === 'string' ? c.panel_password : '';
    const key = typeof c.api_key === 'string' && c.api_key ? c.api_key : pwd;
    return { pwd, key, enabled: !!pwd };
  } catch { return { pwd: '', key: '', enabled: false }; }
}

function isLoopback(req) {
  const a = (req.socket.remoteAddress || '').replace('::ffff:', '');
  return a === '127.0.0.1' || a === '::1' || a === 'localhost';
}

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function panelAuthed(req) {
  const { enabled } = authCfg();
  if (!enabled || isLoopback(req)) return true;
  const tok = parseCookies(req).t2a;
  if (!tok) return false;
  const exp = SESSIONS.get(tok);
  if (!exp || exp < Date.now()) { SESSIONS.delete(tok); return false; }
  return true;
}

function apiAuthed(req) {
  const { enabled, key } = authCfg();
  if (!enabled || isLoopback(req)) return true;
  const h = String(req.headers.authorization || '');
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  if (!m) return false;
  // 常数时间比较，避免按字节试探
  const a = Buffer.from(m[1]);
  const b = Buffer.from(key);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function serveLogin(res) {
  const file = path.join(PUBLIC, 'login.html');
  if (!fs.existsSync(file)) { res.writeHead(404); return res.end('login page missing'); }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname;
  try {
    if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' }); return res.end(); }
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (p === '/healthz') {
      // ok 仍只表示「网关进程在跑」；三项自检放在 checks 里，方便外部监控区分是运行时没起、工作区没了还是凭据失效
      let checks = null;
      try { checks = healthSnapshot(); } catch (e) { checks = { ok: false, error: String(e && e.message || e) }; }
      return json(res, 200, { ok: true, connected: aha.connected, version: VERSION, checks });
    }

    // 登录页与登录接口（免登录）
    if (p === '/login' || p === '/login.html') return serveLogin(res);
    if (p === '/api/login' && req.method === 'POST') {
      let body;
      try { body = await readBody(req); } catch { return json(res, 400, { error: { message: 'invalid json' } }); }
      // 简单防爆破：同 IP 10 分钟内最多 10 次失败；口令正确时永远放行（先校验，后限流）
      const ip = (req.socket.remoteAddress || '?').replace('::ffff:', '');
      const now = Date.now();
      const { pwd } = authCfg();
      const given = String(body?.password ?? '');
      if (!pwd) return json(res, 200, { ok: true, note: '未设置口令，直接放行' });
      const ok = given.length === pwd.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(pwd));
      const rec = LOGIN_FAILS.get(ip);
      if (!ok && rec && now - rec.firstAt < 600e3 && rec.count >= 10) {
        return json(res, 429, { error: { message: '尝试次数过多，请 10 分钟后再试' } });
      }
      if (!ok) {
        if (!rec || now - rec.firstAt >= 600e3) LOGIN_FAILS.set(ip, { firstAt: now, count: 1 });
        else rec.count++;
        log('[auth] 面板登录失败 from ' + ip);
        return json(res, 401, { error: { message: '口令错误' } });
      }
      LOGIN_FAILS.delete(ip);
      const wantNext = typeof body?.next === 'string' && body.next.startsWith('/') && !body.next.startsWith('//') ? body.next : null;
      const tok = crypto.randomBytes(24).toString('hex');
      SESSIONS.set(tok, Date.now() + SESSION_TTL);
      log('[auth] 面板登录成功 from ' + (req.socket.remoteAddress || '?'));
      res.setHeader('Set-Cookie', buildSessionCookie(tok, { secure: isSecureRequest(req), maxAgeSec: SESSION_TTL / 1000 }));
      return json(res, 200, Object.assign({ ok: true }, wantNext ? { next: wantNext } : {}));
    }
    if (p === '/api/logout' && req.method === 'POST') {
      const tok = parseCookies(req).t2a;
      if (tok) SESSIONS.delete(tok);
      res.setHeader('Set-Cookie', clearSessionCookie({ secure: isSecureRequest(req) }));
      return json(res, 200, { ok: true });
    }

    // /v1/* 走 Bearer
    if (p.startsWith('/v1/')) {
      if (!apiAuthed(req)) return json(res, 401, { error: { message: 'invalid api key', type: 'invalid_request_error' } });
      if (p === '/v1/models' && req.method === 'GET') return handleModels(req, res);
      if (p === '/v1/chat/completions' && req.method === 'POST') return handleChat(req, res);
      return json(res, 404, { error: { message: 'not found' } });
    }

    // 面板与 /api/* 走会话
    if (!panelAuthed(req)) {
      if (p.startsWith('/api/')) return json(res, 401, { error: { message: 'unauthorized' } });
      // 页面请求：302 跳到登录页并记住原地址，登录后跳回（远程访问同样生效）
      const nextPath = p + (url.search || '');
      res.writeHead(302, { Location: '/login?next=' + encodeURIComponent(nextPath), 'Cache-Control': 'no-store' });
      return res.end();
    }
    if (p === '/api/trae-login/start' && req.method === 'POST') return apiTraeLoginStart(req, res);
      if (p === '/api/trae-login/state' && req.method === 'GET') return apiTraeLoginState(req, res);
      if (p === '/api/trae-login/finish' && req.method === 'POST') return apiTraeLoginFinish(req, res);
      if (p === '/api/trae-login/screen' && req.method === 'GET') return apiTraeLoginScreen(req, res);
      if (p === '/api/trae-login/page' && req.method === 'GET') return apiTraeLoginPage(req, res);
      if (p === '/api/trae-login/phone' && req.method === 'POST') return apiTraeLoginPhone(req, res);
      if (p === '/api/trae-login/code' && req.method === 'POST') return apiTraeLoginCode(req, res);
      if (p === '/api/trae-login/open' && req.method === 'GET') return apiTraeLoginOpen(req, res);
      if (p === '/api/trae-login/cancel' && req.method === 'POST') return apiTraeLoginCancel(req, res);
      if (p === '/api/trae-login/refresh-token' && req.method === 'POST') return apiTraeLoginFromRefreshToken(req, res);
      if (p === '/api/status' && req.method === 'GET') return apiStatus(req, res);
    if (p === '/api/shutdown' && req.method === 'POST') {
      const ip = req.socket.remoteAddress || '';
      if (!/^(127\.|::1|::ffff:127\.)/.test(ip)) return json(res, 403, { error: 'only loopback' });
      json(res, 202, { ok: true, draining: activeStreams.size });
      setTimeout(() => gracefulShutdown('api'), 150);
      return;
    }
    if (p === '/api/creds/refresh' && req.method === 'POST') return apiRefreshCreds(req, res);
    if (p === '/api/playground' && req.method === 'POST') return apiPlayground(req, res);
    if (p === '/api/logs' && req.method === 'GET') return json(res, 200, { lines: LOG_RING.slice(-200) });
    if (p === '/api/requests' && req.method === 'GET') return apiRequests(req, res, url);
    if (p === '/api/errors' && req.method === 'GET') return apiErrors(req, res);
    if (p === '/api/settings') return apiSettings(req, res);
    if (p === '/api/models/refresh' && req.method === 'POST') return apiRefreshModels(req, res);
    if (p === '/api/heal' && req.method === 'POST') { if (!apiAuthed(req)) return json(res, 401, { error: 'unauthorized' }); return await apiHeal(req, res); }
    if (req.method === 'GET') return serveStatic(req, res, p);
    json(res, 404, { error: 'not found' });
  } catch (e) {
    log('[http] ' + p + ' 异常: ' + e.message);
    try { json(res, 500, { error: e.message }); } catch {}
  }
});

const gracefulShutdown = (reason) => {
  log('[shutdown] ' + reason + '：结束 ' + activeStreams.size + ' 个在途流式响应');
  for (const r of activeStreams) {
    try {
      sendSse(r, { id: 'shutdown-' + Date.now(), object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: r._traeModel || 'unknown', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
      sendSse(r, '[DONE]');
      r.end();
    } catch {}
  }
  activeStreams.clear();
  try { server.close(); } catch {}
  setTimeout(() => process.exit(0), 300);
};
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// 通道看门狗：每 20s 检查当前通道 socket 对应的 .ready pid 是否还活着；
// 死了就主动断开，下次请求会重新扫候选（扩展 ←→ 独立 agent 自动故障转移）。
{
  const fsx = require('fs');
  setInterval(() => {
    try {
      const addr = trae.aha && trae.aha.addr;
      if (!addr) return;
      const file = addr.replace(/^ipc:\/\//, '');
      const pid = Number(fsx.readFileSync(file + '.ready', 'utf8').trim());
      let alive = false;
      try { process.kill(pid, 0); alive = true; } catch {}
      if (!alive) {
        log('[channel-watchdog] 当前通道 agent(pid=' + pid + ') 已退出，断开重扫：' + require('path').basename(file));
        trae.aha._dropConnection('agent 进程已退出');
      }
    } catch {}
  }, 20000).unref();
}

// Node 18+ 默认 requestTimeout=300s 会掐掉长请求；这里改为不限制总时长，
// 只保留 socket 空闲语义（由网关自身的空闲看门狗 + 15s SSE 心跳负责）。
server.requestTimeout = 0;
server.headersTimeout = 120000;
server.keepAliveTimeout = 7200000;
server.timeout = 0;

server.listen(PORT, HOST, async () => {
  if (!authCfg().enabled) {
    log('[SECURITY] ⚠ 未设置 panel_password：面板与 /v1/* 现在对任何来源开放！请立刻在 data/config.json 里设置口令');
  }
  log(`trae2api v${VERSION} 监听 http://${HOST}:${PORT}`);
  try {
    await creds.ensure();
    const st = creds.status();
    log('[creds] 凭据就绪 jwtExp=' + (st.jwtExp ? new Date(st.jwtExp).toLocaleString('zh-CN') : '—') +
        ' freshExp=' + (st.freshExp ? new Date(st.freshExp).toLocaleString('zh-CN') : '—'));
  }
  catch (e) { log('[creds] 初始化失败: ' + e.message); }
  try { await aha.connect(); log('[aha] 已连接'); }
  catch (e) { log('[aha] 连接失败: ' + e.message); }
  startAutoRenew();
});

// ---------- 自动续期：默认每 24 小时强制续一次（config: creds_auto_renew_hours） ----------
function startAutoRenew() {
  const hours = Number(trae.cfg.creds_auto_renew_hours ?? 24);
  if (!Number.isFinite(hours) || hours <= 0) {
    log('[creds] 自动续期已关闭（creds_auto_renew_hours=' + trae.cfg.creds_auto_renew_hours + '）');
    return;
  }
  const intervalMs = hours * 3600e3;
  creds.autoRenewHours = hours;
  const tick = async (why) => {
    // 有在途流式请求时推迟续期：虽然续期不影响已发出的请求（token 在请求开始时已快照），
    // 但推迟能避免"正好卡在请求起始瞬间"的等待，也少一次无谓干扰。
    if (activeStreams.size > 0) {
      log('[creds] 自动续期推迟：当前有 ' + activeStreams.size + ' 个在途流式请求，5 分钟后重试');
      creds.nextRenewAt = Date.now() + 300e3;
      setTimeout(() => tick(why + '（推迟后）'), 300e3).unref?.();
      return;
    }
    const prevExp = Number((creds.cache && creds.cache.jwtExp) || 0);
    try {
      await creds.ensure({ force: true });
      const exp = Number((creds.cache && creds.cache.jwtExp) || 0);
      const freshExp = Number((creds.cache && creds.cache.freshExp) || 0);
      creds.renewCount = (creds.renewCount || 0) + 1;
      creds.nextRenewAt = Date.now() + intervalMs;
      log('[creds] 自动续期成功（' + why + '，第 ' + creds.renewCount + ' 次）：jwt ' +
          (prevExp ? new Date(prevExp).toLocaleString('zh-CN') : '—') + ' → ' + new Date(exp).toLocaleString('zh-CN') +
          '，refresh 到期 ' + (freshExp ? new Date(freshExp).toLocaleString('zh-CN') : '—'));
    } catch (e) {
      // 续期失败：保留旧 token，不中断服务；只记录并缩短重试间隔（1 小时后重试）
      creds.lastError = e.message;
      creds.nextRenewAt = Date.now() + 3600e3;
      log('[creds] 自动续期失败（' + why + '）：' + e.message + '（保留旧凭据，1 小时后重试）');
    }
  };
  // 启动后 2 分钟跑一次首次检查，之后按间隔
  setTimeout(() => tick('启动后首次'), 120e3).unref?.();
  setInterval(() => tick('定时'), intervalMs).unref?.();
  log('[creds] 自动续期已开启：每 ' + hours + ' 小时一次');
}


process.on('SIGINT', () => { aha.close(); process.exit(0); });
process.on('SIGTERM', () => { aha.close(); process.exit(0); });




















