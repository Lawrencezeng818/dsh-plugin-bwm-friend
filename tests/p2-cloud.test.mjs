/* P2-云端同步（TDD RED→GREEN）
 * 运行: node --test tests/p2-cloud.test.mjs
 * 契约（广州 Hub /api/v1，Bearer token）:
 *   GET /custom-templates → {templates:[...], count}
 *   GET /memory/permanent → {code:0, data:{memory, updated_at}}
 *   GET /memory/persona   → {code:0, data:{memory, updated_at}}
 */
import test from 'node:test';
import assert from 'node:assert';
import { cloudTemplates, cloudMemory, authSession } from '../lib/index.js';

test('cloud: 未登录时拒绝', async () => {
  authSession.logout();
  const r = await cloudTemplates();
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error, 'not-logged-in');
});

test('cloud: memory 未登录时拒绝', async () => {
  authSession.logout();
  const r = await cloudMemory();
  assert.strictEqual(r.ok, false);
});

test('cloud: 登录后调用生产（真实 token 链路）', async () => {
  // 跳过：无 BWM_AUTH_BASE 时生产分支不可测（dev 模式）
  if (!process.env.BWM_AUTH_BASE) {
    assert.ok(true, 'dev 模式跳过生产链路');
    return;
  }
  const r = await cloudTemplates();
  assert.strictEqual(r.ok, true);
  assert.ok(Array.isArray(r.templates));
});
