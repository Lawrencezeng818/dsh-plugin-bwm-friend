/**
 * @laikaton/bwm-cognitive-core — 认知内核（私有 · 不随公开包分发）
 *
 * 归属（2026-11-01 P1-lite 裁决 · R79 复核后落地）：
 *   本包集中承载「含未公开专利实施例」的两块实现，自 @laikaton/bwm-runtime-core 迁入：
 *     · perception-router.js  —— 专利 5：感知事件跨状态域路由与一致性编排
 *     · relationship-ledger.js —— 专利 4：关系账本六步机制链
 *     · bridge（本文件）      —— 感知-账本边界接线（原 core/index.js:596-645）
 *
 * 为何单独立包：
 *   专利实施例随 npm 公开包发布构成「专利自我公开」（0.6.0 事故根因，bwm-patents 2026-09-22 复核）。
 *   P1-lite 取证（2026-11-01）确认三者**业务侧零消费**（client / host / sdk 均无调用），
 *   故整体离包不引发功能缺失，只需保留内部可测。
 *
 * 分发纪律（🔴 R2）：
 *   - `private: true` + `UNLICENSED`，永不发布到任何公开 registry；
 *   - 不得被 `package.json` 的 `files` 白名单收录；
 *   - 不得被 `scripts/inline-modules.mjs` 内联进 `lib/client.js`（audit [F] F7/F8 守卫）；
 *   - 任何重新引入公开包的动作，须先过 patent-vault + 小沈复核。
 *
 * 注意：本包不依赖 @laikaton/bwm-runtime-core，亦不被其依赖（单向零耦合）。
 */

const {
  createPerceptionRouter,
  DOMAIN_CLASS,
  UPDATE_MODES,
  DEFAULT_DOMAINS,
  PERCEPTION_ERRORS,
} = require('./perception-router.js');

const {
  createRelationshipLedger,
  RULE_TABLES,
  DEFAULT_RULES_VERSION,
  RELATIONSHIP_DIMENSIONS,
  LEDGER_ERRORS,
  evidenceFactorOf,
} = require('./relationship-ledger.js');

/**
 * 感知-账本边界接线：把感知路由器产出的「候选写入指令」消费为关系账本条目。
 *
 * 感知路由器只决策"某域是否允许写入"，**不做关系增量计算、不写关系账本**（其文件头声明）；
 * 本函数即那条声明所指的「账本端」——准入后的确定性增量计算与账本写入由关系账本模块独占。
 * 共享事件标识（update.eventId）在此串联感知侧与账本侧，保证同源可溯。
 */
function bridgePerceptionToLedger(ledger, update, opts = {}) {
  if (!ledger || !update) return { ok: false, error: 'missing_ledger_or_update' };
  // 准入复核（P1 修复 · 家族边界：账本端独占最终准入）：仅当指令确实落在持久域（ledger）
  // 且获准持久化（PERSIST）才可进账本；易失/延迟/拒绝指令被强行桥接时拒绝并如实返回，
  // 持久化准入不可经桥接旁路。
  if (update.domain !== 'ledger' || update.mode !== UPDATE_MODES.PERSIST) {
    return { ok: false, error: 'not_persist_granted', domain: update.domain || null, mode: update.mode || null };
  }
  const payload = update.payload || {};
  return ledger.submit(
    {
      eventId: update.eventId,                 // 共享事件标识（跨域串联）
      eventType: opts.eventType || 'companion_chat',
      summary: payload.summary || '',
      contextRef: opts.contextRef || null,
      presenceState: opts.presenceState || null,
      evidenceSource: 'perception',            // 感知派生事件 → 置信度系数 = 显著性÷10
      subjectId: update.subjectId,
      relationScope: update.relationScope,
      salience: payload.salience == null ? 0 : payload.salience,
      confidence: opts.confidence == null ? 1 : opts.confidence,
      // 确认标记透传（账本端 admit 二次门复核）：优先取调用方显式值，否则取路由指令携带的确认信息
      userConfirmed: opts.userConfirmed != null
        ? !!opts.userConfirmed
        : (payload.sourceType === 'explicit_share' || payload.userConfirmed === true),
      at: update.at,
    },
    {
      binding: {
        subjectId: update.subjectId,
        relationScope: update.relationScope,
        evidenceSource: 'perception',
        basis: 'perception_route_permitted',
      },
      snapshot: opts.snapshot || {},
      at: update.at,
    }
  );
}

module.exports = {
  // 专利 5：感知路由器
  createPerceptionRouter,
  DOMAIN_CLASS,
  UPDATE_MODES,
  DEFAULT_DOMAINS,
  PERCEPTION_ERRORS,
  // 专利 4：关系账本
  createRelationshipLedger,
  RULE_TABLES,
  DEFAULT_RULES_VERSION,
  RELATIONSHIP_DIMENSIONS,
  LEDGER_ERRORS,
  evidenceFactorOf,
  // 边界接线
  bridgePerceptionToLedger,
};
