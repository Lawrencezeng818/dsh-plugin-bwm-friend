/* BWM Settings Schema v1（TDD RED→GREEN）
 * 运行: node --test test/settings.test.mjs（packages/bwm-protocol 下）
 */
import test from 'node:test';
import assert from 'node:assert';
import { DEFAULT_SETTINGS, validateSettings, normalizeSettings } from '../schema/index.js';

test('settings: 合法配置通过校验', () => {
  const r = validateSettings({ avatar: { theme: '甜心女孩', persona: '温暖' }, voice: { voice: '冰糖' } });
  assert.strictEqual(r.valid, true);
  assert.deepStrictEqual(r.errors, []);
});

test('settings: 非法字段被拒绝', () => {
  const r = validateSettings({ avatar: { theme: 123 }, ui: { mode: 'bogus' } });
  assert.strictEqual(r.valid, false);
  assert.ok(r.errors.length > 0);
});

test('settings: 默认值完整（normalize 空对象）', () => {
  const s = normalizeSettings({});
  assert.strictEqual(s.version, 1);
  assert.ok(s.avatar && typeof s.avatar.theme === 'string');
  assert.ok(s.power && typeof s.power.pauseOnBlur === 'boolean');
  assert.ok('voice' in s && 'llm' in s && 'ui' in s && 'account' in s);
});

test('settings: normalize 保留已给字段并补默认', () => {
  const s = normalizeSettings({ avatar: { theme: '电竞男孩' } });
  assert.strictEqual(s.avatar.theme, '电竞男孩');
  assert.strictEqual(typeof s.avatar.persona, 'string');
});

/* ── factgate / wireLedger 校验（P2 修复：schema 定义 + 校验器 + 测试三面对齐）── */

test('settings: factgate 合法域注册表通过', () => {
  const r = validateSettings({
    factgate: { domains: { 'patent-status': { label: '专利状态', source: 'local' }, 'e-receipt': { label: '电子回执', source: 'probe' } } },
  });
  assert.strictEqual(r.valid, true);
  assert.deepStrictEqual(r.errors, []);
});

test('settings: factgate 非法结构被拒绝（非对象 / domains 非对象 / 域项缺字段）', () => {
  assert.strictEqual(validateSettings({ factgate: 'x' }).valid, false, 'factgate 必须是对象');
  assert.strictEqual(validateSettings({ factgate: { domains: [] } }).valid, false, 'domains 必须是对象（映射表）');
  assert.strictEqual(validateSettings({ factgate: { domains: { d1: { label: 'x' } } } }).valid, false, '域项缺 source');
  assert.strictEqual(validateSettings({ factgate: { domains: { d1: { label: '', source: 's' } } } }).valid, false, 'label 不得为空');
});

test('settings: wireLedger 数组放行、非数组拒绝（与 host 白名单一致）', () => {
  assert.strictEqual(validateSettings({ wireLedger: ['identity', 'memory'] }).valid, true, '数组放行');
  assert.deepStrictEqual(validateSettings({ wireLedger: [] }).errors, [], '空数组同样放行');
  const r = validateSettings({ wireLedger: 'identity' });
  assert.strictEqual(r.valid, false, '非数组 invalid');
  assert.ok(r.errors.includes('wireLedger: must be array'), '错误信息与 host 侧一致');
});
