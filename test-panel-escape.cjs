// 面板转义回归测试：从 public/index.html 里取出 esc()，验证它真的把危险字符转义
// （防存储型 XSS：模型名、报错文本、调用方传入的 model 都会进面板表格）
const fs = require("fs");
const assert = require("assert");
const path = require("path");

const html = fs.readFileSync(path.join(__dirname, "public", "index.html"), "utf8");

// 1) 取出 esc 实现
const start = html.indexOf("const esc = (v) =>");
const end = html.indexOf("async function getJSON");
assert.ok(start > 0 && end > start, "找不到 esc() 定义");
const escSrc = html.slice(start, end).trim();
const esc = new Function("return (" + escSrc.replace(/^const esc =\s*/, "").replace(/;+\s*$/, "") + ")")();

let n = 0, fail = 0;
const t = (name, fn) => {
  n++;
  try { fn(); console.log("  ✓ " + name); }
  catch (e) { fail++; console.log("  ✗ " + name + "  →  " + e.message); }
};

t("尖括号被转义", () => {
  assert.strictEqual(esc("<img src=x onerror=alert(1)>"), "&lt;img src=x onerror=alert(1)&gt;");
});
t("双引号被转义（防属性逃逸）", () => {
  assert.strictEqual(esc('" onmouseover="alert(1)'), "&quot; onmouseover=&quot;alert(1)");
});
t("单引号被转义", () => {
  assert.strictEqual(esc("a'b"), "a&#39;b");
});
t("& 先转义，不会二次放大", () => {
  assert.strictEqual(esc("&lt;script&gt;"), "&amp;lt;script&amp;gt;");
});
t("script 标签整段失效", () => {
  const out = esc("<script>alert('x')</script>");
  assert.ok(!/[<>]/.test(out), "输出里不该再有尖括号");
  assert.strictEqual(out, "&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt;");
});
t("中文与普通模型名原样保留", () => {
  assert.strictEqual(esc("qwen-3.6-plus 正常"), "qwen-3.6-plus 正常");
});
t("null / undefined / 数字都安全", () => {
  assert.strictEqual(esc(null), "");
  assert.strictEqual(esc(undefined), "");
  assert.strictEqual(esc(0), "0");
  assert.strictEqual(esc(123), "123");
});

// 2) 结构断言：所有会拼外部数据的 innerHTML 必须经过 esc()
t("模型表三列都过 esc()", () => {
  assert.ok(html.includes("esc(m.name)") && html.includes("esc(m.display_name)") && html.includes("esc(m.model_type)"));
  assert.ok(!html.includes("${m.name}"), "不应再有未转义的 ${m.name}");
});
t("凭据表 / 请求日志 / 错误汇总都过 esc()", () => {
  for (const k of ["esc(k)", "esc(v)", "esc(r.model)", "esc(r.kind)", "esc(r.type)", "esc(r.lastModel)", "esc(r.sample)", "esc((r.callNames || []).join(', '))"]) {
    assert.ok(html.includes(k), "缺少 " + k);
  }
});
t("模型下拉不再用 innerHTML 互相复制", () => {
  assert.ok(html.includes("replaceChildren("), "应改用 replaceChildren");
  assert.ok(!html.includes("sm.innerHTML = sel.innerHTML"));
});

console.log(`\n合计 ${n - fail}/${n} 通过`);
process.exit(fail ? 1 : 0);
