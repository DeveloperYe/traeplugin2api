// 容量口径（抽出来便于单测）：
//  - capacityOf(modelEntry, cfg)：/v1/models 与 /api/status 共用的「上下文/输入预算/输出上限」计算
//  - computeCapHit(usage, modelCap)：打满模型声明上限时判定为截断（只有「恰好等于」才算）
function capacityOf(m, cfg) {
  // 用 cfg['key'] 形式访问：tools/verify-docs.cjs 靠这个模式核对「文档声明的键，代码里真的读了」
  const name = m && m.name;
  const context_window = ((cfg && cfg['context_window_override']) || {})[name]
    ?? m?.context_window_tokens?.dev ?? m?.context_window_size?.default ?? null;
  const prompt_max_tokens = ((cfg && cfg['prompt_max_tokens_override']) || {})[name] ?? m?.prompt_max_tokens ?? null;
  const max_tokens = ((cfg && cfg['max_tokens_override']) || {})[name] ?? m?.max_tokens ?? null;
  const max_tokens_note = ((cfg && cfg['max_tokens_note']) || {})[name] ?? null;
  return { context_window, prompt_max_tokens, max_tokens, max_tokens_note };
}

// 只有「恰好打到声明值」才算截断：DeepSeek-V4-Pro 实测能到 43,049，用 >= 会把它误标成 length
function computeCapHit(usage, modelCap) {
  const cap = Number(modelCap) || 0;
  const used = Number(usage && usage.completion_tokens) || 0;
  if (!cap || !used) return false;
  return used === cap;
}

// /v1/models 的兼容别名：不同客户端认不同字段名
function modelAliasFields(cap) {
  const c = cap || {};
  return {
    context_length: c.context_window ?? null,
    max_input_tokens: c.context_window ?? null,
    max_output_tokens: c.max_tokens ?? null,
    limit: { context: c.context_window ?? null, output: c.max_tokens ?? null },
  };
}

module.exports = { capacityOf, computeCapHit, modelAliasFields };
