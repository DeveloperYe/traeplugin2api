// 模型名解析：别名映射 + 未知模型拦截 + 近似提示。
// 背景：上游对**不存在的模型名**不会报错，而是用账号默认模型回答
//（目录里 is_default=true 的那个，当前是 Doubao-Seed-Code）——
// 于是客户端显示「seed 2.1 turbo」、实际跑的是别的模型，属于最难发现的静默替换。
// 这里把「名字 → 真实模型」的决定权收回到网关，并且明确报错/提示。

/** 取名字的近似候选（去分隔符后比较，短名优先），用于报错时给人指路 */
function suggest(name, names, n = 4) {
  const strip = (x) => String(x || '').toLowerCase().replace(/[-_.\s]/g, '');
  const s = strip(name);
  const scored = names.map((c) => {
    const t = strip(c);
    const raw2 = String(c || '');
    let score = 0;
    if (t === s) score = 100;                                // 只差分隔符/大小写
    else if (t.startsWith(s) || s.startsWith(t)) score = 60 - Math.abs(t.length - s.length);
    else {
      let i = 0;
      while (i < Math.min(t.length, s.length) && t[i] === s[i]) i++;
      score = i * 5;
      for (const piece of String(name || '').toLowerCase().split(/[-_.\s]+/).filter(Boolean)) {
        if (piece.length >= 3 && raw2.toLowerCase().includes(piece)) score += 8;
      }
    }
    return { c: raw2, score };
  });
  return scored
    .filter((x) => x.score > 0)
    .sort((a, b) => (b.score - a.score) || (a.c.length - b.c.length))
    .slice(0, n)
    .map((x) => x.c);
}

/**
 * @param {object} o
 * @param {string} o.requested  客户端请求的模型名
 * @param {string[]} o.catalog  上游目录里的真实模型名
 * @param {object} [o.aliases]  别名表 { 自定义名: 真实名 }
 * @param {Array<{name:string,display_name?:string}>} [o.displayNames]  上游目录对象（用于按显示名匹配）
 * @param {boolean} [o.strict]  未知模型是否拒绝（默认 true）
 * @returns {{ ok:boolean, name:string, mapped:boolean, reason:string, suggestions:string[] }}
 */
function resolveModel({ requested, catalog, aliases, displayNames, strict = true } = {}) {
  const names = Array.isArray(catalog) ? catalog.filter(Boolean) : [];
  const aliasMap = aliases && typeof aliases === 'object' ? aliases : {};
  const req = String(requested || '').trim();

  if (!req) return { ok: false, name: '', mapped: false, reason: 'empty', suggestions: [] };

  // 1) 别名优先（大小写不敏感）
  let target = req;
  let mapped = false;
  const aliasKey = Object.keys(aliasMap).find((k) => k.toLowerCase() === req.toLowerCase());
  if (aliasKey) { target = String(aliasMap[aliasKey]); mapped = true; }

  // 2) 目录为空（拉取失败）时不能假装校验通过 —— 交给调用方决定（这里如实返回 unknown-catalog）
  if (!names.length) {
    return { ok: !strict, name: target, mapped, reason: 'catalog-empty', suggestions: [] };
  }

  // 3) 目录里精确匹配（大小写不敏感，回填目录里的真实写法）
  const hit = names.find((n) => n.toLowerCase() === target.toLowerCase());
  if (hit) return { ok: true, name: hit, mapped, reason: mapped ? 'alias' : 'exact', suggestions: [] };

  // 3.5) 显示名匹配：slug 与 display_name 常常不一致
  //（例：Doubao-Seed-2.0-Code 的显示名是 Seed-2.1-Turbo —— 用户按界面名调用不该 404）
  const disp = Array.isArray(displayNames) ? displayNames : [];
  if (disp.length) {
    const norm = (x) => String(x || '').toLowerCase().replace(/[-_.\s]+/g, '');
    const t = norm(target);
    const byDisp = disp.find((m) => m && m.display_name && norm(m.display_name) === t);
    if (byDisp && byDisp.name) {
      return { ok: true, name: byDisp.name, mapped: true, reason: 'display', suggestions: [] };
    }
  }

  // 4) 未知
  return {
    ok: !strict,
    name: target,
    mapped,
    reason: 'unknown',
    suggestions: suggest(target, names),
  };
}

module.exports = { resolveModel, suggest };
