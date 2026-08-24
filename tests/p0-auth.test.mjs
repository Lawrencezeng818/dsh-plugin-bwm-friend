/* P0-登录：host auth 代理端点（TDD RED→GREEN）
 * 运行: node --test tests/p0-auth.test.cjs
 * 语义:
 *   POST /bwm-friend/auth/login {phone,password} → 转发 BWM_AUTH_BASE（可配置）
 *   - BWM_AUTH_BASE 未配置（本地/dev）→ 200 {ok:true, dev:true}（本地验证模式）
 *   - 配置后 → 转发生产 /auth/login/sms（带三头），凭据不落盘
 *   POST /bwm-friend/auth/logout → 清除会话
 *   GET  /bwm-friend/auth/status → {loggedIn:true, subject}
 */
import test from 'node:test';
import assert from 'node:assert';
import { authSession, authLoginLocal } from '../lib/index.js';

test('auth: 登录成功建立会话', async () => {
  authSession.logout();
  const res = await authLoginLocal({ phone: '13800138000', password: 'test-pass' });
  assert.strictEqual(res.ok, true);
  assert.ok(res.dev === true, 'dev 模式标记');
  assert.strictEqual(authSession.isLoggedIn(), true);
  assert.ok(authSession.subject());
});

test('auth: 退出清除会话', () => {
  authSession.logout();
  assert.strictEqual(authSession.isLoggedIn(), false);
  assert.strictEqual(authSession.subject(), null);
});

test('auth: 空凭据拒绝', async () => {
  authSession.logout();
  const res = await authLoginLocal({ phone: '', password: '' });
  assert.strictEqual(res.ok, false);
  assert.ok(res.error);
});
