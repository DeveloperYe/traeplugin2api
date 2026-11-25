// 保活判定 + 状态词表（P3）
const { shouldKeepalive, shouldPing, STATUS, FAIL_LEVEL, levelOf, isFailure } = require('./lib/stream-meta.cjs');

let pass = 0, fail = 0;
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra === undefined ? '' : '  → ' + JSON.stringify(extra))); }
};

// ---------- 空帧保活 ----------
const t0 = 1000000;
check('静默未到阈值 → 不发', shouldKeepalive(t0, t0 + 5000, 20000) === false);
check('静默正好到阈值 → 发', shouldKeepalive(t0, t0 + 20000, 20000) === true);
check('静默超过阈值 → 发', shouldKeepalive(t0, t0 + 25000, 20000) === true);
check('阈值 0/关闭 → 永不发', shouldKeepalive(t0, t0 + 999999, 0) === false);
check('阈值未配置 → 永不发', shouldKeepalive(t0, t0 + 999999, undefined) === false);
check('时钟回拨（now < last）→ 不发', shouldKeepalive(t0, t0 - 5000, 20000) === false);
check('lastChunkAt 非数字 → 不发', shouldKeepalive(undefined, t0, 20000) === false);

// 真实场景：CALL 参数生成期静默 12.9s，配置 15s → 不该发；配置 10s → 该发
check('静默 12.9s / 阈值 15s → 不发', shouldKeepalive(t0, t0 + 12900, 15000) === false);
check('静默 12.9s / 阈值 10s → 发', shouldKeepalive(t0, t0 + 12900, 10000) === true);

// ---------- SSE 注释兜底 ----------
check('每 15 拍补一次注释', shouldPing(15, 15) === true && shouldPing(16, 15) === false);
check('注释开关为 0 → 不补', shouldPing(30, 0) === false);
check('第 0 拍不补', shouldPing(0, 15) === false);

// ---------- 状态词表 ----------
check('状态表含 undeclared_tool', STATUS.UNDECLARED_TOOL === 'undeclared_tool');
check('状态表含 client_gone', STATUS.CLIENT_GONE === 'client_gone');
check('ok 不算失败', isFailure('ok') === false);
check('tool_calls 不算失败', isFailure('tool_calls') === false);
check('undeclared_tool 算失败但级别是 warn', isFailure('undeclared_tool') === true && levelOf('undeclared_tool') === 'warn');
check('truncated_output 是 warn', levelOf('truncated_output') === 'warn');
check('idle_timeout 是 err', levelOf('idle_timeout') === 'err');
check('unknown 状态按 err 兜底', levelOf('something_new') === 'err' && isFailure('something_new') === true);
check('FAIL_LEVEL 覆盖 STATUS 全集', Object.values(STATUS).every((st) => Object.prototype.hasOwnProperty.call(FAIL_LEVEL, st)),
  Object.values(STATUS).filter((st) => !Object.prototype.hasOwnProperty.call(FAIL_LEVEL, st)));

console.log('\n合计 ' + (pass + fail) + ' 项：' + pass + ' 通过，' + fail + ' 失败');
process.exit(fail ? 1 : 0);
