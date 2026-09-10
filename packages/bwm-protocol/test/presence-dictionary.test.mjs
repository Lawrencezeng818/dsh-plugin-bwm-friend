/* Presence v1 Canonical Dictionary — 机器权威校验(终审 D1/D2 批准后落地)
 * 运行: node --test test/presence-dictionary.test.mjs(packages/bwm-protocol 下)
 * 纪律:任何 Protocol/SDK/UI 状态枚举不得脱离词典单独增删改名;分叉在此暴露,不靠人工评审。
 *
 * 工程案例(2026-09-09,首跑战果):本套测试第一次运行即发现"三层化重写时 working 从
 * 仲裁序丢失"——该分叉经四轮人工评审未被发现。修复路径=冻结纪律"修派生物"分支
 * (词典 §9):改 presence-dictionary.json 与词典 §2 勘误,不重开语义设计。
 * 机器不是替人工重复检查,而是发现人工实际漏掉的规范分叉。
 */
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const dict = JSON.parse(readFileSync(join(here, '../schema/presence-dictionary.json'), 'utf8'));
const state = JSON.parse(readFileSync(join(here, '../schema/state.json'), 'utf8'));

const p = dict.properties;
const protocolPresence = state.definitions.presence.enum;
const legacy = p.legacy_presence_enum.const;
const layered = p.legacy_to_layered.properties;
const semantic = p.semantic_states.const;
const activities = p.activity_states.const;
const arbitration = p.arbitration_priority.const;

test('词典:state.json 的 presence 枚举是词典 legacy 集的子集(协议不越权)', () => {
  for (const v of protocolPresence) assert.ok(legacy.includes(v), `协议枚举 ${v} 不在词典中——状态分叉!`);
});

test('词典:legacy 映射覆盖全集(legacy ∪ 待吸收)且目标值合法', () => {
  const full = [...legacy, ...p.pending_protocol_additions.const];
  const keys = Object.keys(layered);
  assert.strictEqual(keys.length, new Set(keys).size);
  for (const v of full) assert.ok(keys.includes(v), `词典状态 ${v} 缺 legacy 映射`);
  for (const k of keys) assert.ok(full.includes(k), `映射键 ${k} 超出词典全集`);
  for (const [k, def] of Object.entries(layered)) {
    const [sem, act] = def.const;
    assert.ok(semantic.includes(sem), `${k} 的语义态 ${sem} 非法`);
    if (act !== null) assert.ok(activities.includes(act), `${k} 的活动态 ${act} 非法`);
  }
});

test('词典:仲裁序覆盖全部活动态,无缺无重', () => {
  assert.strictEqual(arbitration.length, new Set(arbitration).size, '仲裁序有重复');
  for (const a of activities) assert.ok(arbitration.includes(a), `活动态 ${a} 缺仲裁序`);
});

test('词典:语义独占态不出现在活动层', () => {
  for (const s of p.semantic_exclusive_states.const) assert.ok(!activities.includes(s), `${s} 不得同时是活动态`);
});

test('词典:瞬态集是活动态子集且带回落时长', () => {
  for (const t of p.transient_activity_states.const) {
    assert.ok(activities.includes(t));
    assert.ok(p.transient_fallback_ms.properties[t], `瞬态 ${t} 缺回落时长`);
  }
});

test('词典:D1 纪律——待吸收枚举(working/listening)当前不得进入协议', () => {
  for (const v of p.pending_protocol_additions.const) {
    assert.ok(!protocolPresence.includes(v), `${v} 应待 minor bump 吸收,不得先行进入 state.json`);
  }
});

test('词典:迁移门控活动态存在且合法', () => {
  for (const a of p.migration_blocked_activities.const) assert.ok(activities.includes(a));
});

test('机器权威:协议导出常量由词典派生且三方一致(index.js ≡ state.json ≡ 词典)', async () => {
  const mod = await import('../schema/index.js');
  assert.deepStrictEqual([...mod.PRESENCE], legacy, 'index.js PRESENCE 与词典 legacy 集不一致');
  assert.deepStrictEqual([...mod.PRESENCE], [...protocolPresence], 'index.js PRESENCE 与 state.json 枚举不一致');
  assert.deepStrictEqual([...mod.SEMANTIC_STATES], semantic);
  assert.deepStrictEqual([...mod.ACTIVITY_STATES], activities);
  assert.deepStrictEqual([...mod.ARBITRATION_PRIORITY], arbitration);
  assert.strictEqual(mod.validPresence('idle'), 'idle');
  assert.strictEqual(mod.validPresence('bogus'), 'idle', 'fallback 语义不变');
});

test('机器权威:toLayered 映射行为', async () => {
  const { toLayered } = await import('../schema/index.js');
  assert.deepStrictEqual(toLayered('idle'), ['available', 'idle']);
  assert.deepStrictEqual(toLayered('offline'), ['unavailable', null]);
  assert.deepStrictEqual(toLayered('transition'), ['transitioning', null]);
  assert.deepStrictEqual(toLayered('working'), ['engaged', 'working'], '词典全集含待吸收态');
  assert.strictEqual(toLayered('bogus'), null);
});
