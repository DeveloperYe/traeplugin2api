// 回归测试：运行时自愈判定（不看进程，只验判定逻辑）
const { createHealer } = require("D:/Users/Administrator/Documents/deepseek-harness/work/trae2api-release/lib/healer.cjs");

let pass = 0, fail = 0;
const ck = (name, cond, extra = "") => {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (extra ? "  → " + extra : "")); }
};

function mk(opts = {}) {
  let clock = 1_000_000;
  const logLines = [];
  let restarts = 0;
  const h = createHealer({
    log: (m) => logLines.push(m),
    restart: async () => { restarts++; },
    threshold: 3, windowMs: 60_000, cooldownMs: 120_000,
    now: () => clock,
    ...opts,
  });
  return { h, logs: logLines, restarts: () => restarts, tick: (ms) => { clock += ms; }, at: () => clock };
}

(async () => {
  console.log("=== 1) 未达阈值不动作；达阈值触发一次 ===");
  {
    const { h, restarts } = mk();
    h.noteFailure("model_list"); h.noteFailure("model_list");
    ck("2 次失败未触发", restarts() === 0);
    const fired = h.noteFailure("model_list");
    ck("第 3 次返回 true（本次触发）", fired === true);
    await new Promise((r) => setImmediate(r));
    ck("restart 被调用 1 次", restarts() === 1);
    const st = h.status();
    ck("heals 计数 = 1", st.heals === 1, JSON.stringify(st));
    ck("触发后失败列表已清空", st.recentFailures === 0);
  }

  console.log("\n=== 2) 成功一次即清零（偶发超时不误杀）===");
  {
    const { h, restarts } = mk();
    h.noteFailure("model_list"); h.noteFailure("model_list");
    h.noteSuccess();
    h.noteFailure("model_list"); h.noteFailure("model_list");
    ck("清零后仅 2 次，不触发", restarts() === 0);
  }

  console.log("\n=== 3) 窗口外的旧失败被剪掉 ===");
  {
    const { h, restarts, tick } = mk();
    h.noteFailure("model_list"); h.noteFailure("model_list");
    tick(61_000);                     // 超过 60s 窗口
    h.noteFailure("model_list");
    ck("窗口内只剩 1 次，不触发", restarts() === 0, JSON.stringify(h.status()));
  }

  console.log("\n=== 4) 冷却期内不重复杀 ===");
  {
    const { h, restarts, tick } = mk();
    h.noteFailure("a"); h.noteFailure("a"); h.noteFailure("a");
    await new Promise((r) => setImmediate(r));
    tick(1_000);                      // 冷却 120s 内
    h.noteFailure("a"); h.noteFailure("a"); h.noteFailure("a");
    await new Promise((r) => setImmediate(r));
    ck("冷却期内只重启了 1 次", restarts() === 1, String(restarts()));
  }

  console.log("\n=== 5) 有请求在跑时暂缓（canHeal=false）===");
  {
    let busy = true;
    const { h, restarts } = mk({ canHeal: () => !busy });
    h.noteFailure("x"); h.noteFailure("x");
    const fired = h.noteFailure("x");
    await new Promise((r) => setImmediate(r));
    ck("busy 时不触发", fired === false && restarts() === 0);
    busy = false;
    h.noteFailure("x");
    await new Promise((r) => setImmediate(r));
    ck("空闲后再次失败即触发", restarts() === 1, String(restarts()));
  }

  console.log("\n=== 6) 关闭开关后完全不动 ===");
  {
    const { h, restarts } = mk({ enabled: false });
    for (let i = 0; i < 10; i++) h.noteFailure("x");
    await new Promise((r) => setImmediate(r));
    ck("enabled=false 不触发", restarts() === 0);
    ck("但仍记录失败数", h.status().recentFailures === 10, String(h.status().recentFailures));
  }

  console.log("\n=== 7) forceHeal 手动触发 ===");
  {
    const { h, restarts, logs } = mk();
    const ok = await h.forceHeal("manual test");
    ck("forceHeal 返回 true", ok === true);
    ck("restart 被调用", restarts() === 1);
    ck("日志含触发说明", logs.some((l) => l.includes("触发运行时重启")), logs.join(" | "));
  }

  console.log("\n=== 8) 权重语义：用户已受影响的失败单次即触发 ===");
  {
    const { h, restarts } = mk({ threshold: 2 });
    const fired = h.noteFailure("chat", 2);      // weight=2，阈值 2 → 单次即达阈值
    await new Promise((r) => setImmediate(r));
    ck("单次 weight=2 触发", fired === true && restarts() === 1, "fired=" + fired + " restarts=" + restarts());
  }
  {
    const { h, restarts } = mk({ threshold: 2 });
    const fired = h.noteFailure("probe", 1);     // weight=1，阈值 2 → 不触发
    await new Promise((r) => setImmediate(r));
    ck("单次 weight=1 不触发", fired === false && restarts() === 0);
    const st = h.status();
    ck("status 暴露 recentWeight", st.recentWeight === 1, JSON.stringify(st));
    const again = h.noteFailure("probe", 1);
    await new Promise((r) => setImmediate(r));
    ck("两次 weight=1 触发", again === true && restarts() === 1, "again=" + again + " restarts=" + restarts());
  }

  console.log("\n合计 " + (pass + fail) + " 项：" + pass + " 通过，" + fail + " 失败");
  process.exit(fail ? 1 : 0);
})();
