// 极简 CDP 客户端（零依赖，用 Node 原生 WebSocket）
// 用途：驱动无头浏览器完成 Trae 网页登录，并把 Cookie 取回来
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

// 系统浏览器兜底清单（按平台）
const WIN_CANDS = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
];
const NIX_CANDS = [
  "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable", "/snap/bin/chromium",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
];

// 自带的 chrome-headless-shell（deploy/fetch-browser.cjs 下载到这里）
// 目录布局：<root>/<version>/<platform>/chrome-headless-shell[.exe]
function bundledCandidates() {
  const names = process.platform === "win32" ? ["chrome-headless-shell.exe"] : ["chrome-headless-shell"];
  const roots = [
    process.env.TRAE2API_BROWSER_DIR,
    process.env.TRAE2API_AHA_DIR ? path.join(process.env.TRAE2API_AHA_DIR, "..", "..", "browser") : null,
    path.join(__dirname, "..", "runtime", "browser"),
    path.join(os.homedir(), ".cache", "trae2api-browser"),
  ].filter(Boolean);
  const out = [];
  for (const root of roots) {
    let vers = [];
    try { vers = fs.readdirSync(root); } catch { continue; }
    vers = vers.filter((v) => /^\d+\.\d+\.\d+\.\d+$/.test(v) || v === "custom").sort().reverse();
    for (const v of vers) {
      let plats = [];
      try { plats = fs.readdirSync(path.join(root, v)); } catch { continue; }
      for (const p of plats) {
        for (const n of names) {
          const exe = path.join(root, v, p, n);
          try { if (fs.existsSync(exe)) out.push(exe); } catch {}
        }
      }
    }
  }
  return out;
}

// chrome-headless-shell 本身就是无头形态，不能再传 --headless=new
function isHeadlessShell(exe) {
  return /chrome-headless-shell/i.test(String(exe || ""));
}

// 启动参数（纯函数，便于测试）
function launchArgs({ exe, port, userDataDir, headless = true }) {
  const shell = isHeadlessShell(exe);
  const a = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-features=Translate,MediaRouter",
    "--disable-background-networking",
    "--disable-sync",
  ];
  if (headless) {
    if (!shell) a.push("--headless=new");
    a.push("--disable-gpu", "--hide-scrollbars");
  }
  // root / 容器里 Chromium 沙箱起不来；可用 TRAE_LOGIN_NO_SANDBOX=1 强制
  const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
  if (process.platform === "linux" && (process.env.TRAE_LOGIN_NO_SANDBOX === "1" || isRoot)) a.push("--no-sandbox");
  if (shell) a.push("--disable-dev-shm-usage");   // /dev/shm 小的容器里防崩
  a.push("about:blank");
  return a;
}

// 优先级：显式指定 → 自带 headless shell → 系统 Edge/Chrome/Chromium
function pickBrowser() {
  const explicit = process.env.TRAE_LOGIN_BROWSER || process.env.CDP_EXE;
  if (explicit) { try { if (fs.existsSync(explicit)) return explicit; } catch {} }
  const bundled = bundledCandidates();
  if (bundled.length) return bundled[0];
  const table = process.platform === "win32" ? WIN_CANDS : NIX_CANDS;
  for (const p of table) { try { if (fs.existsSync(p)) return p; } catch {} }
  return table[0];   // 都找不到时返回该平台首选路径，让报错可读
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class CdpBrowser {
  constructor({ exe, port, userDataDir, headless = true, log } = {}) {
    this.exe = exe || pickBrowser();
    this.port = port || 9333;
    this.userDataDir = userDataDir;
    this.headless = headless;
    this.log = log || (() => {});
    this.seq = 0;
    this.pending = new Map();
    this.sessions = new Map();
    this.proc = null;
    this.ws = null;
  }

  async launch() {
    fs.mkdirSync(this.userDataDir, { recursive: true });
    const args = launchArgs({ exe: this.exe, port: this.port, userDataDir: this.userDataDir, headless: this.headless });
    this.log("[cdp] 启动 " + path.basename(this.exe) + (isHeadlessShell(this.exe) ? "（headless shell）" : ""));
    this.proc = spawn(this.exe, args, { stdio: "ignore", windowsHide: true });
    this.proc.on("error", (e) => this.log("[cdp] 启动失败: " + e.message));

    // 等调试端口就绪
    const t0 = Date.now();
    let ver = null;
    while (Date.now() - t0 < 20000) {
      try {
        const r = await fetch(`http://127.0.0.1:${this.port}/json/version`, { signal: AbortSignal.timeout(1500) });
        if (r.ok) { ver = await r.json(); break; }
      } catch {}
      await sleep(250);
    }
    if (!ver) throw new Error("浏览器调试端口未就绪（" + path.basename(this.exe) + " port=" + this.port + "）");
    this.log("[cdp] 浏览器就绪: " + (ver.Browser || "").slice(0, 40));

    this.ws = new WebSocket(ver.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      this.ws.addEventListener("open", resolve, { once: true });
      this.ws.addEventListener("error", () => reject(new Error("CDP WebSocket 连接失败")), { once: true });
    });
    this.ws.addEventListener("message", (ev) => this._onMessage(ev.data));
    return this;
  }

  // 接管一个已经在跑、已开调试端口的浏览器（不重新启动）
  async attach() {
    let ver = null;
    try {
      const r = await fetch(`http://127.0.0.1:${this.port}/json/version`, { signal: AbortSignal.timeout(2000) });
      if (r.ok) ver = await r.json();
    } catch {}
    if (!ver) return false;
    this.ws = new WebSocket(ver.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      this.ws.addEventListener("open", resolve, { once: true });
      this.ws.addEventListener("error", () => reject(new Error("CDP WebSocket 连接失败")), { once: true });
    });
    this.ws.addEventListener("message", (ev) => this._onMessage(ev.data));
    this.log("[cdp] 已接管现有浏览器: " + (ver.Browser || "").slice(0, 30));
    return true;
  }

  // 接管一个已存在的标签页（按 URL 正则匹配），返回 sessionId
  async attachPage(matchRe = /trae\.cn|accounts\.doubao\.com/) {
    const list = await fetch(`http://127.0.0.1:${this.port}/json`, { signal: AbortSignal.timeout(2000) }).then((r) => r.json()).catch(() => []);
    const hit = (list || []).find((t) => t.type === "page" && matchRe.test(t.url || ""));
    if (!hit) return null;
    const res = await this.send("Target.attachToTarget", { targetId: hit.id, flatten: true });
    this.log("[cdp] 已接管标签页: " + String(hit.url).slice(0, 60));
    return res.sessionId;
  }

  _onMessage(data) {
    let msg; try { msg = JSON.parse(typeof data === "string" ? data : Buffer.from(data).toString("utf8")); } catch { return; }
    if (msg.id && this.pending.has(msg.id)) {
      const { resolve, reject, timer } = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      clearTimeout(timer);
      if (msg.error) reject(new Error(msg.error.message || "CDP error"));
      else resolve(msg.result);
      return;
    }
    const h = this.events && this.events.get(msg.method);
    if (h) h(msg.params || {}, msg.sessionId);
  }

  on(method, handler) {
    if (!this.events) this.events = new Map();
    this.events.set(method, handler);
  }

  send(method, params = {}, sessionId = undefined, timeout = 20000) {
    return new Promise((resolve, reject) => {
      const id = ++this.seq;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error("CDP 超时: " + method)); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      const payload = { id, method, params };
      if (sessionId) payload.sessionId = sessionId;
      try { this.ws.send(JSON.stringify(payload)); } catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e); }
    });
  }

  // 新建标签页并 attach，返回 sessionId
  // 开启网络捕获：只记 cloudide/passport 相关，供登录流程排障
  async captureApiRequests(sessionId, patterns = ["cloudide/api", "passport", "sso-callback"]) {
    this.networkLog = [];
    try { await this.send("Network.enable", {}, sessionId); } catch {}
    this.on("Network.requestWillBeSent", (p) => {
      try {
        const url = p?.request?.url || "";
        if (!patterns.some((k) => url.includes(k))) return;
        const hdrs = p.request.headers || {};
        const auth = hdrs.Authorization || hdrs.authorization || null;
        const cookie = hdrs.Cookie || hdrs.cookie || null;
        this.networkLog.push({
          at: Date.now(),
          method: p.request.method,
          url: url.length > 300 ? url.slice(0, 300) + "…" : url,
          auth: auth ? String(auth).slice(0, 40) + "…(" + String(auth).length + ")" : null,
          cookieNames: cookie ? String(cookie).split(/;\s*/).map((x) => x.split("=")[0]).join(",") : null,
          postData: p.request.postData ? String(p.request.postData).slice(0, 300) : null,
        });
        if (this.networkLog.length > 60) this.networkLog.shift();
      } catch {}
    });
    this.on("Network.responseReceived", (p) => {
      try {
        const url = p?.response?.url || "";
        if (!patterns.some((k) => url.includes(k))) return;
        const last = this.networkLog[this.networkLog.length - 1];
        if (last && !last.status) last.status = p.response.status;
      } catch {}
    });
    return this.networkLog;
  }

  async newPage(url = "about:blank") {
    const { targetId } = await this.send("Target.createTarget", { url });
    const { sessionId } = await this.send("Target.attachToTarget", { targetId, flatten: true });
    this.sessions.set(sessionId, targetId);
    this.targetId = targetId;
    await this.send("Page.enable", {}, sessionId);
    await this.send("Runtime.enable", {}, sessionId);
    return sessionId;
  }

  async navigate(sessionId, url, waitMs = 2000) {
    await this.send("Page.navigate", { url }, sessionId);
    await sleep(waitMs);
  }

  // 在指定 URL 的 iframe 里求值（豆包登录表单渲染在 accounts.doubao.com/accounts/page/* 的 iframe 内）
  async evaluateInFrame(sessionId, urlPattern, expression, timeout = 15000) {
    const tree = await this.send("Page.getFrameTree", {}, sessionId, timeout).catch(() => null);
    if (!tree) return null;
    const re = urlPattern instanceof RegExp ? urlPattern : new RegExp(urlPattern);
    let hit = null;
    const walk = (n) => {
      const f = n.frame;
      if (!hit && f && re.test(f.url || "")) hit = f;
      (n.childFrames || []).forEach(walk);
    };
    walk(tree.frameTree);
    if (!hit) return null;
    const world = await this.send("Page.createIsolatedWorld", { frameId: hit.id, worldName: "t2a-eval", grantUniveralAccess: true }, sessionId, timeout).catch(() => null);
    if (!world || !world.executionContextId) return null;
    const res = await this.send("Runtime.evaluate", { expression, contextId: world.executionContextId, returnByValue: true, awaitPromise: true }, sessionId, timeout);
    return res && res.result ? res.result.value : null;
  }

  async evaluate(sessionId, expression, timeout = 15000) {
    const r = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sessionId, timeout);
    if (r.exceptionDetails) throw new Error("页面脚本异常: " + (r.exceptionDetails.text || "").slice(0, 120));
    return r.result?.value;
  }

  // 往当前焦点插入文本（可穿透 iframe；豆包验证码输入框在 iframe 里，DOM 取不到）
  async insertText(sessionId, text) {
    await this.send("Input.insertText", { text: String(text) }, sessionId);
    return true;
  }

  // 按键（单个字符或特殊键）
  async pressKey(sessionId, key, code, keyCode, text) {
    const base = { key, code: code || key, windowsVirtualKeyCode: keyCode || 0, nativeVirtualKeyCode: keyCode || 0 };
    await this.send("Input.dispatchKeyEvent", Object.assign({ type: text ? "keyDown" : "rawKeyDown" }, base, text ? { text } : {}), sessionId);
    await this.send("Input.dispatchKeyEvent", Object.assign({ type: "keyUp" }, base), sessionId);
    return true;
  }

  async screenshot(sessionId, format = "png") {
    const r = await this.send("Page.captureScreenshot", { format }, sessionId, 25000);
    return Buffer.from(r.data, "base64");
  }

  // 截取某个元素（用于把二维码截出来）
  async screenshotElement(sessionId, selector) {
    const box = await this.evaluate(sessionId, `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    })()`);
    if (!box || !box.width) return null;
    const r = await this.send("Page.captureScreenshot", {
      format: "png",
      clip: { x: box.x, y: box.y, width: box.width, height: box.height, scale: 2 },
    }, sessionId, 25000);
    return Buffer.from(r.data, "base64");
  }

  async cookies(urls) {
    // 优先用浏览器级 Storage.getCookies（不需要 Network.enable）
    try {
      const all = await this.send("Storage.getCookies", {});
      const list = all.cookies || [];
      if (!urls || !urls.length) return list;
      const hosts = urls.map((u) => { try { return new URL(u).hostname; } catch { return ""; } }).filter(Boolean);
      return list.filter((c) => hosts.some((h) => (c.domain || "").replace(/^\./, "").endsWith(h.replace(/^www\./, "")) || h.endsWith((c.domain || "").replace(/^\./, ""))));
    } catch {
      try { await this.send("Network.enable", {}); } catch {}
      const r = await this.send("Network.getCookies", { urls });
      return r.cookies || [];
    }
  }

  // 清掉指定 origin 的站点数据（cookie / localStorage / IndexedDB…）。
  // 用于「保留持久 profile 省冷启动，但不继承上一次登录态」。
  async clearSite(origins) {
    const done = [];
    for (const origin of origins || []) {
      try {
        await this.send("Storage.clearDataForOrigin", { origin, storageTypes: "all" });
        done.push(origin);
      } catch {}
    }
    return done;
  }

  close() {
    try { this.ws && this.ws.close(); } catch {}
    try { this.proc && this.proc.kill(); } catch {}
  }
}

module.exports = { CdpBrowser, sleep, pickBrowser, bundledCandidates, isHeadlessShell, launchArgs };
