// creds.cjs —— 读取/续期/回写 Trae 登录凭据（桌面 VS Code SecretStorage 优先，本地缓存兜底）
// 存储格式：v10 + AES-256-GCM，密钥来自 %APPDATA%\Code\Local State 的 os_crypt.encrypted_key（DPAPI 保护）
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const HOME = os.homedir();
const DB = path.join(process.env.APPDATA, 'Code', 'User', 'globalStorage', 'state.vscdb');
const LOCALSTATE = path.join(process.env.APPDATA, 'Code', 'Local State');
const EXT_ID = 'marscode.marscode-extension';
const V10 = Buffer.from('v10', 'ascii');
const DATA = path.join(__dirname, '..', 'data');
const KEY_FILE = path.join(DATA, 'safekey.bin');
const TOKEN_FILE = path.join(DATA, 'token-cache.json');

const OAUTH = { cn: { host: 'https://api.trae.com.cn', clientId: '368953x60ky286' } };

// clientSecret 是扩展 bundle 里的固定常量（与账号无关），但 bundle 的位置随部署方式不同：
//   ① 自包含部署（本仓库推荐的 runtime/ 目录）——**全新机器上往往没有装 VS Code 扩展**，
//      此时只能从 runtime 自带的 aiserver 里读，这是 20107「client secret invalid」的根因
//   ② 桌面 VS Code / code-server 装的扩展（多版本，升级后目录名会变）
// 顺序即优先级；全部收集后交给 exchange 逐个试。
function bundleCandidates() {
  const out = [];
  const push = (p) => { if (p && !out.includes(p)) { try { if (fs.existsSync(p)) out.push(p); } catch {} } };

  // ① 显式指定
  push(process.env.TRAE2API_BUNDLE);

  // ② 自包含运行时：TRAE2API_AHA_DIR 形如 <root>/aha/aha
  const aha = process.env.TRAE2API_AHA_DIR || process.env.TRAE2API_AHA_DIR_RAW;
  if (aha) {
    const root = path.resolve(aha, '..', '..');
    push(path.join(root, 'aiserver', 'aiServerMainV2.js'));
    push(path.join(root, 'runtime', 'aiserver', 'aiServerMainV2.js'));
  }

  // ③ 仓库内的默认部署位置（<仓库>/runtime/aiserver）与同级 aiserver
  push(path.join(__dirname, '..', 'runtime', 'aiserver', 'aiServerMainV2.js'));
  push(path.join(__dirname, '..', 'aiserver', 'aiServerMainV2.js'));

  // ④ deploy.json 里记录的运行时根（setup.ps1 生成）
  try {
    const dj = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'deploy.json'), 'utf8'));
    for (const r of [dj.root, dj.runtimeRoot, dj.runtimeDir].filter(Boolean)) {
      push(path.join(r, 'aiserver', 'aiServerMainV2.js'));
      push(path.join(r, 'runtime', 'aiserver', 'aiServerMainV2.js'));
    }
  } catch {}

  // ⑤ 桌面 VS Code / VSCode Server / code-server 的扩展目录（按版本倒序）
  const extRoots = [
    path.join(HOME, '.vscode', 'extensions'),
    path.join(HOME, '.vscode-server', 'extensions'),
    path.join(HOME, '.local', 'share', 'code-server', 'extensions'),
  ];
  for (const dir of extRoots) {
    let list = [];
    try {
      list = fs.readdirSync(dir)
        .filter((n) => n.startsWith('marscode.marscode-extension-'))
        .map((n) => ({ n, p: path.join(dir, n, 'resource', 'aiserver', 'aiServerMainV2.js') }))
        .filter((x) => fs.existsSync(x.p));
    } catch { continue; }
    list.sort((a, b) => {
      const va = a.n.replace('marscode.marscode-extension-', '').split('.').map(Number);
      const vb = b.n.replace('marscode.marscode-extension-', '').split('.').map(Number);
      for (let i = 0; i < 3; i++) { if ((va[i] || 0) !== (vb[i] || 0)) return (vb[i] || 0) - (va[i] || 0); }
      return 0;
    });
    for (const x of list) push(x.p);
  }
  return out;
}

// 兼容旧调用：返回优先级最高的那个 bundle
function findBundle() {
  const list = bundleCandidates();
  return list.length ? list[0] : null;
}

// 从单个 bundle 里抽 clientSecret
function secretsFromBundle(file) {
  const out = [];
  const push = (s) => { if (s && !out.includes(s)) out.push(s); };
  let src = '';
  try { src = fs.readFileSync(file, 'utf8'); } catch { return out; }

  // ① 优先：cn 区域块（clientId:'368953x60ky286'）后面紧跟的字面量 secret
  const cnAt = src.indexOf("'clientId':'368953x60ky286'");
  if (cnAt >= 0) {
    const seg = src.slice(cnAt, cnAt + 400);
    const m = /clientSecret'\s*:\s*'([^']{20,120})'/.exec(seg);
    if (m) push(m[1]);
  }
  // ② 兜底：全文里所有字面量 secret（cn 的是 63~64 位）
  const re = /clientSecret'\s*:\s*'([^']{20,120})'/g;
  let m2;
  while ((m2 = re.exec(src))) push(m2[1]);
  return out;
}

// 凭据文件的最小可见范围：去掉继承，只留 SYSTEM / Administrators / 当前用户。
// 关键点：**必须包含当前用户** —— 网关以普通用户身份运行时，
// 只授 Administrators+SYSTEM 会把进程自己锁在外面（读不到刚写的 token-cache.json，
// 表现为 hasCreds=false、/v1/models 500）。内置主体用 SID 表达，避免非英文 Windows 名称差异。
function aclPrincipals() {
  const list = ['*S-1-5-18:F', '*S-1-5-32-544:F']; // SYSTEM, Administrators
  let user = '';
  try { user = process.env.USERNAME || require('os').userInfo().username || ''; } catch {}
  const domain = process.env.USERDOMAIN || '';
  if (user) list.push(user + ':F');
  if (domain && user) list.push(domain + '\\' + user + ':F');
  return list;
}

// 同上，但不带 :F 标志（/remove:d 用）
function aclPrincipalNames() {
  return aclPrincipals().map((x) => x.replace(/:F$/, ''));
}

// 收紧 file 的 ACL，并**回读自检**：收紧完自己读不到就是 bug，宁可打日志/repair 也不能静默锁死。
function tightenAcl(file) {
  try {
    if (process.platform !== 'win32') { fs.chmodSync(file, 0o600); return true; }
    const names = aclPrincipalNames();
    // 老版本/误操作可能留下显式 deny（读了就 EACCES），先清掉再授权
    try { execFileSync('icacls', [file, '/remove:d', ...names], { windowsHide: true, stdio: 'ignore' }); } catch {}
    execFileSync('icacls', [file, '/inheritance:r', '/grant:r', ...aclPrincipals()],
      { windowsHide: true, stdio: 'ignore' });
    fs.accessSync(file, fs.constants.R_OK);   // 自检：自己必须仍可读
    return true;
  } catch (e) {
    // 收紧失败不算致命，但要留在日志里（否则以后又是「莫名 500」）
    try {
      console.log('[creds] 收紧 ' + file + ' 权限失败（已保留原 ACL）: ' + (e && e.message ? e.message : e));
    } catch {}
    return false;
  }
}

// 把凭据写进网关自己的缓存（data/token-cache.json）。
// 面板内登录成功后必须走这里：没装 VS Code 扩展的机器没有 SecretStorage，只能靠这份缓存。
function saveTokenCache(c) {
  if (!c || !c.jwt) return false;
  try {
    fs.mkdirSync(DATA, { recursive: true });
    fs.writeFileSync(TOKEN_FILE, JSON.stringify(c, null, 2), 'utf8');
    if (!tightenAcl(TOKEN_FILE)) return false;
    return true;
  } catch { return false; }
}

// 登录成功过的 secret 落到 data/client-secret.txt，之后不再依赖 bundle 是否还在
function cachedClientSecret() {
  try {
    const s = fs.readFileSync(path.join(DATA, 'client-secret.txt'), 'utf8').trim();
    return s || null;
  } catch { return null; }
}

function saveClientSecret(secret) {
  if (!secret) return;
  try {
    fs.mkdirSync(DATA, { recursive: true });
    fs.writeFileSync(path.join(DATA, 'client-secret.txt'), secret, 'utf8');
    tightenAcl(path.join(DATA, 'client-secret.txt'));
  } catch {}
}

// clientSecret 是扩展 bundle 里的固定常量（与账号无关）。注意三点：
// 1) 扩展升级会改目录名（1.7.16 → 1.7.17），不能写死路径；
// 2) 自包含部署没有扩展目录，必须从 runtime/aiserver 里读；
// 3) bundle 里有多套区域配置，所以收集一组候选值，exchange 时按顺序试（全部失败才报错）。
function readClientSecrets() {
  const out = [];
  const push = (s) => { if (s && !out.includes(s)) out.push(s); };
  push(cachedClientSecret());                 // 0) 上次成功过的
  for (const f of bundleCandidates()) {
    for (const s of secretsFromBundle(f)) push(s);
  }
  return out;
}

function readClientSecret() {
  const list = readClientSecrets();
  return list.length ? list[0] : null;
}

class Creds {
  constructor(opts = {}) {
    this.log = opts.log || (() => {});
    this.key = null;
    this.clientSecret = null;
    this.cache = null;
    this.identity = null;
    this.lastRefreshAt = 0;
    this.refreshLock = null;
    this.lastError = null;
  }

  // ---------- safeStorage 密钥 ----------
  _safeKey(forceDpapi = false) {
    if (this.key && !forceDpapi) return this.key;
    if (!forceDpapi) {
      try {
        if (fs.existsSync(KEY_FILE)) {
          const buf = fs.readFileSync(KEY_FILE);
          if (buf.length === 32) { this.key = buf; return buf; }
        }
      } catch {}
    }
    const ls = JSON.parse(fs.readFileSync(LOCALSTATE, 'utf8'));
    const blob = Buffer.from(ls.os_crypt.encrypted_key, 'base64').subarray(5);
    const ps = `Add-Type -AssemblyName System.Security;` +
      `$b=[Convert]::FromBase64String('${blob.toString('base64')}');` +
      `$k=[System.Security.Cryptography.ProtectedData]::Unprotect($b,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser);` +
      `if ($k) { [Convert]::ToBase64String($k) }`;
    const out = execFileSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', ps],
      { encoding: 'utf8', windowsHide: true }).trim();
    if (!out) throw new Error('DPAPI 解 safeStorage key 返回空');
    this.key = Buffer.from(out, 'base64');
    if (this.key.length !== 32) throw new Error('safeStorage key 长度异常: ' + this.key.length);
    try {
      fs.mkdirSync(DATA, { recursive: true });
      fs.writeFileSync(KEY_FILE, this.key);
      tightenAcl(KEY_FILE);
    } catch {}
    return this.key;
  }

  _dec(raw, retryDpapi = true) {
    const nonce = raw.subarray(3, 15);
    const tag = raw.subarray(raw.length - 16);
    const ct = raw.subarray(15, raw.length - 16);
    try {
      const d = crypto.createDecipheriv('aes-256-gcm', this._safeKey(), nonce);
      d.setAuthTag(tag);
      return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
    } catch (e) {
      if (retryDpapi) { this._safeKey(true); return this._dec(raw, false); }
      throw e;
    }
  }

  _enc(text) {
    const nonce = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', this._safeKey(), nonce);
    const ct = Buffer.concat([c.update(Buffer.from(text, 'utf8')), c.final()]);
    return Buffer.concat([V10, nonce, ct, c.getAuthTag()]);
  }

  _open() {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(DB, { timeout: 5000 });
    try { db.exec('PRAGMA busy_timeout=5000'); } catch {}
    return db;
  }

  _keyName(k) { return `secret://{"extensionId":"${EXT_ID}","key":"${k}"}`; }

  // ---------- SecretStorage 读写 ----------
  readAll() {
    const db = this._open();
    try {
      const get = (k) => {
        const row = db.prepare('SELECT value FROM ItemTable WHERE key=?').get(this._keyName(k));
        if (!row) return null;
        const v = row.value;
        const raw = typeof v === 'string' ? Buffer.from(JSON.parse(v).data) : Buffer.from(v);
        try { return this._dec(raw); } catch { return null; }
      };
      return {
        jwt: get('MarscodeJwt'),
        jwtExp: Number(get('MarscodeJwtexpireAt') || 0),
        fresh: get('MarscodeFreshToken'),
        freshExp: Number(get('MarscodeFreshTokenExpireAt') || 0),
        host: get('MarscodeHost'),
        userInfo: get('MarscodeUserInfo'),
      };
    } finally { try { db.close(); } catch {} }
  }

  writeTokens({ jwt, jwtExp, fresh, freshExp }) {
    try {
      const db = this._open();
      const set = (k, text) => {
        const val = JSON.stringify({ type: 'Buffer', data: [...this._enc(text)] });
        db.prepare('INSERT INTO ItemTable(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
          .run(this._keyName(k), val);
      };
      if (jwt) set('MarscodeJwt', jwt);
      if (jwtExp) set('MarscodeJwtexpireAt', String(jwtExp));
      if (fresh) set('MarscodeFreshToken', fresh);
      if (freshExp) set('MarscodeFreshTokenExpireAt', String(freshExp));
      db.close();
      return true;
    } catch (e) {
      this.log('[creds] 回写 SecretStorage 失败（继续用本地缓存）: ' + e.message);
      return false;
    }
  }

  // ---------- 本地缓存 ----------
  _loadTokenCache() {
    try { return JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8')); } catch (e) {
      // 老版本把 ACL 收紧成只有 Administrators/SYSTEM，非管理员进程读不到自己写的缓存 —— 自动补授当前用户后重试一次
      if (e && (e.code === 'EPERM' || e.code === 'EACCES')) {
        this.log('[creds] token-cache.json 无权读取（' + e.code + '），尝试补授当前用户权限');
        if (tightenAcl(TOKEN_FILE)) {
          try { return JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8')); } catch {}
        }
      }
      return null;
    }
  }
  _saveTokenCache(c) {
    saveTokenCache(c);
  }

  claims(jwt) {
    try {
      const seg = jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
      const p = JSON.parse(Buffer.from(seg, 'base64').toString('utf8'));
      return { uid: String(p.data?.id || ''), tenant: p.data?.tenant_id ? String(p.data.tenant_id) : '', iss: p.iss, exp: p.exp };
    } catch { return {}; }
  }

  async exchange(refreshToken) {
    if (!this.clientSecret) {
      this.clientSecrets = readClientSecrets();
      if (!this.clientSecrets.length) {
      const where = bundleCandidates();
      throw new Error('读不到 clientSecret（ExchangeToken 必需）。已查找：' +
        (where.length ? where.join(' | ') : '没有找到任何 aiserver bundle（runtime/aiserver 与 VS Code 扩展目录都为空）') +
        '；可设 TRAE2API_BUNDLE 指向 aiServerMainV2.js，或把可用的 secret 写入 data/client-secret.txt');
    }
      this.clientSecret = this.clientSecrets[0];
    }
    const host = (this.cache?.host || OAUTH.cn.host).replace(/\/$/, '');
    const candidates = (this.clientSecrets && this.clientSecrets.length) ? this.clientSecrets : [this.clientSecret];
    let lastErr = null;
    for (let i = 0; i < candidates.length; i++) {
      const secret = candidates[i];
      try {
        const res = await fetch(host + '/cloudide/api/v3/public/oauth/ExchangeToken', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ClientID: OAUTH.cn.clientId, RefreshToken: refreshToken,
            ClientSecret: secret, Name: 'Codeverse', UserID: '',
          }),
          signal: AbortSignal.timeout(30000),
        });
        const text = await res.text();
        let j = null; try { j = JSON.parse(text); } catch {}
        if (res.status === 200 && j?.Result?.Token) {
          this.clientSecret = secret;           // 记住这次成功的那个
          this.clientSecrets = [secret, ...(this.clientSecrets || []).filter((x) => x !== secret)];
          saveClientSecret(secret);             // 落盘：以后不再依赖 bundle 是否还在
          return j.Result;
        }
        const msg = j?.ResponseMetaData?.Error?.Message || j?.ResponseMetadata?.Error?.Message || text.slice(0, 160);
        lastErr = `HTTP ${res.status} ${msg}`;
        this.log(`[creds] 候选 secret #${i + 1} 失败: ${lastErr}`);
      } catch (e) {
        lastErr = e.message;
        this.log(`[creds] 候选 secret #${i + 1} 异常: ${e.message}`);
      }
    }
    throw new Error('ExchangeToken 全部候选失败: ' + lastErr);
  }

  _absorb(src) {
    this.cache = {
      jwt: src.jwt, jwtExp: Number(src.jwtExp) || 0,
      fresh: src.fresh, freshExp: Number(src.freshExp) || 0,
      host: src.host || OAUTH.cn.host, userInfo: src.userInfo || this.cache?.userInfo || '',
    };
    const c = this.claims(this.cache.jwt || '');
    let ui = {};
    try { ui = JSON.parse(this.cache.userInfo || '{}'); } catch {}
    this.identity = {
      uid: c.uid, tenant: c.tenant || 'unknown_tenant',
      name: ui.username || ui.name || 'user', scope: 'marscode',
    };
    this._saveTokenCache(this.cache);
    return this.cache;
  }

  // 取当前状态；必要时续期（到期前 1 小时）
  async ensure({ force = false, minValidityMs = 3600e3 } = {}) {
    if (this.cache && !force && this.cache.jwtExp - Date.now() > minValidityMs) return this.cache;
    if (this.refreshLock) return this.refreshLock;
    const p = (async () => {
      try {
        // 1) 优先读 SecretStorage（桌面端可能刚续期）
        let src = null;
        try {
          const s = this.readAll();
          if (s && s.jwt && s.fresh) src = s;
        } catch (e) {
          this.log('[creds] 读取 SecretStorage 失败: ' + e.message);
        }
        // 2) 退到本地缓存（DPAPI 抖动 / VS Code 关闭时仍可续期）
        if (!src) {
          const c = this._loadTokenCache();
          if (c && c.jwt && c.fresh) {
            src = { ...c, host: c.host || OAUTH.cn.host };
            this.log('[creds] 使用本地 token 缓存（jwtExp=' + new Date(Number(c.jwtExp)).toLocaleString('zh-CN') + '）');
          }
        }
        if (!src) throw new Error('既读不到 SecretStorage 也没有本地缓存（桌面 VS Code 需登录过）');

        this._absorb(src);
        const needRefresh = force || (Number(src.jwtExp) - Date.now() < minValidityMs);
        if (needRefresh) {
          const t = await this.exchange(src.fresh);
          const next = {
            jwt: t.Token, jwtExp: Number(t.TokenExpireAt),
            fresh: t.RefreshToken, freshExp: Number(t.RefreshExpireAt),
            host: src.host || OAUTH.cn.host, userInfo: src.userInfo || '',
          };
          this._absorb(next);
          this.writeTokens({ jwt: next.jwt, jwtExp: next.jwtExp, fresh: next.fresh, freshExp: next.freshExp });
          this.lastRefreshAt = Date.now();
          this.log('[creds] 已续期 token，新到期 ' + new Date(next.jwtExp).toLocaleString('zh-CN'));
        }
        this.lastError = null;
        return this.cache;
      } catch (e) {
        this.lastError = e.message;
        throw e;
      }
    })();
    // 注意：不能把 this.refreshLock = null 写在 IIFE 的 finally 里——
    // 若 IIFE 同步走完（无 await 命中，例如缓存还新鲜时的 return this.cache），
    // finally 会先执行、把锁置空，随后外层赋值又把"已完成的 promise"写回，
    // 锁就永远清不掉，后续 ensure({force:true}) 直接返回它 → 续期静默失效（2026-11-21 实测踩到）。
    this.refreshLock = p;
    p.then(
      () => { if (this.refreshLock === p) this.refreshLock = null; },
      () => { if (this.refreshLock === p) this.refreshLock = null; }
    );
    return p;
  }

  status() {
    const c = this.cache;
    return {
      hasCreds: !!(c && c.jwt),
      jwtExp: c?.jwtExp || 0,
      freshExp: c?.freshExp || 0,
      lastRefreshAt: this.lastRefreshAt,
      renewCount: this.renewCount || 0,
      nextRenewAt: this.nextRenewAt || 0,
      autoRenewHours: this.autoRenewHours || 0,
      identity: this.identity || null,
      lastError: this.lastError || null,
      keyCached: fs.existsSync(KEY_FILE),
      tokenCached: fs.existsSync(TOKEN_FILE),
    };
  }
}

module.exports = { Creds, OAUTH, readClientSecret, readClientSecrets, findBundle, bundleCandidates, secretsFromBundle, cachedClientSecret, saveClientSecret, saveTokenCache , tightenAcl, aclPrincipals, aclPrincipalNames };



