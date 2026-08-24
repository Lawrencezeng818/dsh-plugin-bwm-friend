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

// 公开协议工具（memory 抽取/persona 预设）——发布后经包名解析；开发同仓 fallback
let protocolMemory, protocolPersona;
try {
  protocolMemory = require('@laikaton/bwm-protocol/memory');
  protocolPersona = require('@laikaton/bwm-protocol/persona');
} catch {
  protocolMemory = require('../../bwm-protocol/schema/memory.js');
  protocolPersona = require('../../bwm-protocol/schema/persona.js');
}
const { extractFacts, mergeMemory, MEMORY_DEFAULTS } = protocolMemory;
const { PERSONA_PRESETS } = protocolPersona;

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

  /* ── Proactive API（P2-Proactive：数字人主动行为）──
   * idle → presence trigger（thinking 态）→ Mira 生成开场白 → replying → idle
   * 复用 requestState 生命周期；忙时不打断（busy 拒绝）
   */
  const proactive = {
    // 触发主动行为：Mira 主动生成开场白（greeting/checkin/memory）
    async trigger({ reason = 'greeting' } = {}) {
      if (agent.status().state !== 'idle') return { ok: false, error: 'busy' }; // 忙时不打断
      const requestId = `pro-${++seq}-${Date.now()}`;
      bus.emit(REQUEST_CHANNELS.start, { requestId, proactive: true });
      bus.emit('agent.thinking.start'); // presence → thinking（数字人思考态）
      try {
        const data = await post('/bwm-friend/companion/chat', {
          message: '',
          history: [],
          requestId,
          proactive: { reason },
        });
        if (data && data.reply) {
          bus.emit(REQUEST_CHANNELS.reply);
          bus.emit(REQUEST_CHANNELS.end);
          bus.emit('agent.thinking.end'); // presence → idle
          bus.emit('proactive.message', { reply: data.reply, reason, requestId }); // UI 显示主动气泡
          return { ok: true, reply: data.reply, reason, requestId };
        }
        bus.emit(REQUEST_CHANNELS.end);
        bus.emit('agent.thinking.end');
        return { ok: false, error: data && data.error ? data.error : 'empty-reply', requestId };
      } catch (e) {
        bus.emit(REQUEST_CHANNELS.end);
        bus.emit('agent.thinking.end');
        return { ok: false, error: e && e.name === 'TimeoutError' ? 'timeout' : 'network', requestId };
      }
    },
    // 订阅主动消息（宿主 UI 显示主动气泡 + TTS 朗读）
    on(callback) {
      return bus.on('proactive.message', (p) => callback(p));
    },
  };

  /* ── Persona API（P3 冻结 + P2-P switch 落地）── */
  const persona = {
    // 当前人格（identity + personality 合并视图）
    get() {
      return {
        identity: context.get('identity') || {},
        personality: context.get('personality') || {},
      };
    },
    // 可用人格预设列表
    list() {
      return Object.values(PERSONA_PRESETS).map((p) => ({ id: p.id, label: p.label }));
    },
    // 切换人格预设（P2-P 落地：校验存在 → 更新 runtime identity/personality 域 → 广播事件）
    switch(id) {
      const preset = PERSONA_PRESETS[id];
      if (!preset) throw new Error(`unknown-persona: ${id}`);
      context.set('identity', { ...preset.identity });
      context.set('personality', { ...preset.personality });
      bus.emit('persona.switch', { id });
      return persona.get();
    },
  };

  /* ── Memory API（P2-M：FACT 抽取共享 protocol，写入 context.memory 域）── */
  const memory = {
    // 记住一条消息（抽取事实 + 最近话题；memory 域 persist → persistSnapshot 自动落盘）
    remember(text) {
      const cur = context.get('memory') || {};
      const next = mergeMemory(cur, String(text));
      context.set('memory', next);
      bus.emit('memory.updated', { facts: extractFacts(String(text)) });
      return next;
    },
    // 读取记忆
    recall() {
      return context.get('memory') || { ...MEMORY_DEFAULTS };
    },
    // 忘记某个事实
    forget(fact) {
      const cur = context.get('memory') || {};
      const next = {
        ...cur,
        userFacts: (cur.userFacts || []).filter((f) => f !== fact),
        updatedAt: new Date().toISOString(),
      };
      context.set('memory', next);
      return next;
    },
  };

  /* ── Voice API（P2-V：封装 host /tts + /transcribe，供多端复用）── */
  let voiceAudio = null;
  const voice = {
    // 文本 → TTS 播放（复用单例 Audio；Node 环境无 Audio → 返回 false）
    speak(text, { voice: voiceName = '冰糖' } = {}) {
      return post('/bwm-friend/tts', { text, voice: voiceName })
        .then((data) => {
          if (!data || !data.ok || !data.audioBase64) return false;
          if (typeof Audio === 'undefined') return false;
          voiceAudio = voiceAudio || new Audio();
          voiceAudio.src = 'data:audio/mp3;base64,' + data.audioBase64;
          return voiceAudio.play().catch(() => false);
        })
        .catch(() => false);
    },
    // 录音 → ASR 文本；返回控制句柄（stop() 结束录音，onResult 回调文本）
    listen(onResult) {
      return new Promise((resolve, reject) => {
        if (typeof navigator === 'undefined' || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
          return reject(new Error('no-mic'));
        }
        navigator.mediaDevices.getUserMedia({ audio: true }).then((stream) => {
          const mime = typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : 'audio/mp4';
          const recorder = new MediaRecorder(stream, { mimeType: mime });
          const chunks = [];
          recorder.ondataavailable = (ev) => { if (ev.data.size > 0) chunks.push(ev.data); };
          recorder.onstop = () => {
            stream.getTracks().forEach((t) => t.stop());
            const blob = new Blob(chunks, { type: mime });
            if (blob.size < 1000) return onResult && onResult({ ok: false, error: 'too-short' });
            const reader = new FileReader();
            reader.onload = () => {
              const audioBase64 = String(reader.result).split(',')[1] || '';
              post('/bwm-friend/transcribe', { audioBase64, format: mime.indexOf('webm') >= 0 ? 'webm' : 'mp4' })
                .then((d) => onResult && onResult(d && d.ok ? { ok: true, text: d.text } : { ok: false, error: 'asr-failed' }))
                .catch((e) => onResult && onResult({ ok: false, error: e.message || 'network' }));
            };
            reader.readAsDataURL(blob);
          };
          recorder.start();
          resolve({ stop: () => recorder.stop(), cancel: () => { try { recorder.stop(); } catch { /* noop */ } stream.getTracks().forEach((t) => t.stop()); } });
        }).catch((e) => reject(e));
      });
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
    proactive,
    persona,
    presence,
    memory,
    voice,
    // 底层透传（进阶使用/调试）
    events: { on: (c, fn, o) => bus.on(c, fn, o), emit: (c, p, m) => bus.emit(c, p, m) },
    context,
  };
}

module.exports = { createBwmRuntime };
