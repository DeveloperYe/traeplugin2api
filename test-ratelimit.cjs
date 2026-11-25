// 限流器（P2 #10）：每分钟窗口、并发上限、release、配置热切换
const { createLimiter } = require('./lib/ratelimit.cjs');

let pass = 0, fail = 0;
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra === undefined ? '' : '  → ' + JSON.stringify(extra))); }
};

// ---------- 全关（默认）----------
const off = createLimiter({ perMin: 0, maxConcurrent: 0 });
let allOk = true;
for (let i = 0; i < 500; i++) if (!off.acquire('k' + i, 1000).ok) allOk = false;
check('两档都 0 时永不限流', allOk);
check('关闭时 active 仍计数', off.state().active === 500, off.state());

// ---------- 每分钟上限 ----------
const rl = createLimiter({ perMin: 3, maxConcurrent: 0 });
const t = 2000000;
const results = [0, 100, 200, 300].map((d) => rl.acquire('a', t + d));
check('前 3 次放行', results.slice(0, 3).every((r) => r.ok), results.map((r) => r.ok));
check('第 4 次被拦', results[3].ok === false && results[3].reason === 'rate');
check('被拦时给出 retryAfterMs', results[3].retryAfterMs > 0 && results[3].retryAfterMs <= 60000, results[3].retryAfterMs);

// 不同 key 互不影响
check('不同 key 各自计数', rl.acquire('b', t + 400).ok === true);

// 窗口滑动后恢复
check('过一分钟后恢复', rl.acquire('a', t + 60001).ok === true);

// 窗口内的第 4 次仍被拦（说明计数没有跨窗口泄漏）
const rl2 = createLimiter({ perMin: 2, maxConcurrent: 0 });
rl2.acquire('x', t);
rl2.acquire('x', t + 1);
check('窗口内达上限即拦', rl2.acquire('x', t + 2).ok === false);
check('窗口过后重新放行', rl2.acquire('x', t + 60000).ok === true);

// ---------- 并发上限 ----------
const cc = createLimiter({ perMin: 0, maxConcurrent: 2 });
check('并发 1 放行', cc.acquire('a').ok === true);
check('并发 2 放行', cc.acquire('b').ok === true);
const third = cc.acquire('c');
check('并发超限被拦', third.ok === false && third.reason === 'concurrency');
check('超限时给重试建议', third.retryAfterMs === 1000);
cc.release();
check('释放后可以再进', cc.acquire('c').ok === true);
cc.release(); cc.release(); cc.release();
check('多释放不会变负数', cc.state().active === 0, cc.state().active);

// ---------- 配置与状态 ----------
const conf = createLimiter({ perMin: 10, maxConcurrent: 4 });
check('config 反映配置', conf.config.perMin === 10 && conf.config.maxConcurrent === 4);
check('非法配置按 0 处理', createLimiter({ perMin: -5, maxConcurrent: 'x' }).config.perMin === 0);

// 空的 key 归到 anon（避免 undefined 把 Map 撑出奇怪键）
const anon = createLimiter({ perMin: 1, maxConcurrent: 0 });
anon.acquire(undefined, t);
check('无 key 时归到 anon 并受限', anon.acquire(undefined, t + 1).ok === false);

console.log('\n合计 ' + (pass + fail) + ' 项：' + pass + ' 通过，' + fail + ' 失败');
process.exit(fail ? 1 : 0);
