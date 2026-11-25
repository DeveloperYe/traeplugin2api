// 干净副本验收：①SSE 心跳不再吞帧 ②登录防爆破 ③生成配置生效
// 用法：node _verify.cjs <port> <password>
const PORT = process.argv[2] || "18799";
const PWD = process.argv[3] || "";
const BASE = "http://127.0.0.1:" + PORT;

async function streamChat() {
  const t0 = Date.now();
  const r = await fetch(BASE + "/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + PWD },
    body: JSON.stringify({
      model: "qwen-3.6-plus",
      stream: true,
      messages: [{ role: "user", content: "用大约 400 字讲清 TCP 三次握手与四次挥手，分点列出。" }],
    }),
    signal: AbortSignal.timeout(180000),
  });
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = "", content = "", firstAt = 0, finish = null, done = false, frames = 0, badFrames = 0;
  while (true) {
    const { done: end, value } = await reader.read();
    if (end) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      if (frame.startsWith(":")) continue;           // 心跳注释帧
      let sawData = false;
      for (const line of frame.split("\n")) {
        if (!line.startsWith("data: ")) continue;
        sawData = true;
        const data = line.slice(6).trim();
        if (data === "[DONE]") { done = true; continue; }
        try {
          const j = JSON.parse(data);
          frames++;
          const ch = j.choices && j.choices[0];
          if (ch) {
            if (ch.delta && ch.delta.content) { if (!firstAt) firstAt = Date.now() - t0; content += ch.delta.content; }
            if (ch.finish_reason) finish = ch.finish_reason;
          }
        } catch { badFrames++; }
      }
      if (!sawData && frame.trim() && !frame.startsWith(":")) badFrames++;
    }
  }
  const ms = Date.now() - t0;
  console.log(`  [流式] ${ms}ms 首字${firstAt}ms 帧${frames} 正文${content.length}字 finish=${finish} [DONE]=${done} 坏帧=${badFrames}`);
  console.log(`  正文开头: ${JSON.stringify(content.slice(0, 50))}`);
  return { ok: content.length > 100 && finish === "stop" && done && badFrames === 0, ms };
}

async function loginBrute() {
  let last = 0, codes = [];
  for (let i = 0; i < 12; i++) {
    const r = await fetch(BASE + "/api/login", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "wrong-" + i }),
    });
    codes.push(r.status);
    last = r.status;
  }
  console.log("  [防爆破] 12 次错误口令的状态码: " + codes.join(",") + "  → 出现 429: " + codes.includes(429));
  return { ok: codes.includes(429) };
}

async function loginOk() {
  const r = await fetch(BASE + "/api/login", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: PWD }),
  });
  const j = await r.json().catch(() => ({}));
  const setCookie = r.headers.get("set-cookie") || "";
  console.log("  [正确口令] HTTP " + r.status + " ok=" + j.ok + " 有 Cookie: " + /t2a=/.test(setCookie));
  return { ok: r.status === 200 && !!j.ok };
}

(async () => {
  console.log("== 干净副本验收（" + BASE + "）==");
  const a = await streamChat();
  const b = await loginBrute();
  const c = await loginOk();
  console.log("\n  结论: 流式=" + (a.ok ? "✅" : "❌") + "  防爆破=" + (b.ok ? "✅" : "❌") + "  正常登录=" + (c.ok ? "✅" : "❌"));
  process.exit(a.ok && b.ok && c.ok ? 0 : 1);
})();
