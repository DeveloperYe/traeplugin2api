// 简单的两级限流（纯函数 + 小状态，便于单测）：
//  - 每分钟请求数上限（按 key，例如 api_key 或客户端 IP）
//  - 同时在飞上限（全局，防止一个客户端把账号池打满）
// 默认 0 = 不限制，行为与以前一致。
function createLimiter(opts) {
  const perMin = Math.max(0, Number(opts && opts.perMin) || 0);
  const maxConcurrent = Math.max(0, Number(opts && opts.maxConcurrent) || 0);
  const windowMs = 60e3;
  const hits = new Map();   // key -> { startAt, count }
  let active = 0;

  function sweep(now) {
    for (const [k, v] of hits) if (now - v.startAt >= windowMs) hits.delete(k);
  }

  // 返回 { ok:true } 或 { ok:false, reason, retryAfterMs }
  function acquire(key, now = Date.now()) {
    const k = String(key || 'anon');
    if (perMin > 0) {
      sweep(now);
      const rec = hits.get(k);
      if (!rec || now - rec.startAt >= windowMs) hits.set(k, { startAt: now, count: 1 });
      else if (rec.count >= perMin) return { ok: false, reason: 'rate', retryAfterMs: Math.max(0, rec.startAt + windowMs - now) };
      else rec.count++;
    }
    if (maxConcurrent > 0 && active >= maxConcurrent) {
      return { ok: false, reason: 'concurrency', retryAfterMs: 1000 };
    }
    active++;
    return { ok: true, active };
  }

  function release() {
    active = Math.max(0, active - 1);
  }

  return {
    acquire,
    release,
    config: { perMin, maxConcurrent },
    state: () => ({ active, keys: hits.size }),
  };
}

module.exports = { createLimiter };
