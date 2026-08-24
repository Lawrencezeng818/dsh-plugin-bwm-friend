const test = require('node:test');
const assert = require('node:assert');
const { negotiate, compareVersion, createRuntime, RUNTIME_CAPABILITIES } = require('../src/index.js');

// Shell 声明（与 docs/BWM-PROTOCOL-v1.md §4.1 对齐的 5 能力，结构化）
const SHELL_CAPS = [
  { name: 'video-layer', version: '1.0' },
  { name: 'composer-skin', version: '1.0' },
  { name: 'sidebar-drawer', version: '1.0' },
  { name: 'pop-session', version: '1.0' },
  { name: 'header-strip', version: '1.0' },
];

test('negotiate: 全匹配 → full mode + 全部 matched', () => {
  const r = negotiate(SHELL_CAPS, [
    ...RUNTIME_CAPABILITIES,
    { name: 'video-layer', version: '1.0' },
    { name: 'composer-skin', version: '1.0' },
    { name: 'sidebar-drawer', version: '1.0' },
    { name: 'pop-session', version: '1.0' },
    { name: 'header-strip', version: '1.0' },
  ]);
  assert.strictEqual(r.mode, 'full');
  assert.strictEqual(r.matched.length, 5);
  assert.strictEqual(r.degraded.length, 0);
  assert.strictEqual(r.missing.length, 0);
});

test('negotiate: shell 声明能力 runtime 未提供 → missing + lite mode', () => {
  const r = negotiate(SHELL_CAPS, []); // runtime 一个 shell 能力都没有
  assert.strictEqual(r.mode, 'lite');
  assert.strictEqual(r.matched.length, 0);
  assert.strictEqual(r.missing.length, 5);
  assert.strictEqual(r.missing[0].reason, 'not-provided');
});

test('negotiate: 版本不匹配（shell 要 2.0，runtime 只给 1.0）→ degraded + lite mode', () => {
  const r = negotiate([{ name: 'presence-provide', version: '2.0' }], RUNTIME_CAPABILITIES);
  assert.strictEqual(r.mode, 'lite');
  assert.strictEqual(r.degraded.length, 1);
  assert.strictEqual(r.degraded[0].reason, 'version-mismatch');
  assert.strictEqual(r.degraded[0].shell, '2.0');
  assert.strictEqual(r.degraded[0].runtime, '1.0');
});

test('negotiate: 版本兼容（shell 要 1.0，runtime 给 1.2）→ matched + level/constraints 透传', () => {
  const r = negotiate([{ name: 'context-govern', version: '1.0' }], RUNTIME_CAPABILITIES);
  assert.strictEqual(r.mode, 'full');
  assert.strictEqual(r.matched.length, 1);
  assert.strictEqual(r.matched[0].level, 'full');
  assert.deepStrictEqual(r.matched[0].constraints, { domains: 8, writable: 'ownership-model' });
});

test('negotiate: 字符串简写能力（旧协议兼容）→ 默认 version 1.0', () => {
  const r = negotiate(['video-layer'], RUNTIME_CAPABILITIES);
  assert.strictEqual(r.missing.length, 1); // video-layer 非 runtime 能力 → missing
  assert.strictEqual(r.missing[0].name, 'video-layer');
});

test('compareVersion: 语义化版本比较边界', () => {
  assert.ok(compareVersion('1.0', '1.0') === 0);
  assert.ok(compareVersion('1.2', '1.0') > 0);
  assert.ok(compareVersion('1.0', '1.2') < 0);
  assert.ok(compareVersion('1.0', '1.0.0') === 0);
  assert.ok(compareVersion('2.0', '1.9.9') > 0);
});

test('hello 握手: requires 核心能力全满足 → full mode + negotiation 结构完整', () => {
  const runtime = createRuntime();
  const welcome = runtime.hello({
    shellVersion: '0.3.0',
    dshVersion: '1.2.3',
    capabilities: SHELL_CAPS, // 信息性：shell 自身 UI 能力
    requires: [
      { name: 'presence-provide', version: '1.0' },
      { name: 'context-govern', version: '1.0' },
      { name: 'ledger-record', version: '1.0' },
    ],
  });
  assert.strictEqual(welcome.mode, 'full');
  assert.strictEqual(welcome.negotiation.matched.length, 3);
  assert.strictEqual(welcome.negotiation.missing.length, 0);
  assert.strictEqual(welcome.protocol, 'bwm');
  assert.strictEqual(welcome.version, '1.0');
});

test('hello 握手: requires 含 runtime 未提供能力 → lite mode + missing 列出', () => {
  const runtime = createRuntime();
  const welcome = runtime.hello({
    requires: [
      { name: 'presence-provide', version: '1.0' },
      { name: 'future-runtime-x', version: '2.0' }, // runtime 未来能力，当前未提供
    ],
  });
  assert.strictEqual(welcome.mode, 'lite');
  assert.strictEqual(welcome.negotiation.matched.length, 1);
  assert.strictEqual(welcome.negotiation.missing.length, 1);
  assert.strictEqual(welcome.negotiation.missing[0].name, 'future-runtime-x');
});

test('hello 握手: 无 requires → full（空需求即全匹配）', () => {
  const runtime = createRuntime();
  const welcome = runtime.hello({ shellVersion: '0.3.0' });
  assert.strictEqual(welcome.mode, 'full');
  assert.strictEqual(welcome.negotiation.matched.length, 0);
});
