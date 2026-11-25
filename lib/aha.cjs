// aha.cjs —— 本地 Aha IPC 客户端（ZeroMQ DEALER over ipc://）
// 协议要点（实测）：packet = {version:1,id,packet_type:"user"|"control",payload}
//   首包 id 必须为空（服务端校验 packet.id === 自身 id，空值放行），回包 id 即服务端身份
//   收到 __C_PING__ 必须回 __C_PONG__，否则被踢
//   RPC: JSON-RPC over user packet；request / request_stream
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const HOME = os.homedir();
// 可用环境变量指向别处（自建独立 ai-agent 时用）
const AHA_DIR = process.env.TRAE2API_AHA_DIR || path.join(HOME, '.marscode', 'server-main', 'aha');
const BASE_RESP = { status_code: 0, status_message: 'success' };
const OPT = { routingId: 5, heartbeatInterval: 75, heartbeatTimeToLive: 76, heartbeatTimeout: 77 };

// zmq 原生 addon（.node）的位置随平台与部署方式不同，按优先级探测：
//   ① 显式参数 / TRAE2API_AHA_ADDON
//   ② 运行时自带：<root>/aiserver/(zmq|index).<平台>-<arch>.node      ← VSIX 的 linux/darwin 包是这种布局
//   ③ 运行时 prebuild：<root>/aiserver/prebuild/<os>/<arch>/node/<toolchain>/addon.node
//   ④ 桌面 VS Code / code-server 扩展目录（按版本倒序取最新）
const TOOLCHAINS = ['msvc-115-Release', 'msvc-72-Release', 'glibc-127-Release', 'glibc-115-Release', 'musl-127-Release', 'libc-115-Release', 'Release', ''];

// 列出 prebuild/<os>/<arch>/node/*/addon.node（toolchain 目录名随平台/ABI 变化，动态扫更稳）
function prebuildAddons(baseDir, platform, arch) {
  const out = [];
  const nodeDir = path.join(baseDir, 'prebuild', platform, arch, 'node');
  try {
    for (const tc of fs.readdirSync(nodeDir)) {
      const p = path.join(nodeDir, tc, 'addon.node');
      if (fs.existsSync(p)) out.push(p);
    }
  } catch {}
  const direct = path.join(nodeDir, 'addon.node');
  if (fs.existsSync(direct)) out.push(direct);
  return out;
}

function addonCandidates(explicit, platform = process.platform, arch = process.arch) {
  const out = [];
  const push = (p) => { if (p && !out.includes(p)) out.push(p); };
  push(explicit || process.env.TRAE2API_AHA_ADDON);

  // 运行时根：AHA_DIR 形如 <root>/aha/aha
  const rtRoot = path.resolve(AHA_DIR, '..', '..');
  const serverDir = path.join(rtRoot, 'aiserver');

  // ② 运行时自带的 prebuild addon（zeromq 就是它；Windows/Linux 布局一致，toolchain 名不同）
  for (const p of prebuildAddons(serverDir, platform, arch)) push(p);

  // ③ 运行时根目录下的平台 .node（index.<os>-<arch>[-gnu|-msvc].node 之类，作兜底）
  try {
    for (const f of fs.readdirSync(serverDir)) {
      if (!/^(zmq|index)\..*\.node$/.test(f)) continue;
      if (f.includes(platform)) push(path.join(serverDir, f));
    }
  } catch {}

  // ④ 桌面扩展目录
  for (const extRoot of [path.join(HOME, '.vscode', 'extensions'), path.join(HOME, '.vscode-server', 'extensions')]) {
    const versioned = [];
    try {
      for (const name of fs.readdirSync(extRoot)) {
        if (!name.startsWith('marscode.marscode-extension-')) continue;
        const base = path.join(extRoot, name, 'resource', 'aiserver');
        const dyn = prebuildAddons(base, platform, arch);
        for (const p of dyn) versioned.push({ name, p });
        for (const rel of [`zmq.${platform}-${arch}.node`, `index.${platform}-${arch}.node`, `index.${platform}-${arch}-gnu.node`, `index.${platform}-${arch}-msvc.node`]) {
          const p = path.join(base, rel);
          if (fs.existsSync(p)) versioned.push({ name, p });
        }
      }
    } catch {}
    versioned.sort((a, b) => {
      const va = a.name.replace('marscode.marscode-extension-', '').split('.').map(Number);
      const vb = b.name.replace('marscode.marscode-extension-', '').split('.').map(Number);
      for (let i = 0; i < 3; i++) { if ((va[i] || 0) !== (vb[i] || 0)) return (vb[i] || 0) - (va[i] || 0); }
      return 0;
    });
    for (const v of versioned) push(v.p);
  }

  return out;
}

function findAddon(explicit) {
  for (const c of addonCandidates(explicit)) {
    try { if (fs.existsSync(c)) return c; } catch {}
  }
  throw new Error('找不到 zmq 原生模块（' + process.platform + '-' + process.arch +
    '）：可用 TRAE2API_AHA_ADDON 显式指定 .node 路径');
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// 选"活的"套接字：.ready 里记录的 pid 必须存活（旧的 .sock 文件会留在磁盘上，连上去是死端）
function latestSocket(prefix = process.env.TRAE2API_AHA_PREFIX || 'vscode_ai_agent_') {
  const files = fs.readdirSync(AHA_DIR).filter(f => f.startsWith(prefix) && f.endsWith('.sock'));
  if (!files.length) throw new Error('没有找到 ' + prefix + '*.sock（桌面 VS Code 里的 Trae 是否在运行？）');
  const scored = files.map(f => {
    let t = 0, pid = 0, alive = false;
    try {
      pid = Number(fs.readFileSync(path.join(AHA_DIR, f + '.ready'), 'utf8').trim());
      alive = pidAlive(pid);
      t = fs.statSync(path.join(AHA_DIR, f + '.ready')).mtimeMs;
    } catch {}
    return { f, t, pid, alive };
  });
  const aliveList = scored.filter(s => s.alive).sort((a, b) => b.t - a.t);
  const pick = aliveList[0] || scored.sort((a, b) => b.t - a.t)[0];
  return path.join(AHA_DIR, pick.f);
}

// 多通道候选：扩展拉起的 agent 与我们自建的独立 agent 各有一套 socket。
// 只按单一目录找会因为"目录里最新那个是死 socket"而误连（2026-11-20 事故）。
function candidateSockets() {
  const HOME_ = require('os').homedir();
    const EXT_DIR = path.join(HOME_, '.marscode', 'server-main', 'aha');
  const dirs = [];
  const seen = new Set();
  const push = (dir, prefix) => {
    const tag = prefix.indexOf('standalone') >= 0 ? 'standalone' : 'extension';
    const k = dir + '|' + prefix;
    if (seen.has(k)) return;
    seen.add(k);
    dirs.push({ dir, prefix, tag });
  };
  // AHA_DIR 若被显式改到别处，也要把默认扩展目录纳入
  if (AHA_DIR !== EXT_DIR) push(AHA_DIR, process.env.TRAE2API_AHA_PREFIX || 'vscode_ai_agent_');
  push(EXT_DIR, 'vscode_ai_agent_');
  const pref = String(process.env.TRAE2API_AGENT_PREF || 'extension').split(',').map(x => x.trim());
  dirs.sort((a, b) => {
    const ia = pref.indexOf(a.tag), ib = pref.indexOf(b.tag);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
  const out = [];
  for (const d of dirs) {
    let files = [];
    try { files = fs.readdirSync(d.dir).filter(f => f.startsWith(d.prefix) && f.endsWith('.sock')); } catch { continue; }
    const scored = files.map(f => {
      let pid = 0, alive = false, t = 0;
      try {
        pid = Number(fs.readFileSync(path.join(d.dir, f + '.ready'), 'utf8').trim());
        alive = pidAlive(pid);
        t = fs.statSync(path.join(d.dir, f + '.ready')).mtimeMs;
      } catch {}
      return { file: path.join(d.dir, f), tag: d.tag, pid, alive, t };
    });
    // 先放存活的（新的优先），再放死的一批（仅作最后尝试）
    scored.filter(x => x.alive).sort((a, b) => b.t - a.t).forEach(x => out.push(x));
    scored.filter(x => !x.alive).sort((a, b) => b.t - a.t).forEach(x => out.push(x));
  }
  return out;
}

function parseCommandArgs(args) {
  if (args == null) return {};
  let v = Array.isArray(args) ? args[0] : args;
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch { return {}; } }
  return v && typeof v === 'object' ? v : {};
}

/**
 * 代替扩展回答 ai-agent 的查询类命令。
 * 独立启动（没有 VS Code 扩展）时，这些命令本该由扩展答复；不答的话每条要等 ~3 秒超时，
 * 一次对话能拖到 60 秒（实测）。AB 测试一律回 defaultValue（等于"未配置"），
 * 配置项回 null，目录列表回空 —— 目的只是让纯对话跑得快，不需要伪造更多语义。
 */
// 已知配置键的确定答案（上游实测会问这两个；新增键请加到这里）
const CONFIG_ANSWERS = {
  'AI.skills.enableAgentsDir': false,
  'AI.skills.enablePeerProductSkills': false,
  'AI.skills.enableAgentSkills': false,
};
let moduleLog = () => {};   // 由 AhaClient 构造函数绑定，便于在 answerCommand 里留痕
function answerMode() {
  const v = String(process.env.TRAE2API_ANSWER_COMMANDS || '').trim().toLowerCase();
  if (v === 'poll') return 'poll';
  if (v === '1' || v === 'on' || v === 'true' || v === 'all') return 'all';
  return 'off';
}
// mode: 'all'（全部代答）| 'poll'（只答轮询类，安全）| 其它（不答）
const POLL_COMMANDS = new Set([
  'icube.common.getDynamicConfig',
  'icube.event.getABTestConfigByKey',
]);
function answerCommand(cmdId, args, mode = 'all') {
  if (mode === 'poll' && !POLL_COMMANDS.has(cmdId)) return null;
  const a = parseCommandArgs(args);
  const V = (value) => ({ handled: true, value });
  switch (cmdId) {
    case 'icube.event.getABTestConfigByKey':
      return V(a.defaultValue !== undefined ? a.defaultValue : null);
    case 'icube.common.getDynamicConfig':
      return V({});
    case 'icube.common.commands.tooling.getConfigurationValue': {
      // 已知键走显式表；未知键先留痕再兜底（2026-11-24 收紧，避免 /skills/i 全串误命中）
      const key = String(a.key || a.section || '');
      if (Object.prototype.hasOwnProperty.call(CONFIG_ANSWERS, key)) {
        moduleLog('[aha] 配置键 ' + key + ' → ' + JSON.stringify(CONFIG_ANSWERS[key]) + '（已知键）');
        return V(CONFIG_ANSWERS[key]);
      }
      if (/^AI\.skills\./i.test(key)) {
        moduleLog('[aha] 配置键 ' + key + ' → false（未登记的 skills 键，按关闭兜底）');
        return V(false);
      }
      if (/^AI\.auto_?run\./i.test(key)) {
        moduleLog('[aha] 配置键 ' + key + ' → false（未登记的 autoRun 键，按关闭兜底）');
        return V(false);
      }
      moduleLog('[aha] 配置键 ' + key + ' → null（未知键，回未设置）');
      return V(null);
    }
    case 'icube.common.commands.tooling.listFolder':
      return V([]);
    case 'icube.common.commands.tooling.getRulesDetails':
      return V({ rules: [] });
    case 'icube.common.commands.tooling.filePathSensitiveOrNot':
      return V({ sensitive: false, isSensitive: false });
    case 'icube.common.commands.tooling.getAutoRunConfig':
      return V({ autoRun: false, enableAutoRun: false });
    case 'icube.common.commands.tooling.getAllAgentExtensions':
      return V({ extensions: [] });
    case 'icube.common.commands.tooling.getActiveRuntimeEnvironmentList':
      return V({ environments: [] });
    default:
      return null;   // null = 真的不知道怎么答 → 回 unsupported
  }
}

class AhaClient {
  constructor(opts = {}) {
    this.log = opts.log || (() => {});
    moduleLog = this.log;
    this.addonPath = opts.addonPath;
    this.connected = false;
    this.serverId = null;
    this.seq = 0;
    this.pending = new Map();      // rpc id -> {resolve, reject, timer}
    this.streams = new Map();      // streamId -> handler
    this.closing = false;
    this._connectPromise = null;
  }

  _loadZmq() {
    if (!this.zmq) {
      const { Context, Socket } = require(findAddon(this.addonPath));
      this.zmq = { Context, Socket };
      this.ctx = new this.zmq.Context();
    }
    return this.zmq;
  }

  async _discover(target) {
    const addr = 'ipc://' + (target || latestSocket());
    const { Socket } = this._loadZmq();
    const sock = new Socket(5, this.ctx);          // ZMQ_DEALER
    sock.setStringOption(OPT.routingId, 'trae2api-' + crypto.randomUUID().slice(0, 8));
    sock.setInt32Option(OPT.heartbeatInterval, 1000);
    sock.setInt32Option(OPT.heartbeatTimeToLive, 3000);
    sock.setInt32Option(OPT.heartbeatTimeout, 3000);
    await sock.connect(addr);
    this.sock = sock;
    this.addr = addr;
    this.serverId = null;
    this.log('[aha] 连接 ' + addr);
  }

  // 用临时 socket 试一次握手；成功返回 true
  async _probe(addr, ms = 4000) {
    let sock = null;
    try {
      const { Socket } = this._loadZmq();
      sock = new Socket(5, this.ctx);
      sock.setStringOption(OPT.routingId, 'trae2api-probe-' + crypto.randomUUID().slice(0, 6));
      sock.setInt32Option(OPT.heartbeatInterval, 1000);
      sock.setInt32Option(OPT.heartbeatTimeToLive, 3000);
      sock.setInt32Option(OPT.heartbeatTimeout, 3000);
      await sock.connect('ipc://' + addr);
      let got = null;
      sock.on('message', (buf) => {
        try {
          const pkt = JSON.parse(buf.toString('utf8'));
          if (pkt && pkt.id) got = pkt.id;
        } catch {}
      });
      sock.send(JSON.stringify({ version: 1, id: '', packet_type: 'control', payload: '__C_PING__' }));
      const t0 = Date.now();
      while (!got && Date.now() - t0 < ms) await new Promise(r => setTimeout(r, 50));
      return !!got;
    } catch { return false; }
    finally { try { sock && sock.close(); } catch {} }
  }

  async connect() {
    if (this.connected) return;
    if (this._connectPromise) return this._connectPromise;
    this._connectPromise = (async () => {
      try {
        this.serverId = null;   // 重连时必须重新握手（旧 serverId 会让新连接所有请求被丢弃）
        this.lastPong = Date.now();
        // 只连"活着"的 socket（.ready 里的 pid 必须存活）。死 socket 连上去就是握手超时，
        // 必须显式报 AGENT_OFFLINE，而不是悄悄回落到最新那个死端（2026-11-20 事故）。
        const cands = candidateSockets().filter(c => c.alive);
        this.log('[aha] 存活候选 ' + cands.length + ' 个: ' + cands.map(c => c.tag + ':' + path.basename(c.file)).join(', '));
        if (!cands.length) {
          const all = candidateSockets();
          const err = new Error('没有存活的 ai-agent（' + all.length + ' 个 socket 全部对应的进程已退出）：' + all.map(c => path.basename(c.file)).join(', '));
          err.code = 'AGENT_OFFLINE';
          throw err;
        }
        const picked = cands[0];
        this.log('[aha] 选中通道 ' + picked.tag + ' → ' + path.basename(picked.file));
        await this._discover(picked.file);
        this._loop();
        // 首包：id 为空的控制帧
        this._send({ version: 1, id: '', packet_type: 'control', payload: '__C_PING__' });
        const t0 = Date.now();
        while (!this.serverId && Date.now() - t0 < 5000) await new Promise(r => setTimeout(r, 50));
        if (!this.serverId) throw new Error('握手超时：未拿到 serverId');
        this.connected = true;
        this.log('[aha] 握手成功 serverId=' + this.serverId.slice(0, 8));
        this._startKeepalive();
      } finally {
        this._connectPromise = null;
      }
    })();
    return this._connectPromise;
  }


  // 每 15s 发一次控制帧 PING；超过 45s 没收到 PONG 就认为连接已死（ai-agent 重启后 socket 会静默失效）
  _startKeepalive() {
    if (this._kaTimer) return;
    this._kaTimer = setInterval(() => {
      if (!this.sock) { this._dropConnection('socket 已空'); return; }
      if (Date.now() - (this.lastPong || 0) > 45000) { this._dropConnection('45s 无 PONG'); return; }
      try { this._send({ version: 1, id: this.serverId || '', packet_type: 'control', payload: '__C_PING__' }); } catch (e) { this._dropConnection('PING 发送失败: ' + e.message); }
    }, 15000);
    if (this._kaTimer.unref) this._kaTimer.unref();
  }

  _dropConnection(reason) {
    if (!this.connected && !this.sock) return;
    this.log('[aha] 连接失效（' + reason + '），下次请求重连');
    this.connected = false;
    this.serverId = null;
    try { this.sock?.close(); } catch {}
    this.sock = null;
    // 断链后立刻让在飞 RPC 失败：否则它们各自要等满 RPC 超时才报错（用户看到的是「卡住」）
    if (this.pending && this.pending.size) {
      const n = this.pending.size;
      for (const [id, p] of [...this.pending.entries()]) {
        this.pending.delete(id);
        try { clearTimeout(p.timer); } catch {}
        try { p.reject(new Error('AHA 连接已断开（' + reason + '）')); } catch {}
      }
      this.log('[aha] 已让 ' + n + ' 个在飞 RPC 立即失败');
    }
  }
  _send(obj) {
    if (!this.sock) throw new Error('socket 未连接');
    this.sock.send(JSON.stringify(obj));
  }

  _sendRpcOnce(rpc, channelId) {
    const payload = JSON.stringify(rpc);
    this._send({ version: 1, id: this.serverId || '', packet_type: 'user', payload });
    return channelId;
  }

  async _loop() {
    const sock = this.sock;
    try {
      for (;;) {
        const frames = await sock.receive();
        const txt = frames[frames.length - 1].toString('utf8');
        let p; try { p = JSON.parse(txt); } catch { continue; }
        if (p.id && !this.serverId) this.serverId = p.id;

        if (p.packet_type === 'control') {
          this.lastPong = Date.now();   // 任何入站帧都视为链路存活
        if (p.payload === '__C_PING__') {
            try { this._send({ version: 1, id: this.serverId || '', packet_type: 'control', payload: '__C_PONG__' }); } catch {}
          }
          continue;
        }
        let inner; try { inner = JSON.parse(p.payload); } catch { continue; }
        if (process.env.TRAE2API_AHA_DEBUG === '1') {
          try {
            if (inner.method !== 'execute_command') {
              this.log('[aha/method] ' + String(inner.method || '(none)') + ' | ' + JSON.stringify(inner.params || inner).slice(0, 220));
            }
            if (inner.method === 'execute_command') {
              const r = (inner.params && inner.params[0]) || {};
              const pr = r.params || {};
              this.log('[aha/cmd] ' + String(pr.command_id || '?') + ' | args=' + JSON.stringify(pr.args || null).slice(0, 500));
            }
          } catch {}
        }

        // 服务端反向请求（执行命令等）
        if (inner.method === 'execute_command') {
          const req = inner.params?.[0] || {};
          const cmdId = req.params?.command_id || '?';
          const args = req.params?.args || null;
          // 调试开关：TRAE2API_ANSWER_COMMANDS=1 时由网关代答平台查询（默认关，交给 aiserver 回答）
          const __mode = answerMode();
        const ans = __mode === 'off' ? null : answerCommand(cmdId, args, __mode);
          if (ans && ans.handled) {
            const answer = ans.value;
            this.log('[aha] ← execute_command: ' + cmdId + ' → 已答复 ' + JSON.stringify(answer).slice(0, 90));
            try {
              this._send({
                version: 1, id: this.serverId, packet_type: 'user',
                payload: JSON.stringify({
                  jsonrpc: '2.0', id: inner.id,
                  result: { base_resp: BASE_RESP, packet_type: 'response', channel_id: req.channel_id, session_id: req.session_id,
                            params: { base_resp: BASE_RESP, code: 0, message: 'success', data: answer } },
                }),
              });
            } catch {}
            continue;
          }
          this.log('[aha] ← execute_command: ' + cmdId + ' args=' + JSON.stringify(args || null).slice(0, 160));
          try {
            this._send({
              version: 1, id: this.serverId, packet_type: 'user',
              payload: JSON.stringify({
                jsonrpc: '2.0', id: inner.id,
                result: { packet_type: 'response', channel_id: req.channel_id, session_id: req.session_id,
                          params: { code: -1, message: 'unsupported by trae2api', data: null } },
              }),
            });
          } catch {}
          continue;
        }

        // 普通响应
        if (inner.result) {
          const r = inner.result;
          const waiter = this.pending.get(String(inner.id));
          if (waiter) {
            this.pending.delete(String(inner.id));
            clearTimeout(waiter.timer);
            if (r.streamId) waiter.resolve({ streamId: r.streamId });
            else waiter.resolve(r.params);
            continue;
          }
          if (r.streamId) continue;
          continue;
        }

        // 流事件
        const streamId = inner.params?.streamId || (inner.method && inner.method.startsWith('rpc.stream.') ? inner.method.slice('rpc.stream.'.length) : null);
        const h = streamId && this.streams.get(streamId);
        if (h) {
          const ev = inner.params?.data?.params?.data?.data;
          if (ev?.event) h({ event: ev.event, payload: ev.payload });
          else if (inner.params?.data === null) h({ event: '__stream_end__', payload: null });
        }
      }
    } catch (e) {
      if (!this.closing) {
        this.log('[aha] 接收循环中断: ' + e.message);
        this.connected = false;
        this.sock = null;
      }
    }
  }

  async _rpc(service, method, data, baseParams, opts = {}) {
    // 断线（ai-agent 重启/与 Trae 宿主一起退出）时自动重连一次
    if (!this.sock) this.connected = false;
    try {
      return await this._rpcOnce(service, method, data, baseParams, opts);
    } catch (e) {
      // 超时：不重试（避免 send_message 重复投递），但必须把连接标记为失效，
      // 否则死连接会一直复用、后续每个请求都超时
      if (/超时/.test(e.message)) {
        this.connected = false;
        this.serverId = null;
        try { this.sock?.close(); } catch {}
        this.sock = null;
        this.log('[aha] RPC 超时，连接已标记失效（下一个请求重连）: ' + e.message);
        throw e;
      }
      this.connected = false;
      try { this.sock?.close(); } catch {}
      this.sock = null;
      this.log('[aha] RPC 失败，重连后重试: ' + e.message);
      return await this._rpcOnce(service, method, data, baseParams, opts);
    }
  }

  async _rpcOnce(service, method, data, baseParams, { stream = false, timeout = 30000, onStream } = {}) {
    await this.connect();
    const id = String(++this.seq);
    const channel = crypto.randomUUID();
    const params = {
      service, method,
      data: data === undefined ? '' : (typeof data === 'string' ? data : JSON.stringify(data)),
      user_info: baseParams.user_info,
      common_params: baseParams.common_params,
      streamlined_common_params: baseParams.common_params,
      client_info: baseParams.client_info,
    };
    const rpc = {
      jsonrpc: '2.0', method: stream ? 'request_stream' : 'request', id,
      params: [{ packet_type: 'request', channel_id: channel, session_id: baseParams.session_id, params }],
    };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`RPC 超时 ${service}/${method}`));
      }, timeout);
      this.pending.set(id, {
        resolve: (res) => {
          if (stream && res.streamId) {
            if (onStream) this.streams.set(res.streamId, onStream);
            resolve(res);
          } else resolve(res);
        },
        reject,
        timer,
      });
      try { this._sendRpcOnce(rpc, channel); } catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e); }
    });
  }

  unregisterStream(streamId) { this.streams.delete(streamId); }

  close() {
    this.closing = true;
    try { this.sock?.close(); } catch {}
  }
}

module.exports = {
  answerMode, AhaClient, latestSocket, candidateSockets, findAddon, addonCandidates, OPT, answerCommand, CONFIG_ANSWERS };









