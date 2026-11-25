// 单测：工具块压缩层（签名 / 枚举 / 预算门控 / 深度）
const assert = require('assert');
const B = require('./lib/tools-bridge.cjs');

let n = 0, fail = 0;
function t(name, fn) {
  n++;
  try { fn(); console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + '\n      ' + e.message); }
}

const fn = (name, desc, props, required) => ({
  type: 'function',
  function: { name, description: desc, parameters: { type: 'object', properties: props, required } },
});

// legacy 风格的指令块（只在 instruction_style=legacy 时使用）
const t_legacy = () => B.buildToolInstruction([fn('read', '读取文件', {}, [])], 'auto', { style: 'legacy' });

function deepSchema() {
  return {
    type: 'object',
    properties: {
      plan: {
        type: 'object',
        properties: {
          strategy: {
            type: 'object',
            properties: {
              rolling: {
                type: 'object',
                properties: { batch: { type: 'integer' }, pause: { type: 'boolean' } },
                required: ['batch'],
              },
            },
          },
        },
      },
      name: { type: 'string' },
    },
    required: ['plan'],
  };
}

console.log('签名渲染');
t('depth=3 能看到四层叶子', () => {
  const sig = B.compactParameters(deepSchema(), 3);
  assert.ok(sig.includes('batch:integer*'), sig);
  assert.ok(sig.includes('pause:boolean'), sig);
});
t('depth=2 看不到四层叶子', () => {
  const sig = B.compactParameters(deepSchema(), 2);
  assert.ok(!sig.includes('batch'), sig);
});
t('required 用 * 标注', () => {
  const sig = B.compactParameters({ type: 'object', properties: { a: { type: 'string' }, b: { type: 'integer' } }, required: ['a'] }, 3);
  assert.ok(/:string\*/.test(sig));
  assert.ok(/:integer(?!\*)/.test(sig));
});
t('数组记录展开内部字段', () => {
  const sig = B.compactParameters({
    type: 'object',
    properties: { steps: { type: 'array', items: { type: 'object', properties: { action: { type: 'string', enum: ['build', 'test'] } } } } },
  }, 3);
  assert.ok(sig.includes('array<object>'), sig);
  assert.ok(sig.includes('action:string[build|test]'), sig);
});
t('无参数', () => {
  assert.equal(B.compactParameters({ type: 'object', properties: {} }, 3), '无参数');
});

console.log('\n枚举渲染');
t('字符串枚举', () => {
  assert.equal(B.enumHint({ enum: ['turbo', 'standard', 'thorough'] }), '[turbo|standard|thorough]');
});
t('布尔按 JSON 字面量', () => {
  assert.equal(B.enumHint({ enum: [true, false] }), '[true|false]');
});
t('null 按 JSON 字面量', () => {
  assert.equal(B.enumHint({ enum: ['auto', null] }), '[auto|null]');
});
t('7 个短值不因个数被截断（只按宽度）', () => {
  assert.equal(B.enumHint({ enum: ['0', '1', '2', '3', '4', '5', '6'] }), '[0|1|2|3|4|5|6]');
});
t('超宽时按累计宽度截断（保留能放下的成员 + 省略号）', () => {
  const long = ['x'.repeat(30), 'y'.repeat(30), 'z'.repeat(30)];   // 第二个就放不下了
  assert.equal(B.enumHint({ enum: long }), '[' + 'x'.repeat(30) + '|…]');
});
t('8 个 locale（47 字符）全给，不截断', () => {
  const v = ['zh-CN', 'en-US', 'ja-JP', 'ko-KR', 'fr-FR', 'de-DE', 'es-ES', 'ru-RU'];
  assert.equal(B.enumHint({ enum: v }), '[' + v.join('|') + ']');
});
t('12 个 locale（71 字符）按宽度截断', () => {
  const v = ['zh-CN', 'en-US', 'ja-JP', 'ko-KR', 'fr-FR', 'de-DE', 'es-ES', 'ru-RU', 'pt-BR', 'it-IT', 'nl-NL', 'sv-SE'];
  const hint = B.enumHint({ enum: v });
  assert.ok(hint.endsWith('|…]'), hint);
  assert.ok(hint.length <= 64, 'len=' + hint.length);
});
t('单个超长枚举值也截断（不撑爆行）', () => {
  assert.equal(B.enumHint({ enum: ['x'.repeat(80)] }), '[' + 'x'.repeat(59) + '…]');
});
t('成员数硬上限 12（短值也不无限展开）', () => {
  const v = Array.from({ length: 13 }, (_, i) => String(i % 10));
  const hint = B.enumHint({ enum: v });
  assert.ok(hint.endsWith('|…]'), hint);
  assert.equal(hint.split('|').length, 13);   // 12 个值 + 省略号
});

console.log('\n预算门控');
t('小工具集走完整 JSON', () => {
  const tools = [fn('read', '读取文件', { path: { type: 'string' } }, ['path'])];
  const r = B.renderToolsBlockDetailed(tools);
  assert.equal(r.mode, 'full');
  assert.ok(r.block.includes('参数 JSON Schema'));
});
t('超大工具集走压缩签名', () => {
  const tools = [];
  for (let i = 0; i < 60; i++) {
    tools.push(fn('tool_' + i, '一段比较长的工具描述，用来把块撑过预算上限，确保走到签名分支',
      { path: { type: 'string' }, mode: { type: 'string', enum: ['a', 'b', 'c'] } }, ['path']));
  }
  const r = B.renderToolsBlockDetailed(tools, { budget: 8000 });
  assert.equal(r.mode, 'signature', JSON.stringify(r.mode));
  assert.ok(r.block.includes('mode:string[a|b|c]'), r.block.slice(0, 200));
  assert.ok(r.chars <= 8000 + 200, 'chars=' + r.chars);
});
t('超预算时逐级降级且尽量不超预算', () => {
  const tools = [];
  for (let i = 0; i < 400; i++) tools.push(fn('t' + i, '很长的描述'.repeat(8), { a: { type: 'string' } }, ['a']));
  const ladder = ['signature', 'signature-desc40', 'signature-nodesc', 'names-only'];
  for (const budget of [8000, 4000, 1000]) {
    const r = B.renderToolsBlockDetailed(tools, { budget });
    assert.ok(ladder.includes(r.mode), `未知模式 ${r.mode}`);
    if (r.mode !== 'names-only') assert.ok(r.chars <= budget, `budget=${budget} → ${r.mode} ${r.chars}`);
  }
});
t('report 回传渲染方式与字符数', () => {
  const report = {};
  B.buildToolInstruction([fn('read', '读取文件', { path: { type: 'string' } }, ['path'])], 'auto', { report });
  assert.equal(report.mode, 'full');
  assert.ok(report.chars > 0);
  assert.equal(report.toolCount, 1);
});

console.log('\n指令块');
t('指令块包含工具清单、禁令、自检、枚举说明', () => {
  const text = B.buildToolInstruction([fn('read', '读取文件', { mode: { type: 'string', enum: ['a', 'b'] } }, [])], 'auto');
  assert.ok(text.includes('可用工具'));
  assert.ok(text.includes('read'));
  assert.ok(text.includes('禁止使用内置工具'));
  // 默认（aligned）风格用的是「一条底线」措辞；「输出前自检」只保留在 legacy 风格里
  assert.ok(text.includes('一条底线'));
  assert.ok(t_legacy().includes('输出前自检'));
  assert.ok(text.includes('只能取这几个值之一'));
});
t('tool_choice=none 不注入', () => {
  assert.equal(B.buildToolInstruction([fn('x', 'd', {}, [])], 'none'), '');
});
t('required 追加强制要求', () => {
  const text = B.buildToolInstruction([fn('x', 'd', {}, [])], 'required');
  assert.ok(text.includes('你必须调用其中一个工具'));
});

console.log(`\n合计 ${n - fail}/${n} 通过`);
process.exit(fail ? 1 : 0);


