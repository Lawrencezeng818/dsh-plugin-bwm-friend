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
