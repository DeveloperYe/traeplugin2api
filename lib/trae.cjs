// trae.cjs —— 在 AhaClient 之上封装 "lite 通道 chat 模式" 的业务流程
// 流程：create_chat_session → send_message → subscribe_events(流) → (可选)commit
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const DATA = path.join(__dirname, '..', 'data');
const CONFIG_FILE = path.join(DATA, 'config.json');

// 默认工作区：用户主目录下的固定目录（不写死任何机器相关路径）
const DEFAULT_WORKSPACE = path.join(os.homedir(), 'trae2api-workspace').replace(/\\/g, '/');

const DEFAULTS = {
  workspace_folder: DEFAULT_WORKSPACE,
  icube_language: 'en',
  version_code: 1007016,
  plugin_channel: 'vscode',
  local_project_id: '',
  device_id: '',
};

// 允许 config.json / config.example.json 里写 // 与 /* */ 注释和尾逗号（JSONC），
// 因为示例文件带注释、而 JSON.parse 不认识它们；以前解析失败会被静默吞掉、直接用默认值，
// 表现成「照着示例配了一份却完全不生效」。这里改成：先按严格 JSON 解析，失败再剥注释重试，
// 两次都失败就抛出明确报错（不再静默）。
function stripJsonc(text) {
  let out = '';
  let inStr = false, esc = false, inLine = false, inBlock = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i], n = text[i + 1];
    if (inLine) { if (c === '\n') { inLine = false; out += c; } continue; }
    if (inBlock) { if (c === '*' && n === '/') { inBlock = false; i++; } continue; }
    if (inStr) {
      out += c;
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; out += c; continue; }
    if (c === '/' && n === '/') { inLine = true; i++; continue; }
    if (c === '/' && n === '*') { inBlock = true; i++; continue; }
    out += c;
  }
  // 去掉对象/数组里的尾逗号（, 后面只跟空白再接 } 或 ]）
  return out.replace(/,(\s*[}\]])/g, '$1');
}

function loadConfig() {
  fs.mkdirSync(DATA, { recursive: true });
  let cfg = {};
  let raw = null;
  try { raw = fs.readFileSync(CONFIG_FILE, 'utf8'); } catch { raw = null; }
  if (raw !== null) {
    const text = raw.replace(/^\uFEFF/, '');
    try {
      cfg = JSON.parse(text);
    } catch (e1) {
      try {
        cfg = JSON.parse(stripJsonc(text));
        console.warn('[config] data/config.json 含注释或尾逗号，已按 JSONC 容错解析（严格 JSON 会失败：' + e1.message.slice(0, 80) + '）');
      } catch (e2) {
        throw new Error('data/config.json 解析失败（严格 JSON 与 JSONC 都不通过）：' + e2.message.slice(0, 160)
          + '。请检查是否少了引号/逗号，或先用 config.example.json 覆盖一份再改。');
      }
    }
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) throw new Error('data/config.json 顶层必须是对象（{...}）');
  }
  const merged = { ...DEFAULTS, ...cfg };
  let dirty = false;
  if (!merged.device_id) { merged.device_id = String(Date.now()).slice(-13) + String(Math.floor(Math.random() * 10)); dirty = true; }
  if (dirty) saveConfig(merged);
  return merged;
}
function saveConfig(cfg) {
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
}

class TraeService {
  constructor({ aha, creds, log, projectIdKey = 'local_project_id' }) {
    this.aha = aha;
    this.projectIdKey = projectIdKey;
    this.creds = creds;
    this.log = log || (() => {});
    this.cfg = loadConfig();
    this.modelsCache = { at: 0, list: [] };
    this.stats = { requests: 0, ok: 0, fail: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, lastError: null, startedAt: Date.now() };
  }

  async baseParams() {
    const c = await this.creds.ensure();
    const ident = this.creds.identity || {};
    return {
      session_id: crypto.randomUUID(),
      user_info: {
        name: ident.name || 'user',
        token: c.jwt,
        region: 'cn',
        user_id: ident.uid || '',
        is_internal: false,
        scope: 'marscode',
        enterprise_info: { product_type: 0 },
      },
      common_params: {
        biz_user_id: ident.uid || '',
        user_unique_id: ident.uid || '',
        tenant_id: ident.tenant || 'unknown_tenant',
        tenant_name: ident.tenant || 'unknown_tenant',
        device_id: this.cfg.device_id,
        agent_type: 'chat',
      },
      client_info: {
        ppe_env_name: '',
        connect_session_id: '',
        workspace_folder: this.cfg.workspace_folder,
        icube_language: this.cfg.icube_language,
        device_id: this.cfg.device_id,
        version_code: this.cfg.version_code,
        plugin_channel: this.cfg.plugin_channel,
        git_repos: [],
        local_git_repos: [],
        is_evaluation: false,
        is_worktree: false,
        is_workspace_folder_changed: false,
        workspace_folders: [this.cfg.workspace_folder],
      },
    };
  }

  async ensureProjectId(base) {
    const key = this.projectIdKey || 'local_project_id';
    if (this.cfg[key]) return this.cfg[key];
    // 照 aiserver 的请求形状：{biz_project_id, user_id, absolute_path}
    const crypto = require('crypto');
    const biz = crypto.createHash('md5').update(this.cfg.workspace_folder.toLowerCase()).digest('hex');
    for (const payload of [
      { biz_project_id: biz, user_id: (this.creds.identity || {}).uid || '', absolute_path: this.cfg.workspace_folder },
      { absolute_path: this.cfg.workspace_folder },
    ]) {
      try {
        const res = await this.aha._rpc('project', 'create_project', payload, base, { timeout: 20000 });
        this.log('[trae] create_project 响应: ' + JSON.stringify(res).slice(0, 300));
        const d = res?.data?.data || res?.data || {};
        const id = d.local_project_id || d.project_id || d.id;
        if (id) { this.cfg[key] = String(id); saveConfig(this.cfg); this.log('[trae] ' + key + '=' + id); return this.cfg[key]; }
      } catch (e) { this.log('[trae] create_project 失败: ' + e.message); }
    }
    return '';
  }

  // 模型目录：内存 30 分钟 + 磁盘缓存（重启后立刻可用，不必等一次 30 秒的冷启动）
  _modelsCacheFile() { return require('path').join(__dirname, '..', 'data', 'models-cache.json'); }

  _loadModelsFromDisk() {
    try {
      const f = this._modelsCacheFile();
      if (!require('fs').existsSync(f)) return;
      const j = JSON.parse(require('fs').readFileSync(f, 'utf8'));
      if (Array.isArray(j.list) && j.list.length) {
        this.modelsCache = { at: Number(j.at) || Date.now(), list: j.list };
      }
    } catch {}
  }

  _saveModelsToDisk() {
    try {
      require('fs').writeFileSync(this._modelsCacheFile(), JSON.stringify(this.modelsCache));
    } catch {}
  }

  async listModels(force = false, timeoutMs = 60000) {
    if (!this.modelsCache.list.length) this._loadModelsFromDisk();
    if (!force && this.modelsCache.list.length && Date.now() - this.modelsCache.at < 1800000) return this.modelsCache.list;
    const base = await this.baseParams();
    const res = await this.aha._rpc('model', 'model_list', {}, base, { timeout: timeoutMs });
    const list = res?.data?.model_list || [];
    if (list.length) { this.modelsCache = { at: Date.now(), list }; this._saveModelsToDisk(); }
    else if (this.modelsCache.list.length) return this.modelsCache.list;   // 失败时退回旧缓存
    return list;
  }

  modelConfig(name) {
    return this.modelsCache.list.find(m => m.name === name) || {
      name, display_name: name, multimodal: false, is_default: false, is_beta: false,
      is_new: false, selectable: true, config_source: 1, prompt_max_tokens: 100000,
      model_type: 'chat_model',
    };
  }

  // 把 OpenAI messages 压成一段文本（chat 模式只接受一条 query）
  // extraSystem：工具规格等需要放在最前面的内容
  // opts.includeReasoning: 'off' | 'last' | 'all'   —— 是否把历史里各轮 assistant 的思考回填进 prompt
  // opts.reasoningMaxChars: 单轮思考截断上限（0 = 不限）
  // opts.reasoningTotalMaxChars: 思考总量上限（0 = 不限），超出后从最早轮开始丢
  static flattenMessages(messages, extraSystem = '', opts = {}) {
    const mode = String(opts.includeReasoning || 'off').toLowerCase();
    const perCap = Math.max(0, Number(opts.reasoningMaxChars) || 0);
    const totalCap = Math.max(0, Number(opts.reasoningTotalMaxChars) || 0);
    const sys = [];
    const convo = [];
    for (const m of messages || []) {
      const text = typeof m.content === 'string' ? m.content
        : Array.isArray(m.content) ? m.content.map(c => (typeof c === 'string' ? c : c?.text || '')).join('') : '';
      if (m.role === 'system' || m.role === 'developer') { sys.push(text); continue; }
      if (m.role === 'tool') {
        const name = m.name || m.tool_call_id || 'tool';
        convo.push({ role: 'tool', text: `工具(${name}) 返回：${text}` });
        continue;
      }
      let t = text;
      if (Array.isArray(m.tool_calls) && m.tool_calls.length) {
        const calls = m.tool_calls.map(c => `CALL ${c.function?.name} ${c.function?.arguments}`).join('\n');
        t = (calls + (text ? '\n' + text : '')).trim();
      }
      // 客户端回传的思考：pi-ai 会用 reasoning_content（也兼容 reasoning / reasoning_text）
      let reasoning = '';
      if (m.role === 'assistant') {
        const raw = typeof m.reasoning_content === 'string' ? m.reasoning_content
          : typeof m.reasoning === 'string' ? m.reasoning
          : typeof m.reasoning_text === 'string' ? m.reasoning_text : '';
        reasoning = String(raw || '').trim();
        if (perCap > 0 && reasoning.length > perCap) reasoning = reasoning.slice(0, perCap) + '…（已截断）';
      }
      convo.push({ role: m.role, text: t, reasoning });
    }
    const last = convo[convo.length - 1];
    const history = convo.slice(0, -1);
    // 选哪些历史轮带思考：all = 全部；last = 只带最近一轮
    let picked = history.filter(h => h.role === 'assistant' && h.reasoning);
    if (mode !== 'all') picked = mode === 'last' ? picked.slice(-1) : [];
    const chosen = new Set(picked);
    if (totalCap > 0) {
      // 从最近一轮往前累加：超出总量的**较早**轮次被丢弃（越近的越重要）
      let used = 0;
      for (let i = picked.length - 1; i >= 0; i--) {
        const h = picked[i];
        if (used + h.reasoning.length > totalCap) h._dropReasoning = true;
        else used += h.reasoning.length;
      }
    }
    let prompt = '';
    if (extraSystem) prompt += extraSystem + '\n\n';
    if (sys.length) prompt += '【系统要求】\n' + sys.join('\n') + '\n\n';
    if (history.length) {
      const hasRzn = [...chosen].some(h => h.reasoning && !h._dropReasoning);
      prompt += '【对话历史】' + (hasRzn ? '（〔思考〕块是各轮助手当时的内部推理，供你延续判断，不要在回答里引用或复述）' : '') + '\n'
        + history.map(h => {
          const who = h.role === 'assistant' ? '助手' : h.role === 'tool' ? '工具' : '用户';
          let line = `${who}：${h.text}`;
          if (chosen.has(h) && h.reasoning && !h._dropReasoning) line += `\n〔思考〕${h.reasoning}`;
          return line;
        }).join('\n') + '\n\n';
    }
    prompt += (last?.text || '');
    return prompt;
  }

  // 发起一次聊天；回调收到增量
  async chat({ model, prompt, onThinking, onContent, onUsage, signal, agentType = 'chat', agentId = 'chat', extra = null, modelExtra = null, reuseSession = null }) {
    const T0 = Date.now();
    const lap = (l) => this.log('[timing] ' + l + ' ' + (Date.now() - T0) + 'ms');
    const base = await this.baseParams();
    const pid = await this.ensureProjectId(base);
    lap('project');

    let chatSessionId = reuseSession;
    if (!chatSessionId) {
      const cs = await this.aha._rpc('lite', 'create_chat_session',
        { mode: 'code', env: 'local', local_project_id: pid }, base, { timeout: 45000 });
      lap('create_chat_session');
      chatSessionId = cs?.data?.data?.chat_session_id || cs?.data?.chat_session_id;
      if (!chatSessionId) throw new Error('create_chat_session 未返回 chat_session_id: ' + JSON.stringify(cs).slice(0, 200));
    } else {
      lap('reuse_chat_session');
    }

    const mc = this.modelConfig(model);
    const customModel = {
      name: mc.name, display_name: mc.display_name, is_default: !!mc.is_default, multimodal: !!mc.multimodal,
      is_new: !!mc.is_new, is_beta: !!mc.is_beta, selectable: mc.selectable !== false,
      config_source: mc.config_source ?? 1, config_name: mc.name, provider: '', is_preset: true,
      client_connect: null, use_remote_service: true, ak: '', sk: null, base_url: '', auth_type: null,
      region: null, prompt_max_tokens: mc.prompt_max_tokens ?? 100000, model_type: mc.model_type || 'chat_model',
      builder: null, max_mode: true, is_max_default: null,
      ...(modelExtra && typeof modelExtra === 'object' ? modelExtra : {}),   // 调试用：override custom_model 字段（thinking_enable 等）
    };

    const sent = await this.aha._rpc('lite', 'send_message', {
      chat_session_id: chatSessionId,
      content: [],
      query: JSON.stringify([{ type: 'text', data: { content: prompt } }]),
      model_name: mc.name,
      agent_type: agentType,
      agent_id: agentId,
      model_selection_strategy: 'manual',
      custom_model: customModel,
      common_params: JSON.stringify({ message_source: 'manual' }),
      ...(extra && typeof extra === 'object' ? extra : {}),   // 调试用：透传额外字段（思考强度等）
    }, base, { timeout: 90000 });
    const d = sent?.data?.data || sent?.data || {};
    lap('send_message');
    const replyTo = d.message_id || d.user_message_id;
    if (!replyTo) throw new Error('send_message 未返回 message_id: ' + JSON.stringify(sent).slice(0, 200));

    // 逐事件解析：思考/正文都是"累计字符串"，需要做增量
    const seen = { think: new Map(), answer: new Map() };
    let streamId = null;
    let finished = false;
    let resolveDone;
    const donePromise = new Promise(r => { resolveDone = r; });

    // 看门狗改为"空闲超时"：只要上游还在往外吐事件就永远不掐断；
    // 连续 idleMs 没有任何上游事件才判定卡死。maxMs>0 时额外保留一个绝对上限（默认 0 = 不限）。
    // 阈值优先级：环境变量 > config.idle_timeout_ms > 600000（2026-11-24 支持配置，便于把卡死从 10 分钟缩到数分钟）
const idleMs = Number(process.env.TRAE2API_IDLE_TIMEOUT_MS || (this.cfg && this.cfg.idle_timeout_ms) || 600000);
    const maxMs = Number(process.env.TRAE2API_REQUEST_TIMEOUT_MS || 0);
    let idleTimer = null, maxTimer = null, lastEventAt = Date.now();
    const bumpIdle = () => {
      lastEventAt = Date.now();
      if (!idleMs) return;
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        if (finished) return;
        this.log('[watchdog] 连续 ' + idleMs + 'ms 无上游事件，判空闲超时（已收到过事件的时间跨度 ' + (Date.now() - T0) + 'ms）');
        resolveDone({ status: 'idle_timeout', chatSessionId, replyTo });
      }, idleMs);
    };
    if (maxMs > 0) maxTimer = setTimeout(() => {
      if (finished) return;
      this.log('[watchdog] 达到绝对上限 ' + maxMs + 'ms，强制结束');
      resolveDone({ status: 'timeout', chatSessionId, replyTo });
    }, maxMs);
    bumpIdle();

    const handle = ({ event, payload }) => {
      if (typeof bumpIdle === 'function') bumpIdle();
      if (event === 'plan_item') {
        const key = payload?.id || 'item';
        const rc = payload?.reasoning_content;
        if (typeof rc === 'string' && rc) {
          const prev = seen.think.get(key) || '';
          if (rc.length > prev.length) { onThinking && onThinking(rc.slice(prev.length)); seen.think.set(key, rc); }
        }
        // 正文：上游把答案增量放在 thought 里（实测 plan_item 每次带更长的累计文本），
        // 之前只认 tool_call_info.summary，导致整段答案在最后一次性吐出（TTFT=总耗时、TPS 爆表）。
        const k2 = 'ans:' + key;
        const th = payload?.thought;
        if (typeof th === 'string' && th) {
          const prev = seen.answer.get(k2) || '';
          if (th.length > prev.length) { onContent && onContent(th.slice(prev.length)); seen.answer.set(k2, th); }
        }
        const tc = payload?.tool_call_info;
        let ans = null;
        if (tc && (tc.name === 'finish' || tc.name === 'answer') && typeof tc.params?.summary === 'string') ans = tc.params.summary;
        if (payload?.content && typeof payload.content === 'string') ans = payload.content;
        if (ans) {
          const prev = seen.answer.get(k2) || '';
          if (ans.length > prev.length) {
            // 与已流的 thought 做前缀去重，避免尾部重复整段
            if (!prev || ans.startsWith(prev)) { onContent && onContent(ans.slice(prev.length)); }
            seen.answer.set(k2, ans);
          }
        }
      } else if (event === 'token_usage') {
        // 原样保留上游全部字段（含 input/output 金额、max_tokens 上下文上限、
        // cache_creation_input_tokens、*_tokens_total 等），只去掉内部包序号
        const { __packet_seq__, ...rawUsage } = payload || {};
        onUsage && onUsage({
          ...rawUsage,
          prompt_tokens: rawUsage.prompt_tokens ?? 0,
          completion_tokens: rawUsage.completion_tokens ?? 0,
          total_tokens: rawUsage.total_tokens ?? ((rawUsage.prompt_tokens || 0) + (rawUsage.completion_tokens || 0)),
          reasoning_tokens: rawUsage.reasoning_tokens ?? 0,
          cache_read_input_tokens: rawUsage.cache_read_input_tokens ?? 0,
          cache_creation_input_tokens: rawUsage.cache_creation_input_tokens ?? 0,
        });
      } else if (event === 'done') {
        finished = true;
        resolveDone({ status: payload?.status || 'completed', chatSessionId, replyTo });
      } else if (event === 'error') {
        finished = true;
        resolveDone({ error: payload });
      } else if (event === '__stream_end__') {
        if (!finished) resolveDone({ status: 'stream_end', chatSessionId, replyTo });
      }
    };

    const ack = await this.aha._rpc('lite', 'subscribe_events',
      { chat_session_id: chatSessionId, reply_to_message_id: replyTo }, base,
      { stream: true, onStream: handle, timeout: 60000 });
    streamId = ack.streamId;

    const result = await donePromise;
    clearTimeout(idleTimer); if (maxTimer) clearTimeout(maxTimer);
    if (streamId) this.aha.unregisterStream(streamId);
    return { ...result, chatSessionId, replyTo };
  }
}

module.exports = { TraeService, loadConfig, saveConfig, stripJsonc };















