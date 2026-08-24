/**
 * @laikaton/bwm-sdk v0.1 — BWM Agent Runtime SDK（P3 雏形）
 *
 * 开发者友好 API：Agent / Persona / Presence 三域。
 * 原则：
 *   - 第三方不直接碰内部 JSON/状态机——SDK 是唯一入口
 *   - 核心决策闭源在 @laikaton/bwm-runtime-core（同仓 require 注入；未来 runtime 服务化后
 *     经 BWM Protocol 网络层替换，SDK 接口不变）
 *   - 与 docs/BWM-SDK-CONTRACT-v0.1.md 对齐（冻结 v0.1）
 */
// 闭源核心注入：发布后经包名解析；同仓开发经相对路径 fallback
let runtimeCore;
try {
  runtimeCore = require('@laikaton/bwm-runtime-core');
} catch {
  runtimeCore = require('../../bwm-runtime-core/src/index.js'); // 开发同仓
}
const { createRuntime } = runtimeCore;

const REQUEST_CHANNELS = {
  start: 'conversation.request.start',
  reply: 'conversation.request.reply',
  cancel: 'conversation.request.cancel',
  end: 'conversation.request.end',
};

/**
 * 创建 BWM Runtime SDK 实例。
 * @param {object} opts
 * @param {object} [opts.core] 注入的 runtime-core 实例（默认内部创建——闭源核心经 require 解析）
 * @param {string} [opts.hostBase=''] host 同源前缀（agent.send 的聊天端点）
 * @param {function} [opts.transport] 自定义传输（默认同源 fetch POST JSON）——多端/服务端可注入
 * @returns {{ agent, persona, presence, events, context }}
 */
function createBwmRuntime(opts = {}) {
  const { hostBase = '', transport } = opts;
  const runtime = opts.core || createRuntime();
  const bus = runtime.bus;
  const context = runtime.context;

  const post = transport || ((path, body) =>
    fetch(hostBase + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => r.json()));

  /* ── Agent API（P3 冻结）── */
  let seq = 0;
  const agent = {
    // 发送消息 → 回复；内部维护 requestState（idle→thinking→replying→idle）
    async send(message, optsSend = {}) {
      const requestId = optsSend.requestId || `sdk-${++seq}-${Date.now()}`;
      bus.emit(REQUEST_CHANNELS.start, { requestId });
      try {
        const data = await post('/bwm-friend/companion/chat', {
          message: String(message),
          history: optsSend.history || [],
          requestId,
        });
        if (data && data.reply !== undefined && data.reply !== null) {
          bus.emit(REQUEST_CHANNELS.reply);
          bus.emit(REQUEST_CHANNELS.end);
          return { ok: true, reply: data.reply, requestId };
        }
        bus.emit(REQUEST_CHANNELS.end);
        return { ok: false, error: data && data.error ? data.error : 'empty-reply', requestId };
      } catch (e) {
        bus.emit(REQUEST_CHANNELS.end);
        return { ok: false, error: e && e.name === 'TimeoutError' ? 'timeout' : 'network', requestId };
      }
    },
    // 取消当前请求（语音打断/用户停止——未来接 DSH Stop）
    cancel() {
      bus.emit(REQUEST_CHANNELS.cancel);
      return agent.status();
    },
    // 当前请求状态
    status() {
      return ((context.get('conversation') || {}).requestState) || { state: 'idle', requestId: null, startedAt: null };
    },
  };

  /* ── Persona API（P3 冻结）── */
  const persona = {
    // 当前人格（identity + personality 合并视图）
    get() {
      return {
        identity: context.get('identity') || {},
        personality: context.get('personality') || {},
      };
    },
    // 切换人格预设（v0.1：MIRA 唯一预设，switch 重置为默认——未来多预设/演进 Runtime 扩展）
    switch(_id) {
      // runtime 域只读保护下，人格切换由 Runtime 决策（未来：persona.switch 事件 + Evolution Runtime）
      bus.emit('persona.switch', { id: _id });
      return persona.get();
    },
  };

  /* ── Presence API（P3 冻结）── */
  const presence = {
    // 当前 presence 状态
    state() {
      return (context.get('presence') || {}).state || 'idle';
    },
    // 订阅 presence 状态变化（回调收到新 state）
    observe(callback) {
      return bus.on('presence:state', (p) => { if (p && p.state) callback(p.state, p); });
    },
  };

  return {
    agent,
    persona,
    presence,
    // 底层透传（进阶使用/调试）
    events: { on: (c, fn, o) => bus.on(c, fn, o), emit: (c, p, m) => bus.emit(c, p, m) },
    context,
  };
}

module.exports = { createBwmRuntime };
