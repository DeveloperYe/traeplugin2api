// 会话 Cookie：HTTPS 时自动加 Secure，HTTP 不加；Max-Age / HttpOnly / SameSite 恒定
const { isSecureRequest, buildSessionCookie, clearSessionCookie } = require('./lib/cookie.cjs');

let pass = 0, fail = 0;
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra === undefined ? '' : '  → ' + JSON.stringify(extra))); }
};

// ---------- isSecureRequest ----------
check('直连 HTTPS（socket.encrypted）→ true', isSecureRequest({ socket: { encrypted: true }, headers: {} }) === true);
check('反代 X-Forwarded-Proto: https → true', isSecureRequest({ socket: {}, headers: { 'x-forwarded-proto': 'https' } }) === true);
check('反代大写 HTTPS → true', isSecureRequest({ socket: {}, headers: { 'x-forwarded-proto': 'HTTPS' } }) === true);
check('多跳代理取第一段', isSecureRequest({ socket: {}, headers: { 'x-forwarded-proto': 'https, http' } }) === true);
check('明文 HTTP → false', isSecureRequest({ socket: {}, headers: {} }) === false);
check('X-Forwarded-Proto: http → false', isSecureRequest({ socket: {}, headers: { 'x-forwarded-proto': 'http' } }) === false);
check('空 req 不抛异常', isSecureRequest(null) === false);

// ---------- buildSessionCookie ----------
const http = buildSessionCookie('abc123', { maxAgeSec: 604800, secure: false });
check('HTTP：不含 Secure', !/Secure/.test(http), http);
check('HTTP：含 HttpOnly', /HttpOnly/.test(http), http);
check('HTTP：SameSite=Lax', /SameSite=Lax/.test(http), http);
check('HTTP：Max-Age 正确', /Max-Age=604800/.test(http), http);
check('HTTP：Path=/', /Path=\//.test(http), http);

const https = buildSessionCookie('abc123', { maxAgeSec: 604800, secure: true });
check('HTTPS：含 Secure', /; Secure/.test(https), https);
check('HTTPS：其余属性不变', /HttpOnly/.test(https) && /SameSite=Lax/.test(https) && /Max-Age=604800/.test(https), https);

check('小数 Max-Age 向下取整', /Max-Age=604799/.test(buildSessionCookie('t', { maxAgeSec: 604799.9 })), buildSessionCookie('t', { maxAgeSec: 604799.9 }));
check('Max-Age 为 0 时省略', !/Max-Age/.test(buildSessionCookie('t', { maxAgeSec: 0 })), buildSessionCookie('t', { maxAgeSec: 0 }));
check('无 opts 也能生成', typeof buildSessionCookie('t') === 'string' && buildSessionCookie('t').startsWith('t2a=t'));

// ---------- clearSessionCookie ----------
const clr = clearSessionCookie({ secure: false });
check('清理：值为空', clr.startsWith('t2a=;'), clr);
check('清理：Max-Age=0', /Max-Age=0/.test(clr), clr);
check('清理 HTTPS 也带 Secure', /Secure/.test(clearSessionCookie({ secure: true })));

// ---------- 一致性 ----------
check('登录与清理的 Path/HttpOnly/SameSite 一致', ['Path=/', 'HttpOnly', 'SameSite=Lax'].every((a) => http.includes(a) && clr.includes(a)));

console.log('\n合计 ' + (pass + fail) + ' 项：' + pass + ' 通过，' + fail + ' 失败');
process.exit(fail ? 1 : 0);
