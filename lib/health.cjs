// 运行时健康自检：把「通道 / 工作区 / 凭据」三项状态算成结构化结果，供 /healthz 使用。
// 纯函数（不读全局、不碰网络），便于单测；server.cjs 只负责把实时值取出来传进来。
function computeChecks(input) {
  const i = input || {};
  const checks = {};

  // 1) 上游通道：socket 连上且地址已知
  const socket = typeof i.socket === 'string' ? i.socket : '';
  const connected = i.connected === true;
  checks.runtime = {
    ok: connected && !!socket,
    connected,
    socket: socket || null,
    detail: !socket
      ? '没有可用的 aha socket（运行时未启动？）'
      : (connected ? '已连上上游' : '有 socket 但未连上（死 socket / 运行时已退出）'),
  };

  // 2) 工作区锚点：目录必须存在（create_chat_session 要求）
  const ws = typeof i.workspaceFolder === 'string' ? i.workspaceFolder.trim() : '';
  let wsExists = null, wsWritable = null;
  if (ws && i.fsExists) wsExists = !!i.fsExists(ws);
  if (wsExists && i.fsWritable) wsWritable = !!i.fsWritable(ws);
  checks.workspace = {
    ok: !!ws && wsExists === true && (wsWritable === null || wsWritable === true),
    path: ws || null,
    exists: wsExists,
    writable: wsWritable,
    detail: !ws
      ? '未配置 workspace_folder'
      : (wsExists === false
        ? 'workspace_folder 指向的目录不存在（上游会报 992501）'
        : (wsWritable === false ? 'workspace_folder 不可写' : '工作区可用')),
  };

  // 3) 凭据：有 JWT 且没有未消解的凭据错误
  const hasCreds = i.hasCreds === true;
  checks.creds = {
    ok: hasCreds,
    hasCreds,
    lastError: i.credsError || null,
    detail: hasCreds
      ? (i.credsError ? '有凭据但最近有续期错误：' + String(i.credsError).slice(0, 120) : '凭据就绪')
      : '没有可用凭据（面板「凭据」→ 立即续期 / 面板内登录）',
  };

  checks.ok = !!(checks.runtime.ok && checks.workspace.ok && checks.creds.ok);
  return checks;
}

module.exports = { computeChecks };
