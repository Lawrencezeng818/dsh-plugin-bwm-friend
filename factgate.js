/**
 * Package-owned fact gate companion for `dsh-plugin-bwm-friend`（专利→生产力：事实探测与执行门控）
 * @module dsh-plugin-bwm-friend/factgate
 *
 * 把 @laikaton/bwm-runtime-core 事件内核的"门控获准帧"思想（index.js:87 `if (blocked) return ev;`）
 * 装到 harness 会话层，让每个智能体开箱具备：
 *  - fact_probe   事实域权威源探测（命中行 + 来源路径 + 存在性）
 *  - fact_assert  断言核验门控——ADMITTED 发票据；BLOCKED 拦截 + 理由（拦截不成为事实）
 *  - fact_ledger  审计账本（单调序号、上限 500 滚动）+ 每域当前有效票据（retained 语义）
 *  - 全局写保护守卫：权威源文件对 write/edit 工具只读（tools.guard；普通上下文注册 = 全局生效，
 *    单调不可翻案——见 dsh-tools index.ts:1104）
 *
 * ⚠️ 本 companion 以 bundle patch 行加载（真实上下文）。动态会话插件的沙箱门面会剥掉
 *    tools.guard（cordis-host-runner/guard.ts 只暴露 register/schemas/get——设计性防止包代码
 *    绕过身份保护与单调守卫），因此写保护只能在此部署级挂载；会话内原型已按"显式降级"
 *    处理同一限制（fgate-2/pkg-5）。
 * ⚠️ fs/tools 均按可选服务读取（ctx.get + 特性检测，同 invariant.js 纪律：inject 声明必需
 *    会在服务缺席时 boot pending——实测教训）。缺席/异常一律显式降级报告，绝不静默放行。
 *
 * Settings 化（2026-09-22）：事实域注册表支持配置覆盖——优先读
 * `~/.dsh-bwm-friend/config.json` 的 `factgate.domains`（{ 域ID: {label, source} }，
 * 经主插件 settings PUT 白名单 + bwm-protocol schema 校验落盘），覆盖内置默认；
 * 读取失败/缺项回退内置默认（settings 化的常态路径，不告警；形状非法键丢弃）。
 *
 * 部署级显式化（2026-10-06 · P0-2 增量2 P0-F 路径B）：本文件不随 npm 包发布（不在
 * files 白名单），随包 cordis.patch.yml 的本条目默认 `disabled: true`（随包面不得
 * 活跃引用包外文件）。部署侧启用步骤——profile 用户层 patch（~/.dsh/<profile>/
 * cordis.patch.yml）追加复启用条目（后层可覆盖先层 insert 行，宿主 applyEntryPatches
 * 支持逐属性覆盖）：
 *   - id: bwm-friend-factgate
 *     disabled: false
 * 保留 package.json exports['./factgate'] 的依据：宿主 cordis loader 对 entry.name 走
 * 裸说明符 import(name)（deepseek-harness vendor/loader/src/config/tree.ts:145-161），
 * Node 解析受 exports 门控——删除该条目 = 部署侧 ERR_PACKAGE_PATH_NOT_EXPORTED 断链
 * （2026-10-06 独立进程 A/B 实证）。
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const BUILTIN_DOMAINS = {
  'patent-status': {
    label: '专利申请状态',
    source: '/Users/zengtian/Empire-Soul-Origin/创世者知识库/05_Patent_Matrix/专利官方命名总表.md',
  },
  'package-compliance': {
    label: '专利包合规指纹',
    source: '/Users/zengtian/projects/bwm-patents/重构工作/bwm专利2_事件内核存在状态生成_自行递交包_2026-09-19/优化版_v2_2026-09-20/SHA256SUMS.txt',
  },
  'env-config': {
    label: '智能体环境配置',
    source: '/Users/zengtian/.dsh-bwm/AGENTS.md',
  },
  'e-receipt': {
    label: '电子回执与受理状态',
    source: '/Users/zengtian/Empire-Soul-Origin/创世者知识库/05_Patent_Matrix/专利官方命名总表.md',
  },
}

/** 读取用户配置覆盖（~/.dsh-bwm-friend/config.json → factgate.domains）；非法形状逐键丢弃。 */
function loadDomainOverrides() {
  try {
    const cfg = JSON.parse(readFileSync(join(homedir(), '.dsh-bwm-friend', 'config.json'), 'utf8'));
    const d = cfg && cfg.factgate && cfg.factgate.domains;
    if (!d || typeof d !== 'object' || Array.isArray(d)) return {};
    const out = {};
    for (const [id, v] of Object.entries(d)) {
      if (v && typeof v === 'object' && !Array.isArray(v)
        && typeof v.label === 'string' && v.label
        && typeof v.source === 'string' && v.source) {
        out[id] = { label: v.label, source: v.source };
      }
    }
    return out;
  } catch { return {}; } // 无配置文件 = 内置默认（常态），读取失败同样回退（不阻断插件加载）
}

const DOMAINS = { ...BUILTIN_DOMAINS, ...loadDomainOverrides() };

const STATUS_WORDS = ['已递交', '已申请', '已公布', '受理', '授权', '驳回', '撤回', '视撤']

export const name = 'bwm-friend-factgate'
/** 不声明必需注入（fs/tools 缺席时显式降级，不阻塞宿主启动——invariant 同款教训）。 */
export const inject = []

export const apply = (ctx) => {
  // ── 账本（history：单调序号、上限 500 滚动）+ 每域当前有效票据（retained）──
  const ledger = []
  const seq = { n: 0 }
  const tickets = new Map()
  const record = (entry) => {
    seq.n += 1
    const e = Object.assign({ seq: seq.n, at: new Date().toISOString() }, entry)
    ledger.push(e)
    if (ledger.length > 500) ledger.shift()
    return e
  }

  // ── 探测器：读权威源返回命中行；fs 不可用 = 显式失灵，绝不静默放行 ──
  const probe = async (domain, keyword) => {
    const d = DOMAINS[domain]
    if (!d) return { ok: false, reason: `未知事实域: ${domain}` }
    const fs = ctx.get('fs')
    if (!fs) return { ok: false, reason: '闸机失灵：fs 服务不可用（拒绝断言，不静默放行）' }
    try {
      const target = await fs.resolve(d.source)
      const info = await fs.stat(target)
      if (!info) return { ok: false, reason: `权威源缺失: ${d.source}` }
      const text = await fs.readText(target)
      const hits = []
      text.split('\n').forEach((line, i) => {
        if (line.includes(keyword)) hits.push({ line: i + 1, text: line.slice(0, 200) })
      })
      return { ok: true, domain, source: d.source, size: info.size, hits }
    } catch (e) {
      return { ok: false, reason: `闸机失灵：读取权威源失败 ${e && e.message ? e.message : String(e)}` }
    }
  }

  // ── 门控裁决：ADMITTED 发票据，BLOCKED 给理由（拦截不成为事实）──
  const assertFact = async (domain, claim, keyword) => {
    const p = await probe(domain, keyword)
    if (!p.ok) {
      const e = record({ kind: 'ASSERT', claim, verdict: 'BLOCKED', reason: p.reason })
      return { verdict: 'BLOCKED', seq: e.seq, reason: p.reason }
    }
    if (p.hits.length === 0) {
      const e = record({ kind: 'ASSERT', claim, verdict: 'BLOCKED', reason: '权威源零命中' })
      return {
        verdict: 'BLOCKED', seq: e.seq, evidence: [],
        reason: `权威源（${p.source}）检索不到「${keyword}」：断言缺乏事实依据`,
      }
    }
    const rowText = p.hits.map((h) => h.text).join(' ')
    const claimed = STATUS_WORDS.filter((w) => claim.includes(w))
    const unsupported = claimed.filter((w) => !rowText.includes(w))
    if (unsupported.length > 0) {
      const e = record({ kind: 'ASSERT', claim, verdict: 'BLOCKED', reason: '状态词与权威源不符', unsupported })
      return {
        verdict: 'BLOCKED', seq: e.seq, evidence: p.hits.slice(0, 3),
        reason: `断言的状态 ${JSON.stringify(unsupported)} 未出现在权威源命中行`,
      }
    }
    const e = record({ kind: 'ASSERT', claim, verdict: 'ADMITTED' })
    const ticket = { id: `factgate-t${e.seq}`, domain, claim, at: e.at, source: p.source }
    e.ticketId = ticket.id
    tickets.set(domain, ticket)
    return { verdict: 'ADMITTED', seq: e.seq, ticket, evidence: p.hits.slice(0, 3) }
  }

  const mk = (name2, description, parameters, execute) => ({
    name: name2,
    description,
    parameters,
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    execute: (args) => execute(args || {}),
  })

  // ── 工具注册（真实 ToolRuntime.register；逐具 try/catch，单具被拒不拖垮其余）──
  const tools = ctx.get('tools')
  if (!tools || typeof tools.register !== 'function') {
    console.error('[factgate] 闸机降级：tools 服务不可用——探测/断言/账本工具未注册')
    return
  }
  const defs = [
    mk('fact_probe', '探测事实域权威源：返回关键词命中行、来源路径。断言事实前必须先探测。',
      { type: 'object', properties: { domain: { type: 'string', enum: Object.keys(DOMAINS), description: '事实域' }, keyword: { type: 'string', description: '实体关键词（简称/申请号/公布号/文件名）' } }, required: ['domain', 'keyword'] },
      (a) => probe(a.domain, a.keyword)),
    mk('fact_assert', '事实门控：核验一条事实性断言。ADMITTED 发放票据；BLOCKED 返回拦截理由与证据。',
      { type: 'object', properties: { domain: { type: 'string', enum: Object.keys(DOMAINS), description: '事实域' }, claim: { type: 'string', description: '待核验的事实性断言（一句话）' }, keyword: { type: 'string', description: '断言主体的实体关键词' } }, required: ['domain', 'claim', 'keyword'] },
      (a) => assertFact(a.domain, a.claim, a.keyword)),
    mk('fact_ledger', '事实门控账本：最近的探测/断言/拦截记录与当前有效票据（上限500条，单调序号）。',
      { type: 'object', properties: {} },
      () => ({ total: ledger.length, recent: ledger.slice(-20).reverse(), tickets: Array.from(tickets.values()) })),
  ]
  for (const def of defs) {
    try {
      ctx.effect(() => tools.register(def))
    } catch (e) {
      console.error(`[factgate] 工具注册被拒 ${def.name}:`, e && e.message ? e.message : e)
    }
  }

  // ── 全局写保护守卫（普通上下文注册=全局生效；缺席显式降级）──
  if (typeof tools.guard === 'function') {
    ctx.effect(() => tools.guard((execution) => {
      if (execution.name !== 'write' && execution.name !== 'edit') return undefined
      const args = execution.arguments || {}
      const fp = String(args.file_path || '')
      for (const key of Object.keys(DOMAINS)) {
        if (fp === DOMAINS[key].source) {
          const e = record({ kind: 'GUARD_BLOCK', tool: execution.name, file_path: fp, domain: key })
          return `事实门控拦截(#${e.seq})：「${fp}」是 ${key} 域的权威事实源，禁止经通用写工具修改；更正须走创世者知识库流程。`
        }
      }
      return undefined
    }))
    console.log(`[factgate] 事实门控已挂载：域=${Object.keys(DOMAINS).join(',')}；写保护=开`)
  } else {
    console.error('[factgate] 闸机降级：tools.guard 不可用——权威源写保护未启用；三工具不受影响')
  }
}
