/** tests/negotiation.test.mjs — 多宿主能力协商矩阵（完成度批次9）*/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const core = require(join(dirname(fileURLToPath(import.meta.url)), '..', 'packages', 'bwm-runtime-core', 'src', 'index.js'));
const { negotiate, RUNTIME_CAPABILITIES } = core;

test('协商: 标准 runtime 全集 × 标准 shell requires → 全 matched', () => {
  const r = negotiate(['presence-provide', 'context-govern', 'ledger-record'], RUNTIME_CAPABILITIES);
  assert.equal(r.missing.length, 0);
  assert.equal(r.degraded.length, 0);
  assert.equal(r.matched.length, 3);
});

test('协商: runtime 未提供的能力 → missing(not-provided)', () => {
  const r = negotiate(['time-travel'], RUNTIME_CAPABILITIES);
  assert.equal(r.matched.length, 0);
  assert.equal(r.missing[0].reason, 'not-provided');
  assert.equal(r.missing[0].name, 'time-travel');
});

test('协商: 版本倒挂 → degraded(version-mismatch)', () => {
  const liteRuntime = [{ name: 'presence-provide', version: '0.9' }];
  const r = negotiate(['presence-provide'], liteRuntime);
  assert.equal(r.matched.length, 0);
  assert.equal(r.degraded[0].reason, 'version-mismatch');
  assert.equal(r.degraded[0].runtime, '0.9');
});

test('协商: lite 宿主只供子集 → 混合 matched+missing（降级面计算正确）', () => {
  const lite = [{ name: 'presence-provide', version: '1.0', level: 'basic' }];
  const r = negotiate(['presence-provide', 'identity-hold'], lite);
  assert.equal(r.matched.length, 1);
  assert.equal(r.matched[0].level, 'basic');
  assert.equal(r.missing.length, 1);
});

test('协商: 对象形态能力（带 constraints）→ 约束透传', () => {
  const rt = [{ name: 'video-layer', version: '1.2', level: 'full', constraints: { layout: 'right-panel' } }];
  const r = negotiate([{ name: 'video-layer', version: '1.0' }], rt);
  assert.equal(r.matched[0].constraints.layout, 'right-panel');
  assert.equal(r.matched[0].runtime, '1.2');
});

test('协商: 空 requires → 空结果（不崩）', () => {
  const r = negotiate([], RUNTIME_CAPABILITIES);
  assert.equal(r.matched.length, 0);
  assert.equal(r.missing.length, 0);
});
