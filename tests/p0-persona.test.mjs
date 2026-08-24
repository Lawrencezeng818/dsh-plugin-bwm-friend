/* P0-人格：buildPersonaSystem 支持 persona override + settings 存取（TDD RED→GREEN）
 * 运行: node --test tests/p0-persona.test.cjs
 */
import test from 'node:test';
import assert from 'node:assert';

// buildPersonaSystem 从 lib 导出（测试辅助导出，非发布面）
import { buildPersonaSystem } from '../lib/index.js';

test('persona: buildPersonaSystem 注入自定义人格（覆盖预设）', () => {
  const out = buildPersonaSystem('你是冷面教练：只给一句话命令式建议');
  assert.ok(out.includes('冷面教练'), '自定义人格应注入系统提示');
  assert.ok(out.includes('一句话命令式建议'), '人格细节应完整注入');
});

test('persona: buildPersonaSystem 无 override 时用预设（不炸）', () => {
  const out = buildPersonaSystem();
  assert.ok(typeof out === 'string' && out.length > 50, '预设人格正常生成');
});
