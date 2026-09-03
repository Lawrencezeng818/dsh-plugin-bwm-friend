/** 记忆抽取单测（完成度批次2）：协议层 mergeMemory/extractFacts 纯函数覆盖 */
import test from 'node:test';
import assert from 'node:assert';
import { extractFacts, mergeMemory, memoryPrompt, MEMORY_DEFAULTS, USER_FACTS_MAX, RECENT_TOPICS_MAX } from '../packages/bwm-protocol/schema/memory.js';

test('extractFacts: 喜好/姓名/地域/意愿/近事 五类模式命中', () => {
  const cases = [
    ['我最喜欢草莓蛋糕', '草莓蛋糕'],
    ['我叫张三', '张三'],
    ['我住在杭州滨江', '杭州滨江'],
    ['我想学钢琴', '钢琴'],
    ['我最近在加班赶项目', '加班'],
  ];
  for (const [text, frag] of cases) {
    const facts = extractFacts(text).join('|');
    assert.ok(facts.includes(frag), `"${text}" 应抽出含 "${frag}" 的事实，实得: ${facts}`);
  }
});

test('extractFacts: 问句/空文本不产事实', () => {
  assert.deepStrictEqual(extractFacts('？'), []);
  assert.deepStrictEqual(extractFacts(''), []);
});

test('mergeMemory: 去重 + 上限裁剪 + recentTopics 置顶', () => {
  let mem = { ...MEMORY_DEFAULTS };
  mem = mergeMemory(mem, '我叫张三');
  mem = mergeMemory(mem, '我叫张三');
  assert.strictEqual(mem.userFacts.filter((f) => f.includes('张三')).length, 1, '同名事实去重');
  for (let i = 0; i < RECENT_TOPICS_MAX + 5; i++) mem = mergeMemory(mem, `话题${i}`);
  assert.ok(mem.recentTopics.length <= RECENT_TOPICS_MAX, 'recentTopics 上限');
  assert.strictEqual(mem.recentTopics[0].includes('话题'), true, '最新话题置顶');
  for (let i = 0; i < USER_FACTS_MAX + 8; i++) mem = mergeMemory(mem, `我喜欢东西${i}`);
  assert.ok(mem.userFacts.length <= USER_FACTS_MAX, 'userFacts 上限');
});

test('memoryPrompt: 无记忆为空串，有记忆注入提示', () => {
  assert.strictEqual(memoryPrompt({ ...MEMORY_DEFAULTS }), '');
  const p = memoryPrompt(mergeMemory({ ...MEMORY_DEFAULTS }, '我叫李四'));
  assert.ok(p.includes('李四'));
});
