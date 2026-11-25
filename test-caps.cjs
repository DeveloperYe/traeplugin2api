// 容量口径：覆盖表优先、别名一致、打满上限判定（P3）
const { capacityOf, computeCapHit, modelAliasFields } = require('./lib/caps.cjs');

let pass = 0, fail = 0;
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra === undefined ? '' : '  → ' + JSON.stringify(extra))); }
};

const entry = {
  name: 'DeepSeek-V4-Pro',
  context_window_size: { default: 116000 },
  context_window_tokens: { dev: 116000 },
  prompt_max_tokens: 100000,
  max_tokens: 16000,
};

// 1) 没有覆盖表 → 用上游声明值
const bare = capacityOf(entry, {});
check('无覆盖时用上游声明值', bare.context_window === 116000 && bare.max_tokens === 16000, bare);

// 2) 覆盖表优先
const cfg = {
  context_window_override: { 'DeepSeek-V4-Pro': 1048576 },
  prompt_max_tokens_override: { 'DeepSeek-V4-Pro': 1048576 },
  max_tokens_override: { 'DeepSeek-V4-Pro': 131072 },
  max_tokens_note: { 'DeepSeek-V4-Pro': '官方 384K' },
};
const capped = capacityOf(entry, cfg);
check('上下文覆盖生效', capped.context_window === 1048576);
check('输入预算覆盖生效', capped.prompt_max_tokens === 1048576);
check('输出上限覆盖生效', capped.max_tokens === 131072);
check('备注透传', capped.max_tokens_note === '官方 384K');

// 3) 未配置覆盖的模型仍用声明值
const other = capacityOf({ name: 'glm-5', max_tokens: 16000, prompt_max_tokens: 100000 }, cfg);
check('未覆盖的模型不受影响', other.max_tokens === 16000 && other.context_window === null, other);

// 4) 别名三件套与主字段一致
const alias = modelAliasFields(capped);
check('context_length 与 context_window 一致', alias.context_length === capped.context_window);
check('max_input_tokens 与 context_window 一致', alias.max_input_tokens === capped.context_window);
check('max_output_tokens 与 max_tokens 一致', alias.max_output_tokens === capped.max_tokens);
check('limit.context/output 一致', alias.limit.context === capped.context_window && alias.limit.output === capped.max_tokens);

// 5) 打满上限判定：只有「恰好等于」才算
check('恰好等于上限 → true', computeCapHit({ completion_tokens: 16000 }, 16000) === true);
check('超过上限（Pro 43k vs 声明 16k）→ false', computeCapHit({ completion_tokens: 43049 }, 16000) === false);
check('未到上限 → false', computeCapHit({ completion_tokens: 808 }, 131072) === false);
check('无 usage → false', computeCapHit(null, 16000) === false);
check('上限为 0 → false', computeCapHit({ completion_tokens: 100 }, 0) === false);
check('completion 缺失 → false', computeCapHit({}, 16000) === false);

console.log('\n合计 ' + (pass + fail) + ' 项：' + pass + ' 通过，' + fail + ' 失败');
process.exit(fail ? 1 : 0);
