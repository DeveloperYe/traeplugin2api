// 流式保活与状态词表（抽出来便于单测）

// 静默超过 kaMs 就该发一个 delta:{} 空帧（客户端只认真 chunk，SSE 注释不算）
function shouldKeepalive(lastChunkAt, now, kaMs) {
  const ka = Number(kaMs) || 0;
  if (ka <= 0) return false;
  if (!Number.isFinite(lastChunkAt)) return false;
  return Number(now) - Number(lastChunkAt) >= ka;
}

// 兜底：每 N 次心跳补一条 SSE 注释（老客户端/代理链路曾需要它来保活 TCP）
function shouldPing(tick, everyNTicks) {
  const n = Number(everyNTicks) || 0;
  if (n <= 0) return false;
  return Number(tick) > 0 && Number(tick) % n === 0;
}

// ---- 请求状态词表 ----
// 这些是 recordRequest 会写进 journal 的状态；面板 STATUS_LABEL 必须全覆盖（test-status-labels 校验）
const STATUS = {
  OK: 'ok',
  TOOL_CALLS: 'tool_calls',
  ERROR: 'error',
  AGENT_OFFLINE: 'agent_offline',
  UPSTREAM_EMPTY: 'upstream_empty',
  UPSTREAM_ERROR: 'upstream_error',
  UPSTREAM_TIMEOUT: 'upstream_timeout',
  IDLE_TIMEOUT: 'idle_timeout',
  TIMEOUT: 'timeout',
  TRUNCATED_CALL: 'truncated_call',
  TRUNCATED_OUTPUT: 'truncated_output',
  REASONING_ABORTED: 'reasoning_aborted',
  EMPTY_CONTENT: 'empty_content',
  UNDECLARED_TOOL: 'undeclared_tool',
  CLIENT_GONE: 'client_gone',
};

// 失败（err）与非正常但不算失败（warn）的分类，供 /api/errors 与面板着色使用
const FAIL_LEVEL = {
  ok: null,
  tool_calls: null,
  reasoning_aborted: 'warn',
  empty_content: 'warn',
  truncated_output: 'warn',
  undeclared_tool: 'warn',
  client_gone: 'warn',
  error: 'err',
  agent_offline: 'err',
  upstream_empty: 'err',
  upstream_error: 'err',
  upstream_timeout: 'err',
  idle_timeout: 'err',
  timeout: 'err',
  truncated_call: 'err',
};

function levelOf(status) {
  return Object.prototype.hasOwnProperty.call(FAIL_LEVEL, status) ? FAIL_LEVEL[status] : 'err';
}

function isFailure(status) {
  return levelOf(status) !== null;
}

module.exports = { shouldKeepalive, shouldPing, STATUS, FAIL_LEVEL, levelOf, isFailure };
