// A2 + A3 的回归测试：
//  - lib/health.cjs 的三项自检判定（组合覆盖）
//  - lib/aha.cjs 的 _dropConnection 必须立刻 reject 在飞 RPC（不再等 RPC 超时）
const { computeChecks } = require('./lib/health.cjs');
const { AhaClient } = require('./lib/aha.cjs');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra === undefined ? '' : '  → ' + JSON.stringify(extra))); }
}

// ---------- health.cjs ----------
const good = computeChecks({
  connected: true, socket: 'ipc://C:/trae-ide/aha/aha/vscode_ai_agent_1.sock',
  workspaceFolder: 'D:/ws', hasCreds: true,
  fsExists: () => true, fsWritable: () => true,
});
check('全绿时 checks.ok = true', good.ok === true);
check('runtime.detail 为「已连上上游」', good.runtime.detail === '已连上上游', good.runtime.detail);
check('workspace.writable 被记录', good.workspace.writable === true);
check('creds.detail 为「凭据就绪」', good.creds.detail === '凭据就绪', good.creds.detail);

const noSocket = computeChecks({ connected: false, socket: '', workspaceFolder: 'D:/ws', hasCreds: true, fsExists: () => true });
check('没 socket → runtime.ok=false 且总 ok=false', noSocket.runtime.ok === false && noSocket.ok === false);
check('没 socket 文案提示运行时未启动', /运行时未启动/.test(noSocket.runtime.detail), noSocket.runtime.detail);

const deadSocket = computeChecks({ connected: false, socket: 'ipc://x.sock', workspaceFolder: 'D:/ws', hasCreds: true, fsExists: () => true });
check('有 socket 但未连上 → 文案区分为死 socket', /死 socket|已退出/.test(deadSocket.runtime.detail), deadSocket.runtime.detail);

const noWs = computeChecks({ connected: true, socket: 'ipc://x', workspaceFolder: '', hasCreds: true });
check('未配置 workspace → workspace.ok=false', noWs.workspace.ok === false);
check('未配置 workspace 文案', /未配置 workspace_folder/.test(noWs.workspace.detail), noWs.workspace.detail);

const missingWs = computeChecks({ connected: true, socket: 'ipc://x', workspaceFolder: 'D:/nope', hasCreds: true, fsExists: () => false });
check('目录不存在 → 提示 992501', /992501/.test(missingWs.workspace.detail), missingWs.workspace.detail);

const roWs = computeChecks({ connected: true, socket: 'ipc://x', workspaceFolder: 'D:/ws', hasCreds: true, fsExists: () => true, fsWritable: () => false });
check('目录不可写 → workspace.ok=false', roWs.workspace.ok === false && roWs.workspace.writable === false);

const noCreds = computeChecks({ connected: true, socket: 'ipc://x', workspaceFolder: 'D:/ws', hasCreds: false });
check('没凭据 → creds.ok=false 且提示续期', noCreds.creds.ok === false && /立即续期/.test(noCreds.creds.detail), noCreds.creds.detail);

const credsErr = computeChecks({ connected: true, socket: 'ipc://x', workspaceFolder: 'D:/ws', hasCreds: true, credsError: 'refresh 401' });
check('有凭据但有续期错误 → creds.ok 仍 true 且带错误', credsErr.creds.ok === true && /refresh 401/.test(credsErr.creds.detail));

const empty = computeChecks();
check('空输入不抛异常且 ok=false', empty.ok === false);

// ---------- aha._dropConnection ----------
const client = new AhaClient({ log: () => {} });
let rejected = 0, cleared = 0;
const fakeTimer = { _id: 1 };
// 直接塞两个 pending 条目，模拟在飞 RPC
const mk = () => ({
  timer: setTimeout(() => { cleared++; }, 60e3),
  resolve: () => {},
  reject: () => { rejected++; },
});
client.pending.set('rpc-1', mk());
client.pending.set('rpc-2', mk());
client.connected = true;
client.sock = { close() {} };
client._dropConnection('测试断开');
check('断链后两个在飞 RPC 都被 reject', rejected === 2, rejected);
check('pending 表被清空', client.pending.size === 0, client.pending.size);
check('connected 置 false', client.connected === false);

// 已断开时再次调用不应重复 reject（幂等）
let again = 0;
client.pending.set('rpc-3', { timer: null, resolve: () => {}, reject: () => { again++; } });
client._dropConnection('再断一次');
check('已断开时重复调用不再触发 reject', again === 0 && rejected === 2, again);

// 清理定时器，避免测试进程挂住
for (const p of client.pending.values()) try { clearTimeout(p.timer); } catch {}
setTimeout(() => {
  console.log('\n合计 ' + (pass + fail) + ' 项：' + pass + ' 通过，' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
}, 50);
