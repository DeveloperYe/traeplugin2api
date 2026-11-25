// 面板会话 Cookie 的属性拼装（抽出来便于单测）：HTTPS 下自动加 Secure
function isSecureRequest(req) {
  try {
    if (!req) return false;
    if (req.socket && req.socket.encrypted) return true;
    const proto = String((req.headers && (req.headers['x-forwarded-proto'] || req.headers['X-Forwarded-Proto'])) || '');
    return proto.split(',')[0].trim().toLowerCase() === 'https';
  } catch {
    return false;
  }
}

function buildSessionCookie(token, opts) {
  const o = opts || {};
  const maxAge = Number.isFinite(Number(o.maxAgeSec)) ? Math.floor(Number(o.maxAgeSec)) : 0;
  const parts = ['t2a=' + String(token || ''), 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (o.secure) parts.push('Secure');       // LAN HTTP 部署拿不到 Secure，只有 https 才加
  if (maxAge > 0) parts.push('Max-Age=' + maxAge);
  return parts.join('; ');
}

function clearSessionCookie(opts) {
  const o = opts || {};
  const parts = ['t2a=', 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (o.secure) parts.push('Secure');
  parts.push('Max-Age=0');
  return parts.join('; ');
}

module.exports = { isSecureRequest, buildSessionCookie, clearSessionCookie };
