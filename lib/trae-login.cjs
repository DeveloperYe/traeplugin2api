// Trae 网页登录（无 VS Code）：无头 Edge 打开登录页 → 扫码 → 取 Cookie
// → GetRefreshToken → ExchangeToken → 写 jwt.txt（供 ai-agent 使用）
const fs = require("fs");
const os = require("os");
const path = require("path");
const { CdpBrowser, sleep } = require("./cdp.cjs");
const { OAUTH, readClientSecrets, saveTokenCache } = require("./creds.cjs");

const LOGIN_URL = "https://www.trae.cn/login?redirect=https%3A%2F%2Fwww.trae.cn%2F";
const API = (OAUTH && OAUTH.cn && OAUTH.cn.host) || "https://api.trae.com.cn";
const CLIENT_ID = (OAUTH && OAUTH.cn && OAUTH.cn.clientId) || "368953x60ky286";
const QR_SELECTORS = ['img[alt="扫码登录"]', 'img[alt*="扫码"]', "canvas"];
// 登录链路上会写状态的站点（清站点数据时用）
const SITE_ORIGINS = ["https://www.trae.cn", "https://trae.cn", "https://api.trae.com.cn", "https://accounts.doubao.com"];

class TraeLogin {
  /**
   * @param {object} o
   * @param {string} o.profileDir  运行时 profile（jwt.txt 写到这里）
   * @param {function} o.log
   * @param {function} o.onNeedRestart 写完后要求重启运行时的回调
   */
  constructor({ profileDir, log, onNeedRestart } = {}) {
    this.profileDir = profileDir || path.join(os.homedir(), ".marscode");
    // 浏览器配置目录策略：
    //   TRAE_LOGIN_PROFILE=<dir>  → 完全自定义（持久，不清 cookie，交给你管）
    //   TRAE_LOGIN_KEEP_PROFILE=1 → 持久用 data/login-profile（省冷启动），但登录前清站点数据
    //   默认                      → 每次一个一次性临时目录，登录结束即删除
    this.persistentDir = process.env.TRAE_LOGIN_PROFILE
      || (process.env.TRAE_LOGIN_KEEP_PROFILE === "1" ? path.join(__dirname, "..", "data", "login-profile") : null);
    this.tempProfile = null;
    this.log = log || (() => {});
    this.onNeedRestart = onNeedRestart;
    this.state = "idle";
    this.error = null;
    this.userInfo = null;
    this.qrPng = null;
    this.startedAt = 0;
    this.browser = null;
    this.sessionId = null;
    this.busy = false;
  }

  status() {
    return {
      state: this.state,
      error: this.error,
      userInfo: this.userInfo,
      startedAt: this.startedAt,
      profile: this.profileDir,
      hasQr: !!this.qrPng,
    };
  }

  get qrDataUrl() {
    return this.qrPng ? "data:image/png;base64," + this.qrPng.toString("base64") : null;
  }

  async start() {
    if (this.busy) throw new Error("登录流程正忙");
    if (this.state === "waiting_scan") return this.status();
    this.busy = true;
    this.error = null;
    this.userInfo = null;
    this.qrPng = null;
    this.state = "starting";
    try {
      this.browser = new CdpBrowser({
        exe: process.env.TRAE_LOGIN_BROWSER || "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
        port: Number(process.env.TRAE_LOGIN_CDP_PORT || 9333),
        userDataDir: this._profileDir(),
        headless: process.env.TRAE_LOGIN_HEADLESS !== "0",
        log: this.log,
      });
      // 一次性 profile 时不接管旧浏览器：否则会把上一次的登录态带进来（这也是"为什么还留着上次登录"的原因之一）。
      // 需要强制接管用 TRAE_LOGIN_ATTACH=1；持久 profile 时默认仍接管（仅用于网关重启续接当前登录）
      const allowAttach = process.env.TRAE_LOGIN_ATTACH === "1"
        || (!!this.persistentDir && process.env.TRAE_LOGIN_ATTACH !== "0");
      let adopted = false;
      if (allowAttach) {
        try {
          if (await this.browser.attach()) {
            const sid = await this.browser.attachPage();
            if (sid) { this.sessionId = sid; adopted = true; this.log("[login] 接管现有登录页（不重启浏览器）"); }
          }
        } catch {}
        if (!adopted && this.browser.ws) { try { this.browser.ws.close(); } catch {} }
      }
      if (!adopted) {
        await this.browser.launch();
        this.sessionId = await this.browser.newPage("about:blank");
      }
      await this.browser.captureApiRequests(this.sessionId).catch(() => {});
      if (!adopted) {
        this.log("[login] 打开登录页");
        await this.browser.navigate(this.sessionId, LOGIN_URL, 5000);
      } else {
        this.log("[login] 复用已打开页面: " + String(await this.browser.evaluate(this.sessionId, "location.href").catch(() => "")).slice(0, 80));
      }
      if (!adopted && this.persistentDir && process.env.TRAE_LOGIN_KEEP_COOKIES !== "1") {
      // 持久 profile 省了冷启动，但默认不继承旧登录态：登录前把站点数据清干净
      const cleared = await this.browser.clearSite(SITE_ORIGINS).catch(() => []);
      if (cleared.length) this.log("[login] 已清理旧站点数据: " + cleared.join(", "));
    }
    this.qrPng = await this._captureQr();
      this.state = this.qrPng ? "waiting_scan" : "waiting_page";
      this.startedAt = Date.now();
      this.log("[login] 状态: " + this.state + (this.qrPng ? "（二维码已抓取）" : ""));
      return this.status();
    } catch (e) {
      this.state = "error";
      this.error = e.message;
      this.log("[login] 启动失败: " + e.message);
      this._closeBrowser();        // 启动失败也不留 profile
      throw e;
    } finally {
      this.busy = false;
    }
  }

  async _captureQr() {
    for (let i = 0; i < 8; i++) {
      for (const sel of QR_SELECTORS) {
        const png = await this.browser.screenshotElement(this.sessionId, sel).catch(() => null);
        if (png && png.length > 2000) return png;
      }
      await sleep(1500);
    }
    return null;
  }

  // 轮询：判断是否已登录（等页面稳定，避免在 sso-callback 中途就抢跑）
  async poll() {
    if (this.state === "idle" || this.state === "error" || this.state === "done") return this.status();
    if (!this.browser || !this.sessionId) return this.status();
    try {
      const href = await this.browser.evaluate(this.sessionId, "location.href").catch(() => null);
      if (!href) return this.status();
      const onTrae = /^https:\/\/(www\.)?trae\.cn\//.test(href);
      const midFlow = /accounts\.doubao\.com|\/login|\/sso-callback/.test(href);
      const candidate = onTrae && !midFlow;

      // 页面稳定判定：连续两次轮询 url 相同且不在中间态，再多等 2.5s 让站点写入登录态
      if (candidate) {
        if (this._lastHref === href) {
          this._stableCount = (this._stableCount || 0) + 1;
        } else {
          this._stableCount = 0;
          this._lastHref = href;
        }
        if (this._stableCount >= 1 && Date.now() - (this._stableAt || 0) > 2500) {
          this.state = "authenticated";
          this.log("[login] 页面稳定在 " + href.slice(0, 70) + "，准备换取凭据");
          this._finishInBackground();
        } else if (!this._stableAt || this._stableCount === 0) {
          this._stableAt = Date.now();
        }
      } else if (onTrae && /\/sso-callback/.test(href)) {
        this.state = "authenticated_pending";
        this.log("[login] 已收到 SSO 回调，等站点写入登录态…");
      }
      return this.status();
    } catch (e) {
      return this.status();
    }
  }

  _finishInBackground() {
    if (this.busy) return;
    this.busy = true;
    (async () => {
      try {
        const r = await this._exchange();
        this.state = "done";
        this.userInfo = r.user || null;
        this.log("[login] 成功：jwt 已写入 " + path.join(this.profileDir, "jwt.txt"));
        if (this.onNeedRestart) await this.onNeedRestart().catch((e) => this.log("[login] 重启运行时失败: " + e.message));
      } catch (e) {
        this.state = "error";
        this.error = e.message;
        this.log("[login] 换凭据失败: " + e.message);
      } finally {
        this.busy = false;
        this._closeBrowser();
      }
    })();
  }

  async _exchange() {
    // 1) 收集所有可能的凭据载体
    const cookies = await this.browser.cookies(["https://www.trae.cn", "https://api.trae.com.cn"]).catch(() => []);
    const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    const cookieNames = cookies.map((c) => c.name);
    this.log("[login] 取到 cookie " + cookies.length + " 个: " + cookieNames.join(","));

    let tokens = [];
    try {
      const raw = await this.browser.evaluate(this.sessionId, `(() => {
        const out = [];
        const scan = (st) => {
          try {
            for (let i = 0; i < st.length; i++) {
              const k = st.key(i), v = st.getItem(k) || "";
              if (v.length > 60 && v.split(".").length === 3) out.push({ k, v });
            }
          } catch {}
        };
        scan(localStorage); scan(sessionStorage);
        return JSON.stringify(out.slice(0, 8));
      })()`).catch(() => "[]");
      tokens = JSON.parse(raw || "[]");
    } catch {}
    // cookie 里也可能直接有 jwt
    for (const c of cookies) {
      if (/jwt|token/i.test(c.name) && String(c.value).split(".").length === 3 && String(c.value).length > 60) {
        tokens.push({ k: "cookie:" + c.name, v: c.value });
      }
    }
    this.log("[login] 找到候选 token " + tokens.length + " 个" + (tokens.length ? "（" + tokens.map((t) => t.k).join(",").slice(0, 120) + "）" : ""));

    // 1.5) 首选：直接在页面里发请求（自动带上站点的 cookie 与同源凭据）
    let pageToken = null;
    try {
      const raw = await this.browser.evaluate(this.sessionId, `(async () => {
        try {
          const r = await fetch("${API}/cloudide/api/v3/trae/oauth/GetRefreshToken", {
            method: "POST", credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ clientID: "${CLIENT_ID}" }),
          });
          const t = await r.text();
          return JSON.stringify({ status: r.status, body: t.slice(0, 500) });
        } catch (e) { return JSON.stringify({ error: String(e && e.message || e) }); }
      })()`, 30000).catch(() => null);
      if (raw) {
        const j = JSON.parse(raw);
        let body = null; try { body = JSON.parse(j.body || "{}"); } catch {}
        const rt = body?.Result?.RefreshToken || body?.Result?.refreshToken || body?.Result?.Token;
        this.log("[login] 页面内 fetch(GetRefreshToken) → " + (j.error ? "异常 " + j.error : "HTTP " + j.status + (rt ? " ✅ 有 RefreshToken" : " " + String(j.body).slice(0, 120))));
        if (rt) pageToken = rt;
      }
    } catch (e) {
      this.log("[login] 页面内 fetch 失败: " + e.message);
    }

    // 2) 逐种载体尝试 GetRefreshToken
    const baseHeaders = { "Content-Type": "application/json", "User-Agent": "Mozilla/5.0", Origin: "https://www.trae.cn", Referer: "https://www.trae.cn/" };
    const attempts = [];
    if (cookieHeader) attempts.push({ tag: "cookie", headers: Object.assign({}, baseHeaders, { Cookie: cookieHeader }) });
    for (const t of tokens.slice(0, 4)) {
      attempts.push({ tag: "cookie+Cloud-IDE-JWT(" + t.k + ")", headers: Object.assign({}, baseHeaders, { Cookie: cookieHeader, Authorization: "Cloud-IDE-JWT " + t.v }) });
      attempts.push({ tag: "Cloud-IDE-JWT(" + t.k + ")", headers: Object.assign({}, baseHeaders, { Authorization: "Cloud-IDE-JWT " + t.v }) });
      attempts.push({ tag: "cookie+Bearer(" + t.k + ")", headers: Object.assign({}, baseHeaders, { Cookie: cookieHeader, Authorization: "Bearer " + t.v }) });
    }
    if (!attempts.length) throw new Error("没有可用的凭据载体（cookie 与 token 都为空）");

    let refreshToken = pageToken;
    let rtErr = null;
    if (refreshToken) this.log("[login] 已用页面内 fetch 拿到 RefreshToken，跳过其它载体");
    for (const at of (refreshToken ? [] : attempts)) {
      try {
        const r = await fetch(`${API}/cloudide/api/v3/trae/oauth/GetRefreshToken`, {
          method: "POST", headers: at.headers, body: JSON.stringify({ clientID: CLIENT_ID }), signal: AbortSignal.timeout(20000),
        });
        const text = await r.text();
        let j = null; try { j = JSON.parse(text); } catch {}
        const rt = j?.Result?.RefreshToken || j?.Result?.refreshToken || j?.Result?.Token || j?.RefreshToken;
        this.log("[login] GetRefreshToken[" + at.tag + "] → HTTP " + r.status + (rt ? " ✅ 有 RefreshToken" : " " + text.slice(0, 130)));
        if (rt) { refreshToken = rt; break; }
        rtErr = "HTTP " + r.status + " " + text.slice(0, 160);
      } catch (e) {
        rtErr = e.message;
        this.log("[login] GetRefreshToken[" + at.tag + "] 异常: " + e.message);
      }
    }
    if (!refreshToken) {
      const net = (this.browser.networkLog || []).slice(-12).map((e) => `${e.status || "?"} ${e.method} ${e.url.slice(0, 110)}${e.auth ? " auth=" + e.auth : ""}${e.postData ? " body=" + e.postData.slice(0, 80) : ""}`).join("\n            ");
      this.log("[login] 站点侧请求（排障用）:\n            " + (net || "(无)"));
      throw new Error("GetRefreshToken 未返回 RefreshToken（已试 " + attempts.length + " 种载体）: " + rtErr);
    }

    // 4) ExchangeToken（站点侧传 ClientSecret:"-"，先用 "-" 再退到 bundle 里的真实 secret）
    const secrets = ["-", ...(readClientSecrets() || [])];
    let lastErr = null;
    for (const secret of secrets) {
      const r2 = await fetch(`${API}/cloudide/api/v3/trae/oauth/ExchangeToken`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "https://www.trae.cn", Referer: "https://www.trae.cn/" },
        body: JSON.stringify({ ClientID: CLIENT_ID, RefreshToken: refreshToken, ClientSecret: secret, UserID: "" }),
        signal: AbortSignal.timeout(20000),
      });
      const t2 = await r2.text();
      let j2 = null; try { j2 = JSON.parse(t2); } catch {}
      const token = j2?.Result?.Token || j2?.Result?.token;
      if (r2.status === 200 && token) {
        this.log("[login] ExchangeToken 成功（secret " + (secret === "-" ? "占位" : "真实") + "）");
        const exp = Number(j2?.Result?.ExpiredAt || j2?.Result?.ExpireAt || 0) || this._jwtExp(token);
        this._writeCreds(token, exp, refreshToken, Number(j2?.Result?.RefreshExpireAt || 0));
        return { jwt: token, exp, refreshToken, user: j2?.Result?.User || null };
      }
      lastErr = "HTTP " + r2.status + " " + t2.slice(0, 160);
      this.log("[login] ExchangeToken 失败: " + lastErr);
    }
    throw new Error("ExchangeToken 全部失败: " + lastErr);
  }

  // 直接用 refresh token 换 JWT（网页登录之外的兜底路径，也便于自动化验证）
  async exchangeRefreshToken(refreshToken) {
    const { readClientSecrets } = require("./creds.cjs");
    const secrets = [...(readClientSecrets() || []), "-"];
    let lastErr = null;
    for (const secret of secrets) {
      const r = await fetch(`${API}/cloudide/api/v3/trae/oauth/ExchangeToken`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ClientID: CLIENT_ID, RefreshToken: refreshToken, ClientSecret: secret, UserID: "" }),
        signal: AbortSignal.timeout(20000),
      });
      const t = await r.text();
      let j = null; try { j = JSON.parse(t); } catch {}
      const token = j?.Result?.Token || j?.Result?.token;
      if (r.status === 200 && token) {
        const exp = Number(j?.Result?.ExpiredAt || j?.Result?.ExpireAt || 0) || this._jwtExp(token);
        this._writeCreds(token, exp, refreshToken, Number(j?.Result?.RefreshExpireAt || 0));
        this.state = "done";
        this.log("[login] refresh token 换取成功，已写入 " + this.profileDir);
        if (this.onNeedRestart) await this.onNeedRestart().catch(() => {});
        return { jwt: token, exp };
      }
      lastErr = "HTTP " + r.status + " " + t.slice(0, 140);
    }
    throw new Error("ExchangeToken 全部失败: " + lastErr);
  }

  _jwtExp(token) {
    try {
      const p = JSON.parse(Buffer.from(String(token).split(".")[1], "base64url").toString("utf8"));
      return Number(p.exp || 0) * 1000;
    } catch { return 0; }
  }

  _writeCreds(jwt, expMs, refreshToken, freshExp) {
    fs.mkdirSync(this.profileDir, { recursive: true });
    fs.writeFileSync(path.join(this.profileDir, "jwt.txt"), jwt, "utf8");
    if (expMs) fs.writeFileSync(path.join(this.profileDir, "expire.txt"), String(expMs), "utf8");
    this.log("[login] 已写 jwt.txt" + (expMs ? " / expire.txt（到期 " + new Date(expMs).toLocaleString("zh-CN") + "）" : ""));

    // 关键：同时写进网关自己的缓存。没装 VS Code 扩展的机器没有 SecretStorage，
    // 只写 jwt.txt 的话网关会一直认为「没有凭据」（面板显示 token-cache.json 缺失）。
    const saved = saveTokenCache({
      jwt, jwtExp: Number(expMs) || this._jwtExp(jwt),
      fresh: refreshToken, freshExp: Number(freshExp) || 0,
      host: API, savedAt: Date.now(),
    });
    this.log(saved
      ? "[login] 已写入网关凭据缓存 data/token-cache.json（网关立即生效，无需重启）"
      : "[login] ⚠ 写网关凭据缓存失败（data/ 目录不可写？）");
    try { if (this.onCredsSaved) this.onCredsSaved(); } catch {}
  }

  // 本次登录用哪个浏览器配置目录
  _profileDir() {
    if (this.persistentDir) return this.persistentDir;
    if (this.tempProfile) return this.tempProfile;      // 同一次登录内复用同一个临时目录
    const dir = path.join(os.tmpdir(), "trae2api-login-" + process.pid + "-" + Date.now().toString(36));
    this.tempProfile = dir;
    this.log("[login] 使用一次性浏览器配置（登录结束即删除）");
    return dir;
  }

  // 删除一次性配置目录（Edge 退出后句柄才释放，失败重试几次）
  _cleanupProfile() {
    const dir = this.tempProfile;
    if (!dir) return;
    this.tempProfile = null;
    let tries = 0;
    const rm = () => {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
        this.log("[login] 已删除一次性浏览器配置");
      } catch (e) {
        if (++tries < 6) { setTimeout(rm, 400); return; }
        this.log("[login] 清理一次性配置失败（可手动删）: " + dir + " → " + e.message);
      }
    };
    setTimeout(rm, 300);
  }

  _closeBrowser() {
    try { this.browser && this.browser.close(); } catch {}
    this.browser = null;
    this.sessionId = null;
    this._cleanupProfile();     // 一次性 profile 用完就删，不留登录态
  }


  // 当前登录页截图（给面板当"实时画面"）
  async screenshot() {
    if (!this.browser || !this.sessionId) return null;
    return await this.browser.screenshot(this.sessionId).catch(() => null);
  }

  // 探测真实登录页上的输入框与按钮
  async probePage() {
    if (!this.browser || !this.sessionId) return null;
    const raw = await this.browser.evaluate(this.sessionId, "(() => {\n  const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };\n  const inputs = [...document.querySelectorAll(\"input\")].filter(vis).map((el) => ({\n    type: el.type, placeholder: el.placeholder || \"\", filled: !!el.value,\n  }));\n  const buttons = [...document.querySelectorAll(\"button, [role=button], a\")].filter(vis)\n    .map((el) => (el.innerText || el.textContent || \"\").trim()).filter((t) => t && t.length < 20).slice(0, 20);\n  return JSON.stringify({ url: location.href.slice(0, 140), inputs, buttons });\n})()", 15000).catch(() => null);
    if (!raw) return null;
    try { return JSON.parse(raw); } catch { return { raw }; }
  }

  // 在真实登录页上填手机号并点「下一步 / 获取验证码」
  async fillPhone(phone) {
    if (!this.browser || !this.sessionId) throw new Error("登录页未打开");
    const expr = "((val, mode) => {\n  const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };\n  const setVal = (el, v) => {\n    const proto = Object.getPrototypeOf(el);\n    const desc = Object.getOwnPropertyDescriptor(proto, \"value\");\n    if (desc && desc.set) desc.set.call(el, v); else el.value = v;\n    el.dispatchEvent(new Event(\"input\", { bubbles: true }));\n    el.dispatchEvent(new Event(\"change\", { bubbles: true }));\n  };\n  const inputs = [...document.querySelectorAll(\"input\")].filter(vis);\n  const pick = () => {\n    if (mode === \"phone\") return inputs.find((el) => el.type === \"tel\" || /手机|电话|phone/i.test(el.placeholder || \"\")) || inputs[0];\n    return inputs.find((el) => /验证码|code/i.test(el.placeholder || \"\") || el.inputMode === \"numeric\" || el.type === \"tel\") || inputs[0];\n  };\n  const target = pick();\n  if (!target) return JSON.stringify({ ok: false, error: \"找不到输入框\" });\n  target.focus(); setVal(target, val);\n  const btns = [...document.querySelectorAll(\"button, [role=button]\")].filter(vis);\n  const label = (b) => (b.innerText || b.textContent || \"\").trim();\n  const want = mode === \"phone\" ? /下一步|继续|获取验证码|发送/ : /登录|确定|验证|进入/;\n  const btn = btns.find((b) => want.test(label(b)) && !b.disabled);\n  let clicked = null;\n  if (btn) { btn.click(); clicked = label(btn); }\n  return JSON.stringify({ ok: true, filled: true, clicked, url: location.href.slice(0, 120) });\n})(__VAL__, __MODE__)".replace("__VAL__", JSON.stringify(String(phone))).replace("__MODE__", JSON.stringify("phone"));
    const raw = await this.browser.evaluate(this.sessionId, expr, 20000);
    this.log("[login] fillPhone → " + raw);
    const out = JSON.parse(raw);
    // 协议确认：豆包登录点「下一步」后可能弹出 同意/不同意
    await new Promise((r) => setTimeout(r, 700));
    const agree = await this.clickText("^(同意|同意并继续|确定)$").catch(() => null);
    if (agree && agree.clicked) { out.agreed = agree.clicked; this.log("[login] 已点击协议按钮: " + agree.clicked); }
    return out;
  }

  // 在真实登录页上填验证码并提交
  async fillCode(code6) {
    if (!this.browser || !this.sessionId) throw new Error("登录页未打开");
    const expr = "((val, mode) => {\n  const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };\n  const setVal = (el, v) => {\n    const proto = Object.getPrototypeOf(el);\n    const desc = Object.getOwnPropertyDescriptor(proto, \"value\");\n    if (desc && desc.set) desc.set.call(el, v); else el.value = v;\n    el.dispatchEvent(new Event(\"input\", { bubbles: true }));\n    el.dispatchEvent(new Event(\"change\", { bubbles: true }));\n  };\n  const inputs = [...document.querySelectorAll(\"input\")].filter(vis);\n  const pick = () => {\n    if (mode === \"phone\") return inputs.find((el) => el.type === \"tel\" || /手机|电话|phone/i.test(el.placeholder || \"\")) || inputs[0];\n    return inputs.find((el) => /验证码|code/i.test(el.placeholder || \"\") || el.inputMode === \"numeric\" || el.type === \"tel\") || inputs[0];\n  };\n  const target = pick();\n  if (!target) return JSON.stringify({ ok: false, error: \"找不到输入框\" });\n  target.focus(); setVal(target, val);\n  const btns = [...document.querySelectorAll(\"button, [role=button]\")].filter(vis);\n  const label = (b) => (b.innerText || b.textContent || \"\").trim();\n  const want = mode === \"phone\" ? /下一步|继续|获取验证码|发送/ : /登录|确定|验证|进入/;\n  const btn = btns.find((b) => want.test(label(b)) && !b.disabled);\n  let clicked = null;\n  if (btn) { btn.click(); clicked = label(btn); }\n  return JSON.stringify({ ok: true, filled: true, clicked, url: location.href.slice(0, 120) });\n})(__VAL__, __MODE__)".replace("__VAL__", JSON.stringify(String(code6))).replace("__MODE__", JSON.stringify("code"));
    let out = null;
    for (const inFrame of [false, true]) {
      const raw = inFrame
        ? await this.browser.evaluateInFrame(this.sessionId, /accounts\.doubao\.com\/accounts\/page|passport/, expr, 20000).catch(() => null)
        : await this.browser.evaluate(this.sessionId, expr, 20000).catch(() => null);
      try { out = raw ? JSON.parse(raw) : null; } catch {}
      if (out && out.ok && out.filled) {
        this.log("[login] fillCode（" + (inFrame ? "iframe" : "DOM") + "）→ " + raw);
        return out;
      }
    }
    // 豆包验证码在 iframe 里、是 6 个单字格子：逐个写入
    const digits = String(code6);
    const multiExpr = `(() => {
      const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      const boxes = [...document.querySelectorAll("input")].filter((el) => vis(el) && (el.maxLength === 1 || el.type === "tel" || el.inputMode === "numeric"));
      if (boxes.length < 4) return JSON.stringify({ ok: false, boxes: boxes.length });
      const digits = ${JSON.stringify(digits)};
      boxes.forEach((el, i) => {
        el.focus();
        const d = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value");
        const v = digits[i] || "";
        if (d && d.set) d.set.call(el, v); else el.value = v;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      });
      return JSON.stringify({ ok: true, filled: true, via: "multi-box", boxes: boxes.length });
    })()`;
    const multi = await this.browser.evaluateInFrame(this.sessionId, /accounts\.doubao\.com\/accounts\/page|passport/, multiExpr, 20000).catch(() => null);
    try { out = multi ? JSON.parse(multi) : null; } catch {}
    if (out && out.ok) { this.log("[login] fillCode（iframe 多格）→ " + multi); return out; }

    // 最后的兜底：键盘输入（焦点已在第一个格子）
    this.log("[login] fillCode：找不到验证码输入框，改用键盘输入");
    await this.browser.insertText(this.sessionId, String(code6));
    await new Promise((r) => setTimeout(r, 600));
    return { ok: true, via: "keyboard", note: "已用键盘输入验证码" };
  }


  // 在页面上按文字点击按钮（正则模糊匹配）
  async clickText(re) {
    if (!this.browser || !this.sessionId) return null;
    const code = "((pat) => {\n  const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };\n  const rx = new RegExp(pat);\n  const btns = [...document.querySelectorAll('button, [role=button], a, span')].filter(vis);\n  const hit = btns.find((b) => rx.test((b.innerText || b.textContent || '').trim()) && !b.disabled);\n  if (!hit) return JSON.stringify({ clicked: null });\n  hit.click();\n  return JSON.stringify({ clicked: (hit.innerText || hit.textContent || '').trim() });\n})(__PAT__)".replace("__PAT__", JSON.stringify(String(re)));
    const raw = await this.browser.evaluate(this.sessionId, code, 15000).catch(() => null);
    if (raw) this.log("[login] clickText(" + re + ") → " + raw);
    try { return raw ? JSON.parse(raw) : null; } catch { return null; }
  }

  async cancel() {
    this._closeBrowser();
    this.state = "idle";
    this.qrPng = null;
    this.error = null;
    return this.status();
  }
}

module.exports = { TraeLogin, LOGIN_URL, CLIENT_ID, API };
