// 图片附件落盘：把 OpenAI 的 image_url 部件（data URL 或 http(s) URL）写到本地，
// 返回绝对路径，交给 Trae agent 用它自带的读图能力去"看"。
// 事实依据：Trae agent 给路径就能自己上传到对象存储、过合规检查再喂给模型（2026-11-19 实测，含 OCR 级验证）。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DIR = path.join(__dirname, '..', 'data', 'attachments');
const TTL_MS = 24 * 3600 * 1000;
// 单张图片下载上限（可用 TRAE2API_IMAGE_MAX_MB 覆盖）
const MAX_BYTES = Math.max(1, Number(process.env.TRAE2API_IMAGE_MAX_MB || 20)) * 1048576;

const MIME_EXT = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/webp': 'webp',
  'image/gif': 'gif', 'image/bmp': 'bmp', 'image/svg+xml': 'svg',
};

function ensureDir() { fs.mkdirSync(DIR, { recursive: true }); }

function cleanup() {
  try {
    ensureDir();
    const now = Date.now();
    for (const f of fs.readdirSync(DIR)) {
      const p = path.join(DIR, f);
      try { if (now - fs.statSync(p).mtimeMs > TTL_MS) fs.unlinkSync(p); } catch {}
    }
  } catch {}
}

function saveBuffer(buf, ext) {
  ensureDir();
  const hash = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 32);
  const file = path.join(DIR, `${hash}.${ext}`);
  if (!fs.existsSync(file)) fs.writeFileSync(file, buf);
  else { try { fs.utimesSync(file, new Date(), new Date()); } catch {} }   // 刷新 mtime，避免被 TTL 清掉
  return file.replace(/\\/g, '/');
}

/** data:image/png;base64,xxxx */
function saveDataUrl(dataUrl) {
  const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(String(dataUrl));
  if (!m) throw new Error('不是合法的 data URL');
  const mime = (m[1] || 'image/png').toLowerCase();
  const ext = MIME_EXT[mime] || 'bin';
  const buf = m[2] ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3]), 'utf8');
  return saveBuffer(buf, ext);
}

async function saveRemoteUrl(url, timeoutMs = 15000) {
  // 只允许公网 http(s)：网关卡在用户机器上，放任请求体里的任意 URL 会变成 SSRF 跳板
  // （内网管理面、云 metadata、本机其它服务都能被打）。私网/环回/链路本地一律拒绝。
  let parsed;
  try { parsed = new URL(String(url)); } catch { throw new Error('图片 URL 非法'); }
  if (!/^https?:$/.test(parsed.protocol)) throw new Error('图片只支持 http(s)');
  const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const isPrivate =
    host === 'localhost' || host === '0.0.0.0' || host === '::1' || host === '::' ||
    host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') ||
    /^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) || /^169\.254\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) || /^f[cd][0-9a-f]{2}:/i.test(host);
  if (isPrivate) throw new Error('拒绝抓取内网地址: ' + host);
  const r = await fetch(parsed, { signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) throw new Error(`下载图片失败: HTTP ${r.status}`);
  const ctype = (r.headers.get('content-type') || 'image/png').split(';')[0].trim().toLowerCase();
  const ext = MIME_EXT[ctype] || 'bin';
  const declared = Number(r.headers.get('content-length') || 0);
  if (declared && declared > MAX_BYTES) throw new Error(`图片过大: ${(declared / 1048576).toFixed(1)} MB > ${(MAX_BYTES / 1048576).toFixed(0)} MB`);
  const buf = Buffer.from(await r.arrayBuffer());
  if (!buf.length) throw new Error('下载到的图片是空的');
  if (buf.length > MAX_BYTES) throw new Error(`图片过大: ${(buf.length / 1048576).toFixed(1)} MB`);
  return saveBuffer(buf, ext);
}

/** 把 content 里的 image_url 部件落盘，返回本地路径数组 */
async function extractImagePaths(content) {
  const out = [];
  if (!Array.isArray(content)) return out;
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    if (part.type !== 'image_url' && part.type !== 'image') continue;
    const u = part.image_url?.url || part.image_url || part.url || part.data;
    if (!u || typeof u !== 'string') continue;
    try {
      out.push(u.startsWith('data:') ? saveDataUrl(u) : await saveRemoteUrl(u));
    } catch (e) {
      out.push(`[图片处理失败: ${e.message}]`);
    }
  }
  return out;
}

module.exports = { saveDataUrl, saveRemoteUrl, extractImagePaths, cleanup, DIR };
