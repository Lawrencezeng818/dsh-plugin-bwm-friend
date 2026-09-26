const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  createRelationshipLedger,
  RULE_TABLES,
  LEDGER_ERRORS,
} = require('../src/relationship-ledger.js');

/* ── 持久化与重启闭环证据（评审 P0-4 七项）──
 * 与 relationship-ledger.test.js 的分工：
 *   前者 = 七步机制链的**逻辑契约**；
 *   本文件 = **持久化 / 重启 / 版本迁移 / 并发 / 失败语义**的闭环证据。
 * 递交文本中不得再用"49/49 即完整闭环"的口径：核心逻辑与持久化闭环须分层陈述。
 */

const DAY = 86400000;
const CTX = { binding: { subjectId: 'u_1' }, snapshot: { outcome: 'completed' } };

let tmpRoot;
test.before(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rel-ledger-'));
});
test.after(() => {
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (_) { /* 忽略 */ }
});

/** 真实文件级持久化适配器：追加 JSONL，可从磁盘重建 */
function fileStore(file) {
  return {
    append(entry) {
      fs.appendFileSync(file, JSON.stringify(entry) + '\n', 'utf8');
    },
    load() {
      if (!fs.existsSync(file)) return [];
      return fs.readFileSync(file, 'utf8')
        .split('\n')
        .filter((l) => l.trim().length > 0)
        .map((l) => JSON.parse(l));
    },
  };
}

let fileSeq = 0;
function newFile() {
  fileSeq += 1;
  return path.join(tmpRoot, 'ledger-' + fileSeq + '.jsonl');
}

/* ── 1. 真实持久化 → 销毁实例 → 重载，条目与状态一致 ── */

test('持久化①：写入真实存储后销毁实例，重载条目与关系状态完全一致', () => {
  const file = newFile();
  const store1 = fileStore(file);
  const l1 = createRelationshipLedger({ store: store1 });
  l1.submit({ eventType: 'generated_template', salience: 9, confidence: 1, at: 0 }, CTX);
  l1.submit({ eventType: 'code_analysis', salience: 8, confidence: 0.9, at: 1000 }, CTX);
  const before = l1.replay({ at: 5 * DAY });
  const beforeEntries = JSON.parse(JSON.stringify(l1.all()));
  assert.strictEqual(l1.size(), 2);
  assert.strictEqual(fs.readFileSync(file, 'utf8').trim().split('\n').length, 2, '两条条目均已落盘');

  // 销毁实例（丢弃内存对象），从磁盘重建
  const store2 = fileStore(file);
  const l2 = createRelationshipLedger({ store: store2 });
  const r = l2.restore();
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.restored, 2);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(l2.all())), beforeEntries, '条目逐字段一致');
  assert.deepStrictEqual(l2.replay({ at: 5 * DAY }).state, before.state, '重放状态一致');
  assert.strictEqual(l2.verify().ok, true, '重载后重算比较仍通过');
});

/* ── 2. 持久化失败不得视为成功（原子提交语义）── */

test('持久化②：存储写入失败 → 该次提交整体失败，内存不落、可定位到持久化阶段', () => {
  const file = newFile();
  const store = fileStore(file);
  const l = createRelationshipLedger({ store });
  const good = l.submit({ eventType: 'tool_execution', salience: 9, confidence: 1, at: 0 }, CTX);
  assert.strictEqual(good.ok, true);
  assert.strictEqual(l.size(), 1);

  // 注入持久化故障
  const original = store.append;
  store.append = () => { throw new Error('disk full'); };
  const bad = l.submit({ eventType: 'tool_execution', salience: 9, confidence: 1, at: 1 }, CTX);
  assert.strictEqual(bad.ok, false, '持久化失败不得报告成功');
  assert.strictEqual(bad.error, LEDGER_ERRORS.PERSIST_FAILED);
  assert.strictEqual(bad.stage, 'persist');
  assert.strictEqual(bad.persisted, false);
  assert.strictEqual(bad.cause, 'disk full', '异常原因不得被吞掉');
  assert.strictEqual(l.size(), 1, '未提交的条目不得进入内存权威视图');
  assert.strictEqual(fs.readFileSync(file, 'utf8').trim().split('\n').length, 1, '磁盘仅有 1 条');

  // 故障恢复后同一事件标识可重新提交（未被幂等键污染）
  store.append = original;
  const retry = l.submit({ eventType: 'tool_execution', salience: 9, confidence: 1, at: 1 }, CTX);
  assert.strictEqual(retry.ok, true);
  assert.strictEqual(l.size(), 2);
});

/* ── 3. 重启后幂等索引恢复 ── */

test('持久化③：重启重载后幂等索引一并恢复，同一事件标识不二次落账', () => {
  const file = newFile();
  const raw = { eventId: 'shared_evt_restart', eventType: 'code_analysis', salience: 9, confidence: 1, at: 0 };
  const l1 = createRelationshipLedger({ store: fileStore(file) });
  assert.strictEqual(l1.submit(raw, CTX).ok, true);
  assert.strictEqual(l1.size(), 1);

  // 重启
  const l2 = createRelationshipLedger({ store: fileStore(file) });
  l2.restore();
  assert.strictEqual(l2.has('shared_evt_restart'), true, '幂等索引须随账本一并恢复');
  const again = l2.submit(raw, CTX);
  assert.strictEqual(again.idempotent, true, '重启后重复消息仍应命中幂等');
  assert.strictEqual(l2.size(), 1);
  assert.strictEqual(fs.readFileSync(file, 'utf8').trim().split('\n').length, 1, '磁盘不得出现第二条');
});

/* ── 4. 规则版本迁移：旧版本重算得原值，缺失版本明确失败 ── */

test('持久化④：规则升级后按条目记录的旧版本重算，仍得原始 Δ0', () => {
  const v11 = Object.assign({}, RULE_TABLES['rules-v1.0'], {
    version: 'rules-v1.1',
    // 规则升级：权重与分配比例都变（取值使 Δ0 落在界内，避免被 deltaBound 截断而看不出差异）
    eventTypeWeight: Object.assign({}, RULE_TABLES['rules-v1.0'].eventTypeWeight, { generated_template: 1.2 }),
    dimensionShare: { trust: 0.8, intimacy: 0.1, familiarity: 0.1 },
    decayPerDay: { trust: 0.02, intimacy: 0.02, familiarity: 0.02 },
  });
  const registry = Object.assign({}, RULE_TABLES, { 'rules-v1.1': v11 });
  const file = newFile();
  const l = createRelationshipLedger({ store: fileStore(file), rules: registry });

  // 旧版本条目
  l.submit({ eventType: 'generated_template', salience: 9, confidence: 1, at: 0 }, Object.assign({ rulesVersion: 'rules-v1.0' }, CTX));
  const legacy = l.all()[0];
  assert.strictEqual(legacy.delta.trust, 0.5, 'v1.0 的 Δ0 = 1.0 × 0.5');

  // 新版本条目
  l.submit({ eventType: 'generated_template', salience: 9, confidence: 1, at: 0 }, Object.assign({ rulesVersion: 'rules-v1.1' }, CTX));
  const modern = l.all()[1];
  assert.strictEqual(modern.delta.trust, 0.96, 'v1.1 的 Δ0 = 1.2 × 0.8（规则升级后新条目按新版本计算）');

  // 迁移后：两条各自按自己记录的版本重算，均一致
  const v = l.verify();
  assert.strictEqual(v.ok, true, '规则升级后历史条目按旧版本重算仍须一致');
  assert.strictEqual(v.checked, 2);

  // 缺失规则版本 → 明确失败
  legacy.rulesVersion = 'rules-v0.9';
  const v2 = l.verify();
  assert.strictEqual(v2.ok, false);
  assert.strictEqual(v2.mismatches[0].reason, LEDGER_ERRORS.UNKNOWN_RULE_VERSION);
});

/* ── 5. 重放确定性 ── */

test('持久化⑤：同一评价时刻重复重放结果一致；改变评价时刻只改有效贡献', () => {
  const l = createRelationshipLedger({ store: fileStore(newFile()) });
  l.submit({ eventType: 'generated_template', salience: 9, confidence: 1, at: 0 }, CTX);
  l.submit({ eventType: 'tool_execution', salience: 9, confidence: 1, at: 1000 }, CTX);

  const r1 = l.replay({ at: 30 * DAY });
  const r2 = l.replay({ at: 30 * DAY });
  assert.deepStrictEqual(r1.state, r2.state);

  const r3 = l.replay({ at: 300 * DAY });
  assert.ok(r3.state.trust < r1.state.trust);
  assert.deepStrictEqual(
    l.all().map((e) => e.delta),
    [l.all()[0].delta, l.all()[1].delta],
    'Δ0 不因评价时刻改变'
  );
  assert.strictEqual(l.all()[0].delta.trust, 0.5, 'Δ0 保持不可变');
});

/* ── 6. 并发重复写入只产生一个已提交条目 ── */

test('持久化⑥：持久化过程中的重入提交（并发）只产生一个已提交条目', () => {
  const file = newFile();
  const raw = { eventId: 'concurrent_evt', eventType: 'tool_execution', salience: 9, confidence: 1, at: 0 };
  let reentrant = null;
  let ledgerRef = null;
  const base = fileStore(file);
  const store = {
    append(entry) {
      base.append(entry);
      if (reentrant === null) {
        reentrant = 'armed';
        // 模拟并发：在本次落盘尚未返回时，同标识消息再次到达
        ledgerRef.__second = ledgerRef.submit(raw, CTX);
      }
    },
    load: base.load,
  };
  const l = createRelationshipLedger({ store });
  ledgerRef = l;

  const first = l.submit(raw, CTX);
  assert.strictEqual(first.ok, true);
  assert.strictEqual(ledgerRef.__second.idempotent, true, '重入提交应被识别为重复事件');
  assert.strictEqual(l.size(), 1, '账本仅一条已提交条目');
  assert.strictEqual(fs.readFileSync(file, 'utf8').trim().split('\n').length, 1, '磁盘仅一条');
  assert.strictEqual(l.verify().ok, true);
});

/* ── 7. 未知证据来源策略 ── */

test('持久化⑦：未知证据来源默认拒绝，不按最高置信度放行', () => {
  const l = createRelationshipLedger({ store: fileStore(newFile()) });
  const r = l.submit(
    { eventType: 'tool_execution', salience: 9, confidence: 1, evidenceSource: 'unknown_feed', at: 0 },
    CTX
  );
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.stage, 'admit');
  assert.ok(r.admission.reasons.indexOf(LEDGER_ERRORS.UNKNOWN_EVIDENCE_SOURCE) >= 0);
  assert.strictEqual(l.size(), 0, '未知来源事件不得落账');
});

test('持久化⑦：显式降级策略下放行，且系数为降级值而非 1.0', () => {
  const l = createRelationshipLedger({ store: fileStore(newFile()), unknownEvidencePolicy: 'degrade' });
  const r = l.submit(
    { eventType: 'tool_execution', salience: 9, confidence: 1, evidenceSource: 'unknown_feed', at: 0 },
    CTX
  );
  assert.strictEqual(r.ok, true);
  // tool_execution 权重 0.6 × completed 1.0 × 降级 0.1 = 0.06；trust 分配 0.5 → 0.03
  assert.ok(Math.abs(r.entry.delta.trust - 0.03) < 1e-9, '降级系数须真实生效');
});

/* ── 对照数据（评审 P1-3：可复验的技术效果实测）── */

test('对照：准入门的存储效果 —— 无门控 vs 有门控的落账条目数与字节数', () => {
  const fileOff = newFile();
  const lOff = createRelationshipLedger({ store: fileStore(fileOff) });
  const fileOn = newFile();
  const lOn = createRelationshipLedger({ store: fileStore(fileOn) });

  // 同一批候选事件：100 条，其中 70 条为低显著性或隐私不允许的噪声/敏感事件
  for (let i = 0; i < 100; i += 1) {
    const noisy = i % 10 < 7;
    const raw = {
      eventId: 'e_' + i,
      eventType: 'companion_chat',
      summary: '事件 ' + i,
      salience: noisy ? 1 : 8,
      confidence: 0.9,
      privacyAllowed: true,
      at: i * 1000,
    };
    lOff.submit(Object.assign({}, raw, { salience: 8 }), CTX); // 无门控：强制满足显著性
    lOn.submit(raw, CTX);                                       // 有门控：低显著性被拒
  }
  const offEntries = lOff.size();
  const onEntries = lOn.size();
  const offBytes = fs.statSync(fileOff).size;
  const onBytes = fs.statSync(fileOn).size;

  assert.strictEqual(offEntries, 100, '无门控：噪声事件全部持久化');
  assert.strictEqual(onEntries, 30, '有门控：仅 30 条获准');
  assert.ok(onBytes < offBytes, '有门控显著降低持久化字节数');
  assert.ok(onBytes < offBytes * 0.4, '门控后字节数应低于无门控的 40%');
});

test('对照：幂等的重复增量抑制 —— 无幂等键 vs 有幂等键', () => {
  const raw = { eventId: 'dup_evt', eventType: 'generated_template', salience: 9, confidence: 1, at: 0 };
  const withIdem = createRelationshipLedger({ store: fileStore(newFile()) });
  const r1 = withIdem.submit(raw, CTX);
  const r2 = withIdem.submit(raw, CTX);
  const r3 = withIdem.submit(Object.assign({}, raw), CTX);
  assert.strictEqual(r1.ok, true);
  assert.strictEqual(r2.idempotent, true);
  assert.strictEqual(r3.idempotent, true);
  assert.strictEqual(withIdem.size(), 1, '同一事件标识重复投递只产生一条');
  assert.strictEqual(withIdem.replay().state.trust, 0.5, '不产生重复增量（否则为 1.5）');
});

/* ── P2 修复回归：append 返回 rejected Promise / store.load 双契约 ── */

test('持久化⑧：append 返回 rejected Promise → 回滚该条（entries/seen），持久失败不提交', async () => {
  const file = newFile();
  const base = fileStore(file);
  let fail = false;
  const store = {
    append(entry) {
      if (fail) return Promise.reject(new Error('async disk full'));
      return base.append(entry);
    },
    load: base.load,
  };
  const l = createRelationshipLedger({ store });
  assert.strictEqual(l.submit({ eventId: 'ok_evt', eventType: 'tool_execution', salience: 9, confidence: 1, at: 0 }, CTX).ok, true);

  fail = true;
  const bad = l.submit({ eventId: 'bad_evt', eventType: 'tool_execution', salience: 9, confidence: 1, at: 1 }, CTX);
  assert.strictEqual(bad.ok, true, '同步受理（Promise 结果未知）');

  await new Promise((res) => setTimeout(res, 10)); // 等待异步失败抵达
  assert.strictEqual(l.size(), 1, '异步持久失败后该条已从内存权威视图回滚');
  assert.strictEqual(l.has('bad_evt'), false, '幂等索引一并回滚（事件可重投）');
  assert.ok(/async disk full/.test(l.lastPersistError() || ''), '内部错误标志可见（不静默逃逸）');

  fail = false;
  const retry = l.submit({ eventId: 'bad_evt', eventType: 'tool_execution', salience: 9, confidence: 1, at: 1 }, CTX);
  assert.strictEqual(retry.ok, true, '回滚后同一事件可重新提交');
  assert.strictEqual(l.size(), 2);
});

test('持久化⑨：store.load 双契约——同步数组行为不变，Promise 契约兼容，load 失败明确报错', async () => {
  const file = newFile();
  const store1 = fileStore(file);
  const l1 = createRelationshipLedger({ store: store1 });
  l1.submit({ eventType: 'tool_execution', salience: 9, confidence: 1, at: 0 }, CTX);
  assert.strictEqual(l1.size(), 1);

  // 异步契约：load 返回 Promise → restore 返回 Promise，结果形状一致
  const asyncStore = { append: store1.append, load() { return Promise.resolve(store1.load()); } };
  const l2 = createRelationshipLedger({ store: asyncStore });
  const r2 = await l2.restore();
  assert.strictEqual(r2.ok, true);
  assert.strictEqual(r2.restored, 1);
  assert.strictEqual(l2.size(), 1);
  assert.strictEqual(l2.has(l1.all()[0].eventId), true);

  // 同步契约：行为与旧版一致（直接返回结果对象，非 Promise）
  const l3 = createRelationshipLedger({ store: fileStore(file) });
  const r3 = l3.restore();
  assert.strictEqual(r3.ok, true);
  assert.strictEqual(r3.restored, 1);

  // 异步 load 失败：明确 LOAD_FAILED（rejected Promise 不逃逸）
  const l4 = createRelationshipLedger({ store: { append() {}, load() { return Promise.reject(new Error('io down')); } } });
  const r4 = await l4.restore();
  assert.strictEqual(r4.ok, false);
  assert.strictEqual(r4.error, LEDGER_ERRORS.LOAD_FAILED);
  assert.ok(/io down/.test(r4.cause));
});
