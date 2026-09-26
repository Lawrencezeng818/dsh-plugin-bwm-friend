/* BWM Memory 工具回归（P2 修复：recentTopics 裁剪方向 + 正则有界防 ReDoS）
 * 运行: node --test test/memory.test.mjs（packages/bwm-protocol 下）
 */
import test from 'node:test';
import assert from 'node:assert';
import { mergeMemory, memoryPrompt, extractFacts, RECENT_TOPICS_MAX } from '../schema/memory.js';

test('memory: recentTopics 保留最近 N 条且最新在末尾（裁剪方向回归）', () => {
  let mem = { userFacts: [], recentTopics: [] };
  for (let i = 1; i <= 15; i++) mem = mergeMemory(mem, '消息' + i);
  assert.strictEqual(mem.recentTopics.length, RECENT_TOPICS_MAX, '守住上限 10');
  assert.strictEqual(mem.recentTopics[mem.recentTopics.length - 1], '消息15', '最新消息在末尾（修复前保留的是最旧 10 条）');
  assert.strictEqual(mem.recentTopics[0], '消息6', '保留窗口为 6..15');
});

test('memory: memoryPrompt 展示最近 3 条（新→旧）', () => {
  let mem = { userFacts: [], recentTopics: [] };
  for (let i = 1; i <= 15; i++) mem = mergeMemory(mem, '消息' + i);
  const p = memoryPrompt(mem);
  assert.ok(p.includes('消息15'), '最新话题参与展示');
  assert.ok(p.includes('消息13'), '最近 3 条为 15/14/13');
  assert.ok(!p.includes('消息12'), '只展示 3 条');
});

test('memory: 「我是…的」模式有界仍可用，超长输入快速失败（防 ReDoS）', () => {
  // 有界模式语义不回归（带标点的自我描述走第 3 条 pattern 的「我是…的」分支）
  assert.ok(extractFacts('我是，呃，教书的老师').includes('老师'));
  // 超出量界的跨度不再匹配，且立即返回（无界回溯已消除）
  const long = '我是' + '很'.repeat(100000) + '强的粉丝';
  const t0 = Date.now();
  const facts = extractFacts(long);
  assert.ok(Date.now() - t0 < 500, '长输入线性完成，不发生灾难性回溯');
  assert.ok(Array.isArray(facts), '长输入安全返回（不抛错不挂起）');
});
