// 运行时自愈：aiserver 与 ai-agent 之间的 AHA 链路一旦断掉就不会自己重连
// （典型现象：网关重连只重建了「网关→agent」，aiserver 内部的 AHA 客户端仍断着，
//   于是握手成功、execute_command 照发，但 model/model_list 永远超时）。
// 这种「挂起」没法在协议层修，唯一有效动作是让 aiserver 重启（看护器会把 agent 一起带起来）。
//
// 本模块只做判定，不动进程：达到阈值时调用注入的 restart()。
function createHealer(opts = {}) {
  const {
    log = () => {},
    restart = async () => {},
    enabled = true,
    threshold = 3,          // 窗口内累计多少次失败触发
    windowMs = 10 * 60e3,   // 统计窗口
    cooldownMs = 5 * 60e3,  // 两次自愈的最小间隔
    now = () => Date.now(),
    canHeal = () => true,   // 例如「有请求在跑就先别杀」
  } = opts;

  let failures = [];
  let lastHealAt = 0;
  let lastKind = null;
  let heals = 0;
  let healing = false;

  function prune(t) {
    const from = t - windowMs;
    if (failures.length && failures[0].t < from) failures = failures.filter((f) => f.t >= from);
  }

  function status() {
    prune(now());
    return {
      enabled, threshold, windowMs, cooldownMs,
      recentFailures: failures.length,
      recentWeight: failures.reduce((a, f) => a + (f.weight || 1), 0),
      recentKinds: failures.map((f) => f.kind),
      lastHealAt, lastKind, heals, healing,
    };
  }

  async function forceHeal(reason) {
    if (healing) return false;
    healing = true;
    lastHealAt = now();
    lastKind = reason || 'manual';
    heals += 1;
    failures = [];
    log('[heal] 触发运行时重启：' + (reason || 'manual') + '（aiserver 会由看护器在 ~15s 内拉起）');
    try {
      await restart(reason || 'manual');
      log('[heal] 重启动作已下发');
      return true;
    } catch (e) {
      log('[heal] 重启失败: ' + (e && e.message ? e.message : e));
      return false;
    } finally {
      healing = false;
    }
  }

  // 记录一次上游调用失败；weight=2 表示「用户已经受影响」（真实对话超时），权重更高、可单次触发
  function noteFailure(kind = 'rpc', weight = 1) {
    const t = now();
    failures.push({ t, kind, weight: Math.max(1, Number(weight) || 1) });
    prune(t);
    if (!enabled) return false;
    const total = failures.reduce((a, f) => a + (f.weight || 1), 0);
    if (total < threshold) return false;
    if (t - lastHealAt < cooldownMs) return false;
    let ok = true;
    try { ok = canHeal() !== false; } catch { ok = true; }
    if (!ok) {
      log('[heal] 已达到阈值（' + kind + '），但有请求在跑，暂缓重启');
      return false;
    }
    const kinds = Array.from(new Set(failures.map((f) => f.kind))).join(',');
    void forceHeal(kinds + ' 失败累计权重 ' + total + '（阈值 ' + threshold + '）');
    return true;
  }

  // 成功一次即清零，避免偶发超时触发误杀
  function noteSuccess() {
    if (failures.length) failures = [];
  }

  return { noteFailure, noteSuccess, status, forceHeal };
}

module.exports = { createHealer };
