/* P1-更新检查（TDD RED→GREEN）
 * 运行: node --test tests/p1-update.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert';
import { compareVersion, updateCheckLocal } from '../lib/index.js';

test('update: 版本比较（当前旧 → hasUpdate）', () => {
  assert.strictEqual(compareVersion('0.3.1', '0.3.2'), -1);
  assert.strictEqual(compareVersion('0.3.2', '0.3.1'), 1);
  assert.strictEqual(compareVersion('0.3.1', '0.3.1'), 0);
});

test('update: updateCheckLocal 判定更新', async () => {
  const res = await updateCheckLocal('0.3.1', '0.3.2');
  assert.strictEqual(res.current, '0.3.1');
  assert.strictEqual(res.latest, '0.3.2');
  assert.strictEqual(res.hasUpdate, true);
});

test('update: 同版本无更新 + 最新不可读不炸', async () => {
  const same = await updateCheckLocal('0.3.1', '0.3.1');
  assert.strictEqual(same.hasUpdate, false);
  const none = await updateCheckLocal('0.3.1', null);
  assert.strictEqual(none.hasUpdate, false);
});
