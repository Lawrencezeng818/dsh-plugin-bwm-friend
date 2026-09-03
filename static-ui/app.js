const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const socketClientId =
  globalThis.crypto?.randomUUID?.() ||
  `tab-${Date.now()}-${Math.random().toString(16).slice(2)}`;
const RECORDING_TAIL_PADDING_MS = 500;
const SERVER_VAD_FLUSH_MS = 1600;
const VOICE_RESULT_TIMEOUT_MS = 12000;

const elements = {
  assistantReplies: $("#assistantReplies"),
  assistantText: $("#assistantText"),
  assetTypeLabel: $("#assetTypeLabel"),
  avatarDriver: $("#avatarDriver"),
  avatarDriverServiceLabel: $("#avatarDriverServiceLabel"),
  avatarDriverStatus: $("#avatarDriverStatus"),
  avatarImage: $("#avatarImage"),
  avatarInput: $("#avatarInput"),
  avatarName: $("#avatarName"),
  avatarPlaceholder: $("#avatarPlaceholder"),
  avatarVideo: $("#avatarVideo"),
  brandAuthor: $("#brandAuthor"),
  characterName: $("#characterName"),
  templateGrid: $("#templateGrid"),
  templateStatus: $("#templateStatus"),
  voiceSelect: $("#voiceSelect"),
  voiceStatus: $("#voiceStatus"),
  accountStatus: $("#accountStatus"),
  accountLoggedOut: $("#accountLoggedOut"),
  accountLoggedIn: $("#accountLoggedIn"),
  accountSubject: $("#accountSubject"),
  loginPhone: $("#loginPhone"),
  loginPassword: $("#loginPassword"),
  loginButton: $("#loginButton"),
  logoutButton: $("#logoutButton"),
  customTemplateStatus: $("#customTemplateStatus"),
  customTemplateGrid: $("#customTemplateGrid"),
  addCustomTemplate: $("#addCustomTemplate"),
  bgTemplateGrid: $("#bgTemplateGrid"),
  customTplPreview: $("#customTplPreview"),
  voiceCloneArea: $("#voiceCloneArea"),
  voiceCloneFile: $("#voiceCloneFile"),
  voiceCloneBtn: $("#voiceCloneBtn"),
  voiceCloneStatus: $("#voiceCloneStatus"),
  customTemplateForm: $("#customTemplateMask"),
  customTplModalClose: $("#customTplModalClose"),
  wizardPrev: $("#wizardPrev"),
  wizardNext: $("#wizardNext"),
  customTplName: $("#customTplName"),
  customTplImage: $("#customTplImage"),
  customTplBg: $("#customTplBg"),
  customTplIdlePrompt: $("#customTplIdlePrompt"),
  customTplSpeakPrompt: $("#customTplSpeakPrompt"),
  customTplVoice: $("#customTplVoice"),
  customTplProgress: $("#customTplProgress"),
  customTplProgressFill: $("#customTplProgressFill"),
  customTplProgressMsg: $("#customTplProgressMsg"),
  customTplSubmit: $("#customTplSubmit"),
  customTplCancel: $("#customTplCancel"),
  personaInput: $("#personaInput"),
  personaTemplateName: $("#personaTemplateName"),
  personaSaveBtn: $("#personaSaveBtn"),
  paywallMask: $("#paywallMask"),
  paywallClose: $("#paywallClose"),
  iapBox: $("#iapBox"),
  iapProductInfo: $("#iapProductInfo"),
  iapBuyButton: $("#iapBuyButton"),
  iapRestoreButton: $("#iapRestoreButton"),
  iapStatus: $("#iapStatus"),
  copyStage: $(".copy-stage"),
  composer: $("#composer"),
  composerHint: $("#composerHint"),
  history: $(".history"),
  historyCount: $("#historyCount"),
  historyList: $("#historyList"),
  historyToggle: $("#historyToggle"),
  idleUploadProgress: $("#idleUploadProgress"),
  idleVideoInput: $("#idleVideoInput"),
  idleVideoName: $("#idleVideoName"),
  llmApiKey: $("#llmApiKey"),
  llmBaseUrl: $("#llmBaseUrl"),
  llmExternalFields: $("#llmExternalFields"),
  llmModel: $("#llmModel"),
  llmModelPresets: $("#llmModelPresets"),
  llmProvider: $("#llmProvider"),
  llmProviderStatus: $("#llmProviderStatus"),
  llmServiceLabel: $("#llmServiceLabel"),
  messageInput: $("#messageInput"),
  placeholderButton: $("#placeholderButton"),
  placeholderCopy: $("#placeholderCopy"),
  placeholderTitle: $("#placeholderTitle"),
  voiceServiceLabel: $("#voiceServiceLabel"),
  presenceState: $("#presenceState"),
  refreshStatus: $("#refreshStatus"),
  replayButton: $("#replayButton"),
  resultVideo: $("#resultVideo"),
  sendButton: $(".send-button"),
  saveLlmProvider: $("#saveLlmProvider"),
  settingsButton: $("#settingsButton"),
  settingsClose: $("#settingsClose"),
  settingsPanel: $("#settingsPanel"),
  settingsScrim: $("#settingsScrim"),
  stageFrame: $(".stage-frame"),
  silentVideoCreatorLink: $("#silentVideoCreatorLink"),
  clearLlmApiKey: $("#clearLlmApiKey"),
  toast: $("#toast"),
  confirmMask: $("#confirmMask"),
  confirmDesc: $("#confirmDesc"),
  confirmCancel: $("#confirmCancel"),
  confirmOk: $("#confirmOk"),
  turnLabel: $("#turnLabel"),
  uploadCopy: $("#uploadCopy"),
  uploadProgress: $("#uploadProgress"),
  uploadTitle: $("#uploadTitle"),
  voiceButton: $("#voiceButton"),
  voiceLabel: $("#voiceLabel"),
  quotaBadge: $("#quotaBadge"),
  voiceHint: $("#voiceHint"),
  voiceOrbWrap: $(".voice-orb-wrap"),
  appVersionText: $("#appVersionText"),
  updateStatusText: $("#updateStatusText"),
  checkUpdateBtn: $("#checkUpdateBtn"),
  updateInfoBox: $("#updateInfoBox"),
  updateMask: $("#updateMask"),
  updateTitle: $("#updateTitle"),
  updateDesc: $("#updateDesc"),
  updateNotes: $("#updateNotes"),
  updateProgress: $("#updateProgress"),
  updateProgressFill: $("#updateProgressFill"),
  updateProgressMsg: $("#updateProgressMsg"),
  updateLater: $("#updateLater"),
  updateAction: $("#updateAction"),
  updateClose: $("#updateClose"),
};

const state = {
  avatar: null,
  avatarDriver: "video",
  busy: false,
  config: null,
  history: [],
  idleVideo: null,
  llmProvider: null,
  latestResultUrl: null,
  microphoneStream: null,
  playbackRequest: 0,
  inputContext: null,
  inputProcessor: null,
  inputSource: null,
  inputSink: null,
  activeResponseId: null,
  recordingRequested: false,
  recordingStarting: false,
  stoppingRecording: false,
  recording: false,
  responseEventIds: new Set(),
  responseOpen: false,
  responseParts: [],
  responseRawText: "",
  responseText: "",
  reconnectTimer: null,
  dialogueMotionTimer: null,
  socket: null,
  toastTimer: null,
  voiceResultTimer: null,
  voicePointerId: null,
};

class PcmStreamPlayer {
  constructor() {
    this.context = null;
    this.cursor = 0;
    this.sources = new Set();
  }

  async activate() {
    if (!this.context) {
      this.context = new AudioContext({ latencyHint: "interactive" });
    }
    if (this.context.state === "suspended") {
      await this.context.resume();
    }
  }

  async enqueue(base64Pcm) {
    await this.activate();
    const bytes = Uint8Array.from(atob(base64Pcm), (character) => character.charCodeAt(0));
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const sampleCount = Math.floor(bytes.byteLength / 2);
    const buffer = this.context.createBuffer(1, sampleCount, 16000);
    const channel = buffer.getChannelData(0);
    for (let index = 0; index < sampleCount; index += 1) {
      channel[index] = view.getInt16(index * 2, true) / 32768;
    }

    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.context.destination);
    const startAt = Math.max(this.context.currentTime + 0.025, this.cursor);
    source.start(startAt);
    this.cursor = startAt + buffer.duration;
    this.sources.add(source);
    source.addEventListener("ended", () => this.sources.delete(source), { once: true });
  }

  stop() {
    for (const source of this.sources) {
      try {
        source.stop();
      } catch {
        // A source may already have ended.
      }
    }
    this.sources.clear();
    this.cursor = this.context?.currentTime || 0;
  }

  // 解码并播放小米 MiMo 返回的 base64 MP3，返回音频时长（秒）以便调度恢复 idle。
  async playMp3(base64Mp3) {
    console.log("[diag] playMp3 start len=", base64Mp3.length, "ctx=", this.context?.state);
    await this.activate();
    const bytes = Uint8Array.from(atob(base64Mp3), (character) => character.charCodeAt(0));
    const slice = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    let audioBuffer;
    try {
      audioBuffer = await this.context.decodeAudioData(slice);
    } catch (err) {
      console.error("[diag] decodeAudioData FAIL", err);
      throw err;
    }
    console.log("[diag] decodeAudioData ok duration=", audioBuffer.duration.toFixed(2), "s");
    const source = this.context.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(this.context.destination);
    source.start();
    this.sources.add(source);
    source.addEventListener("ended", () => this.sources.delete(source), { once: true });
    return audioBuffer.duration;
  }
}

const audioPlayer = new PcmStreamPlayer();

// 小米流式分句 MP3 播放队列：服务端按句序推送 segment，前端边收边播
const mp3Queue = [];
let mp3Playing = false;
let mp3StreamEnded = false;
let mp3StreamTotal = 0;
let mp3PretendRequest = 0;

async function playMp3Segment(data, text) {
  mp3Queue.push({ data, text });
  if (!mp3Playing) await pumpMp3Queue();
}

async function pumpMp3Queue() {
  if (mp3Playing) return;
  mp3Playing = true;
  try {
    while (mp3Queue.length) {
      const item = mp3Queue.shift();
      // 声音开始播时同步显示该句文字（文字跟随声音，不提前冒出）
      if (item.text) setAssistantText(item.text, false);
      try {
        await audioPlayer.playMp3(item.data);
      } catch {
        // 解码失败的段直接跳过，不阻塞后续
      }
    }
  } finally {
    mp3Playing = false;
    maybeRestoreIdleAfterMp3();
  }
}

function endMp3Stream(total) {
  mp3StreamTotal = total;
  mp3StreamEnded = true;
  maybeRestoreIdleAfterMp3();
  // 兜底：end 已到且队列已播空，但恢复条件因故未触发时，3s 后强制切回待机
  const req = state.playbackRequest;
  window.setTimeout(() => {
    if (req === state.playbackRequest && mp3StreamEnded && !mp3Playing && !mp3Queue.length) {
      restoreIdleAvatar();
    }
  }, 3000);
}

function maybeRestoreIdleAfterMp3() {
  if (!mp3Playing && !mp3Queue.length && mp3StreamEnded) {
    mp3StreamEnded = false;
    if (state.playbackRequest === mp3PretendRequest) restoreIdleAvatar();
  }
}

const AUTHOR_CREDIT_PARTS = Object.freeze({
  prefix: [20316, 32773, 65306, 32],
  channel: [98, 31449, 32, 112, 101, 110, 112, 111, 115],
  separator: [32, 183, 32, 81, 81, 65306, 32],
  account: [50, 51, 54, 51, 57, 51, 57, 49, 56, 50],
});

function appendEncodedGlyphs(parent, codePoints) {
  codePoints.forEach((codePoint, index) => {
    const glyph = document.createElement("span");
    glyph.className = "credit-glyph";
    glyph.textContent = String.fromCodePoint(codePoint);
    parent.append(glyph);
    if (index < codePoints.length - 1) {
      parent.append(document.createTextNode("\u2060"));
    }
  });
}

function renderAuthorCredit() {
  if (!elements.brandAuthor) return;
  const channelLink = document.createElement("a");
  channelLink.href =
    "https://space.bilibili.com/3493282531248138?spm_id_from=333.1007.0.0";
  channelLink.target = "_blank";
  channelLink.rel = "noopener noreferrer";
  channelLink.setAttribute("aria-label", "打开作者的哔哩哔哩主页");

  appendEncodedGlyphs(elements.brandAuthor, AUTHOR_CREDIT_PARTS.prefix);
  appendEncodedGlyphs(channelLink, AUTHOR_CREDIT_PARTS.channel);
  elements.brandAuthor.append(channelLink);
  appendEncodedGlyphs(elements.brandAuthor, AUTHOR_CREDIT_PARTS.separator);
  appendEncodedGlyphs(elements.brandAuthor, AUTHOR_CREDIT_PARTS.account);
}

function showToast(message, duration = 3200) {
  clearTimeout(state.toastTimer);
  elements.toast.textContent = message;
  elements.toast.classList.add("show");
  state.toastTimer = setTimeout(() => elements.toast.classList.remove("show"), duration);
}

/* HTML 转义：错误信息/版本说明写入 innerHTML 前必须转义，防注入 */
function escapeHtml(text) {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/* 友好错误文案：技术错误细节进 console，用户只看可读信息 */
function friendlyError(error, fallback = "操作失败") {
  const raw = (error && (error.message || error.detail || String(error))) || "";
  console.error("[err]", raw);
  if (/fetch failed|networkerror|network error|failed to fetch|network request failed|load failed|connection (refused|reset|closed)/i.test(raw)) {
    return `${fallback}：网络连接不稳定，请重试`;
  }
  if (/aborted|timeout|timed out/i.test(raw)) {
    return `${fallback}：请求超时，请重试`;
  }
  if (/unknown or invalid event|unknown_or_invalid|literal_error|validationerror/i.test(raw)) {
    return `${fallback}：数据格式异常，请刷新页面重试`;
  }
  if (/unauthorized|401|登录|token/i.test(raw)) {
    return `${fallback}：登录状态已失效，请重新登录`;
  }
  // 业务性 detail（如"素材不能超过 50MB"）直接展示
  if (error && typeof error.detail === "string" && /[\u4e00-\u9fa5]/.test(error.detail)) {
    return `${fallback}：${error.detail}`;
  }
  // message 里的中文业务信息（如"模板不存在: xxx"）直接展示
  if (/[\u4e00-\u9fa5]/.test(raw)) {
    return `${fallback}：${raw}`;
  }
  return `${fallback}，请稍后重试`;
}

/* 自定义确认弹窗（替代原生 confirm——兼容 ego-lite 等浏览器，避免 unknown invalid 报错） */
function confirmDialog(desc) {
  return new Promise((resolve) => {
    const mask = elements.confirmMask;
    const descEl = elements.confirmDesc;
    if (!mask || !descEl) return resolve(true);
    descEl.textContent = desc;
    mask.classList.remove("hidden");
    const done = (val) => {
      mask.classList.add("hidden");
      elements.confirmCancel.removeEventListener("click", onCancel);
      elements.confirmOk.removeEventListener("click", onOk);
      resolve(val);
    };
    const onCancel = () => done(false);
    const onOk = () => done(true);
    elements.confirmCancel.addEventListener("click", onCancel);
    elements.confirmOk.addEventListener("click", onOk);
  });
}

function setPresence(label) {
  if (elements.presenceState) elements.presenceState.textContent = label;
}

function clearVoiceResultTimeout() {
  if (state.voiceResultTimer === null) return;
  clearTimeout(state.voiceResultTimer);
  state.voiceResultTimer = null;
}

function armVoiceResultTimeout() {
  clearVoiceResultTimeout();
  state.voiceResultTimer = setTimeout(() => {
    state.voiceResultTimer = null;
    if (state.responseOpen || state.recording || state.recordingRequested) return;
    setPresence(state.socket?.readyState === WebSocket.OPEN ? "在线" : "连接中断");
    showToast("没有听清，再按住说一次。", 4200);
  }, VOICE_RESULT_TIMEOUT_MS);
}

function setTurnLabel(text, userTurn = false) {
  elements.turnLabel.textContent = text;
  elements.turnLabel.classList.toggle("user-turn", userTurn);
}

function expandDialogue() {
  clearTimeout(state.dialogueMotionTimer);
  state.dialogueMotionTimer = null;
  elements.copyStage?.classList.remove("is-settled");
}

function settleDialogue(delay = 680) {
  clearTimeout(state.dialogueMotionTimer);
  state.dialogueMotionTimer = setTimeout(() => {
    state.dialogueMotionTimer = null;
    if (
      state.responseOpen ||
      state.recording ||
      state.recordingRequested ||
      elements.messageInput.value.trim()
    ) {
      return;
    }
    if (elements.assistantReplies.children.length) {
      elements.copyStage?.classList.add("is-settled");
    }
  }, delay);
}

function cleanAssistantText(text) {
  let clean = String(text || "");
  clean = clean.replace(
    /<(think|analysis|reasoning)\b[^>]*>[\s\S]*?<\/\1>/gi,
    "",
  );
  const unfinishedThought = clean.search(/<(think|analysis|reasoning)\b/i);
  if (unfinishedThought >= 0) clean = clean.slice(0, unfinishedThought);
  const finalAnswer = clean.match(
    /(?:最终回答|最终答复|最终台词)\s*[:：]\s*([\s\S]+)/i,
  );
  if (finalAnswer) clean = finalAnswer[1];
  clean = clean
    .replace(/\r\n?/g, "\n")
    .replace(/<\/?(?:think|analysis|reasoning)\b[^>]*>/gi, "")
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^[ \t]{0,3}(?:#{1,6}|>|[-+*][ \t])/gm, "")
    .replace(/[*_`~]/g, "")
    .replace(/[^\S\r\n]+/g, " ")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
  return clean;
}

function setAssistantText(text, updating = false) {
  const clean = cleanAssistantText(text);
  const length = Array.from(clean).length;
  elements.assistantText.textContent = clean || (updating ? "……" : "");
  elements.assistantText.title = clean;
  elements.assistantText.classList.toggle("updating", updating);
  elements.assistantText.classList.toggle("compact-response", length > 48);
  elements.assistantText.classList.toggle("dense-response", length > 96);
  fitAssistantLine(elements.assistantText);
}

function fitAssistantLine(line) {
  if (!line) return;
  line.style.removeProperty("font-size");
  requestAnimationFrame(() => {
    if (!line.isConnected || line.scrollWidth <= line.clientWidth) return;
    const currentSize = Number.parseFloat(getComputedStyle(line).fontSize);
    const fittedSize = Math.max(
      12,
      Math.floor((currentSize * line.clientWidth) / line.scrollWidth),
    );
    line.style.fontSize = `${fittedSize}px`;
  });
}

function beginAssistantTurn() {
  expandDialogue();
  const previous = elements.assistantText;
  if (previous?.dataset.intro === "true") {
    elements.assistantReplies.replaceChildren();
  } else if (previous) {
    previous.classList.remove("current", "updating");
  }

  const line = document.createElement("p");
  line.className = "assistant-reply current";
  line.setAttribute("aria-label", "小满本轮回复");
  elements.assistantReplies.append(line);
  while (elements.assistantReplies.children.length > 4) {
    elements.assistantReplies.firstElementChild?.remove();
  }
  elements.assistantText = line;
  setAssistantText("……", true);
}

const HISTORY_STORAGE_KEY_PREFIX = "cyber_girlfriend.chat.history.v2";
const HISTORY_LEGACY_KEY = "cyber_girlfriend.chat.history.v1";
const HISTORY_MAX = 100;

// 身份一致性索引：聊天记录（记忆状态）按模板（数字分身身份实例）隔离——
// 专利《基于身份一致性索引的数字分身跨模块状态同步运行方法及系统》权利要求3：
// 记忆状态不是独立历史数据，而是与身份实例关联。
function historyKeyForTemplate(template) {
  const t = String(template || "").trim() || "default";
  return `${HISTORY_STORAGE_KEY_PREFIX}.${t}`;
}

function currentTemplateName() {
  // 从当前加载的 persona/模板状态取（state.auth.template 或 persona API 已填充）
  return String(state?.auth?.template || state?.personaTemplate || "").trim();
}

function loadHistory() {
  try {
    const key = historyKeyForTemplate(currentTemplateName());
    const parsed = JSON.parse(localStorage.getItem(key) || "[]");
    if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    // ⚠️ 2026-08-16 迁移: v1→v2 无迁移导致老用户历史静默不可见（独立审查发现）
    // 首次读取且 v2 桶为空时，把 v1 全局历史迁入默认身份实例桶（旧全局历史归属 default）
    const legacy = JSON.parse(localStorage.getItem(HISTORY_LEGACY_KEY) || "[]");
    if (Array.isArray(legacy) && legacy.length > 0) {
      localStorage.setItem(historyKeyForTemplate(""), JSON.stringify(legacy));
      return legacy;
    }
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveHistory() {
  try {
    const key = historyKeyForTemplate(currentTemplateName());
    localStorage.setItem(key, JSON.stringify(state.history));
  } catch {
    // 存储不可用（隐私模式/禁用存储）时静默忽略，不影响聊天
  }
}

function renderHistory() {
  elements.historyCount.textContent = `${state.history.length} 条`;
  elements.historyList.replaceChildren(
    ...state.history.map((item) => {
      const row = document.createElement("div");
      row.className = "history-message";
      const label = document.createElement("b");
      label.textContent = item.role === "user" ? "你" : "她";
      const copy = document.createElement("span");
      copy.textContent = item.text;
      row.append(label, copy);
      return row;
    }),
  );
  elements.historyList.scrollTop = elements.historyList.scrollHeight;
}

function addHistory(role, text) {
  const clean = String(text || "").trim();
  if (!clean) return;
  state.history.push({ role, text: clean });
  if (state.history.length > HISTORY_MAX) state.history.shift();
  saveHistory();
  renderHistory();
}

function updateServices(services) {
  ["llm", "realtime"].forEach((name) => {
    const online = Boolean(services?.[name]);
    const pill = document.querySelector(`[data-service="${name}"]`);
    const detail = document.querySelector(`[data-service-text="${name}"]`);
    pill?.classList.toggle("online", online);
    if (detail) {
      if (name === "llm" && services?.llm_provider === "external") {
        detail.textContent = online ? "三方 API 已配置" : "三方 API 未配置";
      } else if (name === "llm") {
        detail.textContent = online ? "本地 Qwen 已连接" : "本地 Qwen 未连接";
      } else {
        detail.textContent = online ? "已连接" : "未连接";
      }
      detail.classList.toggle("online", online);
    }
  });
  if (elements.llmServiceLabel) {
    elements.llmServiceLabel.textContent =
      services?.llm_provider === "external" ? "三方语言模型" : "本地语言模型";
  }
  if (elements.voiceServiceLabel) {
    elements.voiceServiceLabel.textContent =
      services?.voice?.provider === "xiaomi" ? "小米 MiMo 声音" : "Qwen3-TTS 声音";
  }
  const driver = services?.avatar_driver || state.avatarDriver;
  const driverOnline = Boolean(services?.avatar_driver_ready);
  const driverDetail = document.querySelector('[data-service-text="avatarDriver"]');
  if (elements.avatarDriverServiceLabel) {
    elements.avatarDriverServiceLabel.textContent =
      driver === "image" ? "图片驱动" : "视频驱动";
  }
  if (driverDetail) {
    driverDetail.textContent = driverOnline ? "已连接" : "未连接";
    driverDetail.classList.toggle("online", driverOnline);
  }
}

/**
 * 视频 URL 匹配（容忍百分号编码差异：中文文件名在浏览器 src 中会被编码，
 * 而 config/API 返回的是原始中文 → 统一 decode 后再比较）
 */
function srcIncludes(url, expected) {
  if (!expected) return true;
  try {
    return decodeURIComponent(url).includes(decodeURIComponent(expected));
  } catch {
    return url.includes(expected);
  }
}

function freezeAvatarOnFirstFrame(expectedSource) {
  const freeze = () => {
    if (
      expectedSource &&
      !srcIncludes(elements.avatarVideo.src, expectedSource) &&
      !srcIncludes(elements.avatarVideo.currentSrc, expectedSource)
    ) {
      return;
    }
    elements.avatarVideo.pause();
    elements.avatarVideo.currentTime = 0;
    elements.avatarVideo.classList.add("ready");
    elements.avatarPlaceholder.classList.add("hidden");
  };

  elements.avatarVideo.loop = false;
  elements.avatarVideo.muted = true;
  elements.avatarVideo.pause();
  if (elements.avatarVideo.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
    freeze();
  } else {
    elements.avatarVideo.addEventListener("loadeddata", freeze, { once: true });
  }
}

function playIdleVideo(expectedSource) {
  const reveal = () => {
    if (
      expectedSource &&
      !srcIncludes(elements.avatarVideo.src, expectedSource) &&
      !srcIncludes(elements.avatarVideo.currentSrc, expectedSource)
    ) {
      return;
    }
    elements.avatarVideo.loop = true;
    elements.avatarVideo.muted = true;
    elements.avatarVideo.classList.add("ready");
    elements.avatarPlaceholder.classList.add("hidden");
    elements.avatarVideo.play().catch(() => {});
  };

  if (elements.avatarVideo.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
    reveal();
  } else {
    elements.avatarVideo.addEventListener("loadeddata", reveal, { once: true });
  }
}

function currentAvatar() {
  return state.avatar;
}

function setAvatar(avatar) {
  state.avatar = avatar?.url ? avatar : null;
  if (avatar?.driver) state.avatarDriver = avatar.driver;
  restoreIdleAvatar();
}

function restoreIdleAvatar() {
  state.playbackRequest += 1;
  elements.resultVideo.pause();
  elements.resultVideo.classList.remove("ready");
  const avatar = currentAvatar();
  const idleVideo = state.idleVideo;
  elements.avatarVideo.classList.remove("rendering");
  elements.avatarImage.classList.remove("ready");
  elements.avatarName.textContent = avatar?.name || "未选择";
  elements.idleVideoName.textContent = idleVideo?.name || "未选择";

  if (idleVideo?.url) {
    elements.avatarImage.removeAttribute("src");
    if (!srcIncludes(elements.avatarVideo.src, idleVideo.url)) {
      elements.avatarVideo.src = `${idleVideo.url}?v=${Date.now()}`;
    }
    playIdleVideo(idleVideo.url);
    return;
  }

  if (!avatar?.url) {
    elements.avatarVideo.pause();
    elements.avatarVideo.classList.remove("ready");
    elements.avatarImage.removeAttribute("src");
    elements.avatarPlaceholder.classList.remove("hidden");
    return;
  }

  if (avatar.kind === "image") {
    elements.avatarVideo.pause();
    elements.avatarVideo.classList.remove("ready");
    elements.avatarVideo.removeAttribute("src");
    elements.avatarImage.src = `${avatar.url}?v=${Date.now()}`;
    elements.avatarImage.classList.add("ready");
    elements.avatarPlaceholder.classList.add("hidden");
    return;
  }

  elements.avatarImage.removeAttribute("src");
  if (!srcIncludes(elements.avatarVideo.src, avatar.url)) {
    elements.avatarVideo.src = `${avatar.url}?v=${Date.now()}`;
  }
  freezeAvatarOnFirstFrame(avatar.url);
}

function updateAvatarDriverMode() {
  const imageMode = elements.avatarDriver.value === "image";
  state.avatarDriver = imageMode ? "image" : "video";
  elements.avatarDriverStatus.textContent = imageMode ? "图片驱动" : "视频驱动";
  elements.assetTypeLabel.textContent = imageMode ? "驱动图片" : "驱动视频";
  elements.uploadTitle.textContent = imageMode ? "替换角色图片" : "替换角色视频";
  elements.uploadCopy.textContent = imageMode
    ? "建议使用正脸、清晰、嘴部无遮挡的半身照片"
    : "建议五至十五秒、正脸、少遮挡、画面稳定";
  elements.avatarInput.accept = imageMode
    ? "image/jpeg,image/png,image/webp"
    : "video/mp4,video/quicktime,video/webm";
  elements.placeholderCopy.textContent = imageMode
    ? "上传一张正脸、清晰的角色图片"
    : "上传一段正脸、光线稳定的视频";
  elements.placeholderButton.textContent = imageMode ? "选择图片" : "选择视频";
  elements.silentVideoCreatorLink?.classList.toggle("hidden", imageMode);
  if (elements.avatarDriverServiceLabel) {
    elements.avatarDriverServiceLabel.textContent = imageMode ? "图片驱动" : "视频驱动";
  }
}

async function saveAvatarDriver() {
  const requested = elements.avatarDriver.value === "image" ? "image" : "video";
  elements.avatarDriver.disabled = true;
  elements.avatarDriverStatus.textContent = "正在切换";
  try {
    const response = await fetch("/api/avatar-driver", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ driver: requested }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.detail || `HTTP ${response.status}`);
    }
    state.avatarDriver = payload.driver;
    elements.avatarDriver.value = payload.driver;
    state.avatar = payload.avatar || null;
    if (state.config) {
      state.config.avatar = payload.avatar || null;
      state.config.lipsync = {
        ...(state.config.lipsync || {}),
        driver: payload.driver,
      };
      state.config.services = payload.services || state.config.services;
    }
    updateAvatarDriverMode();
    restoreIdleAvatar();
    updateServices(payload.services || {});
    const driverLabel = payload.driver === "image" ? "图片驱动" : "视频驱动";
    const ready = Boolean(payload.services?.avatar_driver_ready);
    if (payload.driver === "image" && !ready) {
      showToast("已保存为图片驱动，请检查云端服务和 SSH 隧道。");
    } else {
      showToast(
        ready
          ? `已切换到${driverLabel}。`
          : `已保存为${driverLabel}，重启一键启动后加载对应服务。`,
      );
    }
  } catch (error) {
    elements.avatarDriver.value = state.config?.lipsync?.driver || "video";
    updateAvatarDriverMode();
    showToast(friendlyError(error, "口型方案切换失败"));
  } finally {
    elements.avatarDriver.disabled = false;
  }
}

function openSettings() {
  elements.settingsPanel.classList.add("open");
  elements.settingsScrim.classList.add("open");
  elements.settingsPanel.setAttribute("aria-hidden", "false");
}

function closeSettings() {
  elements.settingsPanel.classList.remove("open");
  elements.settingsScrim.classList.remove("open");
  elements.settingsPanel.setAttribute("aria-hidden", "true");
}

function setBusy(busy) {
  state.busy = Boolean(busy);
  elements.messageInput.disabled = state.busy;
  elements.sendButton.disabled = state.busy;
  elements.voiceButton.disabled = state.busy || state.socket?.readyState !== WebSocket.OPEN;
  elements.composer.classList.toggle("busy", state.busy);
  elements.composerHint.textContent = state.busy
    ? "正在生成声画同步成片，请稍等……"
    : "Enter 发送 · Shift + Enter 换行";
}

function socketUrl() {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  // 支持路径前缀部署（如 /bwmf）：ws 挂在当前页面路径前缀下
  let base = location.pathname;
  if (!base.endsWith("/")) base = base.slice(0, base.lastIndexOf("/") + 1);
  return `${protocol}//${location.host}${base}ws/chat?client_id=${encodeURIComponent(socketClientId)}`;
}

function sendSocket(payload) {
  if (state.socket?.readyState !== WebSocket.OPEN) {
    showToast("声音服务尚未连接，请稍等。");
    return false;
  }
  state.socket.send(JSON.stringify(payload));
  return true;
}

function updateLlmProviderMode() {
  const external = elements.llmProvider.value === "external";
  elements.llmExternalFields.classList.toggle("disabled", !external);
  for (const input of [
    elements.llmBaseUrl,
    elements.llmApiKey,
    elements.llmModel,
  ]) {
    input.disabled = !external;
  }
  elements.clearLlmApiKey.disabled = !state.llmProvider?.hasApiKey;
  elements.llmProviderStatus.textContent = external
    ? state.llmProvider?.hasApiKey
      ? `三方 · ${elements.llmModel.value || "未选模型"}`
      : "三方 · 等待 Key"
    : "本地 Qwen";
}

function loadLlmProvider(config) {
  const provider = config || {};
  state.llmProvider = {
    provider: provider.provider === "external" ? "external" : "local",
    baseUrl:
      provider.baseUrl || "https://api.deepseek.com",
    model: provider.model || "deepseek-chat",
    hasApiKey: Boolean(provider.hasApiKey),
    presets: Array.isArray(provider.presets) ? provider.presets : [],
  };
  elements.llmProvider.value = state.llmProvider.provider;
  elements.llmBaseUrl.value = state.llmProvider.baseUrl;
  elements.llmModel.value = state.llmProvider.model;
  elements.llmApiKey.value = "";
  elements.llmApiKey.placeholder = state.llmProvider.hasApiKey
    ? "已保存，留空则保持不变"
    : "默认留空";
  elements.llmModelPresets.replaceChildren(
    ...state.llmProvider.presets.map((model) => {
      const option = document.createElement("option");
      option.value = model;
      return option;
    }),
  );
  updateLlmProviderMode();
}

async function saveLlmProvider() {
  const provider = elements.llmProvider.value;
  if (
    provider === "external" &&
    !elements.llmApiKey.value.trim() &&
    !state.llmProvider?.hasApiKey
  ) {
    showToast("切换三方 API 前请填写 API Key。");
    elements.llmApiKey.focus();
    return;
  }

  elements.saveLlmProvider.disabled = true;
  elements.saveLlmProvider.textContent = "保存中";
  try {
    const response = await fetch("/api/llm-provider", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider,
        baseUrl: elements.llmBaseUrl.value.trim(),
        apiKey: elements.llmApiKey.value.trim(),
        model: elements.llmModel.value.trim(),
      }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.detail || `HTTP ${response.status}`);
    }
    loadLlmProvider(payload.llmProvider);
    if (state.config) state.config.llmProvider = payload.llmProvider;
    await refreshStatus();
    showToast(
      payload.llmProvider.provider === "external"
        ? `已切换到三方模型 ${payload.llmProvider.model}，下一轮生效。`
        : "已切换到本地 Qwen，下一轮生效。",
    );
  } catch (error) {
    elements.llmProviderStatus.textContent = "保存失败";
    showToast(friendlyError(error, "语言模型设置失败"));
  } finally {
    elements.saveLlmProvider.disabled = false;
    elements.saveLlmProvider.textContent = "保存并切换";
  }
}

async function clearLlmApiKey() {
  if (!state.llmProvider?.hasApiKey) return;
  elements.clearLlmApiKey.disabled = true;
  try {
    const response = await fetch("/api/llm-provider", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "local",
        baseUrl: elements.llmBaseUrl.value.trim(),
        model: elements.llmModel.value.trim(),
        clearApiKey: true,
      }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.detail || `HTTP ${response.status}`);
    }
    loadLlmProvider(payload.llmProvider);
    if (state.config) state.config.llmProvider = payload.llmProvider;
    await refreshStatus();
    showToast("三方 API Key 已清除，并已切回本地 Qwen。");
  } catch (error) {
    showToast(friendlyError(error, "清除 API Key 失败"));
    updateLlmProviderMode();
  }
}

function scheduleSocketReconnect() {
  // ⚠️ 2026-08-16 核心修复：旧 timer 残留时直接 return 会导致重连永不执行（WS 断 → 麦克风永久禁用）
  // 旧 timer 可能已被 clearTimeout（connectSocket 开头清理）但状态未同步 → 无重连兜底
  if (state.reconnectTimer !== null) {
    clearTimeout(state.reconnectTimer);
    state.reconnectTimer = null;
  }
  state.reconnectTimer = setTimeout(() => {
    state.reconnectTimer = null;
    connectSocket();
  }, 2500);
}

function connectSocket() {
  if (
    state.socket?.readyState === WebSocket.CONNECTING ||
    state.socket?.readyState === WebSocket.OPEN
  ) {
    return;
  }
  if (state.reconnectTimer !== null) {
    clearTimeout(state.reconnectTimer);
    state.reconnectTimer = null;
  }

  const socket = new WebSocket(socketUrl());
  state.socket = socket;
  setPresence("正在连接", "listen");

  socket.addEventListener("open", () => {
    if (state.socket !== socket) return;
    state.realtimeToastShown = false;  // 重连成功，允许下次断连时再提示
    setPresence("在线", "listen");
    setBusy(state.busy);
  });

  socket.addEventListener("close", (event) => {
    if (state.socket !== socket) return;
    // 注意：不在这里重置 realtimeToastShown——
    // close 可能由 error 引起（服务端主动断开/槽位满），重置会导致下次 error 时 toast 再次弹出。
    // 只有在 open（成功连接）时才重置，确保用户只看到一次提示。
    clearVoiceResultTimeout();
    state.socket = null;
    setPresence("连接中断", "listen");
    elements.voiceButton.disabled = true;
    if (event.code === 4001) {
      setPresence("已在新窗口连接", "listen");
      return;
    }
    scheduleSocketReconnect();
  });

  socket.addEventListener("error", () => {
    if (state.socket !== socket) return;
    // 防抖：同一连接周期只弹一次，避免 realtime 未启动时反复刷屏
    if (!state.realtimeToastShown) {
      state.realtimeToastShown = true;
      showToast("Realtime 服务连接失败。");
    }
  });

  let realtimeEventChain = Promise.resolve();
  socket.addEventListener("message", (message) => {
    if (state.socket !== socket) return;
    const event = JSON.parse(message.data);
    realtimeEventChain = realtimeEventChain
      .then(() => handleRealtimeEvent(event))
      .catch((error) => console.error("[ws] 事件处理失败:", error));
  });
}

function responseIdFromEvent(event) {
  return String(event.response_id || event.response?.id || "").trim();
}

async function loadPersona() {
  try {
    const resp = await fetch("/api/template/persona");
    const data = await resp.json();
    state.personaTemplate = data.template || "default";
    if (elements.personaTemplateName) elements.personaTemplateName.textContent = data.template || "默认";
    if (elements.personaInput) elements.personaInput.value = data.persona || "";
  } catch (error) {
    console.error("[persona] 加载失败", error);
  }
}

async function savePersona() {
  const text = elements.personaInput?.value?.trim() || "";
  if (!text) return showToast("人格内容不能为空", 2600);
  try {
    const resp = await fetch("/api/template/persona", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ persona: text }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.detail || "保存失败");
    showToast(data.message || "人格已保存", 2600);
  } catch (error) {
    showToast(friendlyError(error, "保存人格失败"), 4200);
  }
}

const VOICE_DISPLAY = { Milo: "米勒", Dean: "迪恩", Mia: "米娅", Chloe: "克洛伊" };

/** 音色显示名：克隆音色(myvoice_*) → cloneName（模板名+克隆）；内置走映射 */
function voiceDisplay(v, cloneName) {
  if (!v) return v;
  if (String(v).startsWith("myvoice_")) return `🎙️ ${cloneName || "我的声音克隆"}`;
  return VOICE_DISPLAY[v] || v;
}

async function loadVoices() {
  const select = elements.voiceSelect;
  if (!select) return;
  try {
    const resp = await fetch("/api/voices");
    const data = await resp.json();
    const voices = data.voices || [];
    const current = data.current || "";
    const cloneNames = data.clone_names || {};  // {voice_id: "模板名克隆"}
    select.innerHTML = "";
    for (const v of voices) {
      const opt = document.createElement("option");
      opt.value = v;
      opt.textContent = voiceDisplay(v, cloneNames[v]);
      if (v === current) opt.selected = true;
      select.append(opt);
    }
    if (elements.voiceStatus) elements.voiceStatus.textContent = `当前：${voiceDisplay(current, cloneNames[current])}`;
    // 选择变化 → 确认弹窗 → 保存 → 刷新
    select.addEventListener("change", async () => {
      const chosen = select.value;
      if (!chosen || chosen === current) {
        select.value = current;
        return;
      }
      const ok = await confirmDialog(`确定将音色切换为「${chosen}」吗？\n切换后页面将刷新。`);
      if (!ok) {
        select.value = current;
        return;
      }
      if (elements.voiceStatus) elements.voiceStatus.textContent = "切换中…";
      try {
        const r = await fetch(`/api/voice/set?voice=${encodeURIComponent(chosen)}`, { method: "POST" });
        const d = await r.json();
        if (!r.ok) throw new Error(d.detail || "设置失败");
        showToast(`${d.message} · 刷新中…`);
        setTimeout(() => location.reload(), 600);
      } catch (error) {
        select.value = current;
        if (elements.voiceStatus) elements.voiceStatus.textContent = `当前：${current}`;
        showToast(friendlyError(error, "音色切换失败"), 4200);
      }
    });
  } catch (error) {
    console.error("[voice] 加载失败:", error);
    select.innerHTML = '<option value="">音色加载失败</option>';
  }
}

async function loadTemplates() {
  const grid = elements.templateGrid;
  if (!grid) return;
  try {
    const resp = await fetch("/api/templates");
    const data = await resp.json();
    // 默认卡 = 「自定义模板」入口（点击打开添加自定义模板表单）
    const defaultCard = grid.querySelector('.template-card[data-template="默认"]');
    if (defaultCard) {
      defaultCard.addEventListener("click", () => {
        if (!AUTH.loggedIn) {
          showPaywall();
          return;
        }
        // 2026-08-18：免费用户也开放（权益用尽 → 生成时 LK 单次付费引导）
        toggleCustomForm(true);
      });
    }
    // 保留默认卡，追加模板卡（自动发现 input/ 子目录）
    const templates = data.templates || [];
    const current = data.current || "";
    // 预加载全部模板视频（说话+待机）→ 切换模板时浏览器缓存命中，秒开
    preloadTemplateVideos(templates);
    for (const tpl of templates) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "template-card";
      btn.dataset.template = tpl.name;
      if (tpl.name === current) btn.classList.add("active");
      const b = document.createElement("b");
      b.textContent = tpl.name;
      const small = document.createElement("small");
      small.textContent = tpl.ready ? "说话 + 待机" : "素材不完整";
      btn.append(b, small);
      if (!tpl.ready) btn.classList.add("disabled");
      btn.addEventListener("click", () => switchTemplate(tpl.name));
      grid.append(btn);
    }
  } catch (error) {
    console.error("[template] 加载失败:", error);
  }
}

/* ── 账号 / 会员（P4）──────────────────────────── */
const AUTH = {
  loggedIn: false,
  subjectId: "",
  username: "",
  entitlements: null,
  customTemplates: [],
};

async function initAuth() {
  try {
    const resp = await fetch("/api/auth/status");
    const data = await resp.json();
    if (data.logged_in) {
      AUTH.loggedIn = true;
      AUTH.subjectId = data.subject_id || "";
      AUTH.username = data.username || "";
      renderAuthUI();
      await refreshEntitlements();
      await loadCustomTemplates();
    } else {
      renderAuthUI();
      renderCustomTemplates();
    }
  } catch (error) {
    console.error("[auth] 初始化失败:", error);
    renderAuthUI();
  }
}

function renderAuthUI() {
  const el = elements;
  if (AUTH.loggedIn) {
    el.accountLoggedOut?.classList.add("hidden");
    el.accountLoggedIn?.classList.remove("hidden");
    el.accountStatus.textContent = "已登录";
    if (el.accountSubject) el.accountSubject.textContent = AUTH.username || AUTH.subjectId;
  } else {
    el.accountLoggedOut?.classList.remove("hidden");
    el.accountLoggedIn?.classList.add("hidden");
    el.accountStatus.textContent = "未登录";
  }
}

async function doLogin() {
  // 年龄确认（App Store 合规 4.7.5）：AI 生成内容仅面向成年用户，首次登录须确认
  if (!localStorage.getItem("bwm_age_confirmed")) {
    const ageOk = await confirmDialog(
      `年龄确认：本应用包含 AI 生成内容，仅面向年满 18 周岁的用户。\n\n请确认您已满 18 周岁后再登录。`
    );
    if (!ageOk) {
      showToast("未确认年龄，无法登录", 3000);
      return;
    }
    localStorage.setItem("bwm_age_confirmed", "1");
  }
  const phone = elements.loginPhone?.value.trim();
  const password = elements.loginPassword?.value;
  if (!phone || !password) {
    showToast("请输入手机号和密码", 3200);
    return;
  }
  elements.loginButton.disabled = true;
  elements.loginButton.textContent = "登录中…";
  try {
    const resp = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: phone, password }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.detail || "登录失败");
    AUTH.loggedIn = true;
    AUTH.subjectId = data.subject_id || "";
    AUTH.username = data.username || phone;
    elements.loginPassword.value = "";
    renderAuthUI();
    showToast("登录成功", 2600);
    await refreshEntitlements();
    await loadCustomTemplates();
  } catch (error) {
    showToast(friendlyError(error, "登录失败"), 4200);
  } finally {
    elements.loginButton.disabled = false;
    elements.loginButton.textContent = "登 录";
  }
}

async function doLogout() {
  try {
    await fetch("/api/auth/logout", { method: "POST" });
  } catch {}
  AUTH.loggedIn = false;
  AUTH.subjectId = "";
  AUTH.username = "";
  AUTH.entitlements = null;
  AUTH.customTemplates = [];
  renderAuthUI();
  renderCustomTemplates();
  showToast("已退出登录", 2200);
}

async function refreshEntitlements() {
  if (!AUTH.loggedIn) return;
  try {
    const resp = await fetch("/api/auth/entitlements");
    if (resp.status === 401) {
      AUTH.loggedIn = false;
      renderAuthUI();
      renderCustomTemplates();
      showToast("登录已过期，请重新登录", 3200);
      return;
    }
    AUTH.entitlements = await resp.json();
  } catch (error) {
    console.error("[auth] entitlements 失败:", error);
  }
}

function isPremium() {
  const f = AUTH.entitlements?.features || {};
  return parseInt(f.custom_templates || "0", 10) > 0;
}

function customQuota() {
  const f = AUTH.entitlements?.features || {};
  return parseInt(f.custom_templates || "0", 10);
}

/* ── App Store IAP（方案 A 双轨 · 买断制）────────────────── */
async function setupIap() {
  const iap = window.bwmIAP;
  if (!iap) return; // 非 Electron 环境（浏览器开发）无 IAP
  try {
    const info = await iap.getProducts();
    if (!info.available || info.products.length === 0) return; // 非 MAS 构建
    elements.iapBox?.classList.remove("hidden");
    const p = info.products[0];
    if (p.localizedPrice && elements.iapProductInfo) {
      elements.iapProductInfo.textContent = `买断解锁 · 永久会员（${p.localizedPrice}）`;
    }
    // 监听交易结果
    iap.onTransaction(async (tx) => {
      if (!tx || !tx.ok) {
        setIapStatus("购买未完成", true);
        return;
      }
      setIapStatus("购买成功，验证中…");
      const ok = await verifyIapReceipt();
      if (ok) {
        setIapStatus("✅ 会员已解锁");
        await refreshEntitlements();
        renderAuthUI();
        renderCustomTemplates();
        setTimeout(hidePaywall, 1200);
      }
    });
  } catch (error) {
    console.error("[iap] setup 失败:", error);
  }
}

function setIapStatus(text, isError = false) {
  if (!elements.iapStatus) return;
  elements.iapStatus.textContent = text || "";
  elements.iapStatus.style.color = isError ? "#ff7b7b" : "";
}

async function verifyIapReceipt() {
  try {
    const rec = await window.bwmIAP.getReceipt();
    if (!rec || !rec.ok) {
      setIapStatus("未找到购买凭证", true);
      return false;
    }
    const resp = await fetch("/api/auth/iap-verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ receipt: rec.receipt }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.detail || "收据验证失败");
    setIapStatus("✅ 会员已解锁");
    return true;
  } catch (error) {
    setIapStatus(friendlyError(error, "验证失败，请稍后重试"), true);
    return false;
  }
}

function showPaywall() {
  elements.paywallMask?.classList.remove("hidden");
  setupIap();
}

function hidePaywall() {
  elements.paywallMask?.classList.add("hidden");
}

/* ── 自定义模板（P4）────────────────────────── */
async function loadCustomTemplates() {
  if (!AUTH.loggedIn) {
    renderCustomTemplates();
    return;
  }
  try {
    const resp = await fetch("/api/auth/custom-templates");
    if (resp.status === 401) {
      AUTH.loggedIn = false;
      renderAuthUI();
      renderCustomTemplates();
      return;
    }
    const data = await resp.json();
    AUTH.customTemplates = data.templates || [];
  } catch (error) {
    console.error("[auth] 自定义模板加载失败:", error);
  }
  renderCustomTemplates();
}

function renderCustomTemplates() {
  const el = elements;
  const grid = el.customTemplateGrid;
  if (!grid) return;
  grid.replaceChildren();
  const quota = customQuota();
  if (!AUTH.loggedIn) {
    el.customTemplateStatus.textContent = "登录后可用";
    el.addCustomTemplate?.classList.add("hidden");
    return;
  }
  if (!isPremium()) {
    el.customTemplateStatus.textContent = "免费用户 · 升级会员解锁";
    el.addCustomTemplate?.classList.remove("hidden");
    return;
  }
  const templates = AUTH.customTemplates || [];
  el.customTemplateStatus.textContent = `${templates.length} / ${quota} 套`;
  for (const tpl of templates) {
    const card = document.createElement("div");
    card.className = "template-card custom-tpl-card";
    const b = document.createElement("b");
    b.textContent = tpl.name;
    const small = document.createElement("small");
    small.textContent = `音色：${VOICE_DISPLAY[tpl.voice] || tpl.voice || "茉莉"}`;
    card.append(b, small);
    card.addEventListener("click", () => applyCustomTemplate(tpl));
    const del = document.createElement("button");
    del.type = "button";
    del.className = "custom-tpl-del";
    del.textContent = "✕";
    del.addEventListener("click", (ev) => {
      ev.stopPropagation();
      deleteCustomTemplate(tpl.id);
    });
    card.append(del);
    grid.append(card);
  }
  el.addCustomTemplate.classList.toggle("hidden", templates.length >= quota);
}

let wizardCurrent = 1;  // 当前向导步骤（1 人物 / 2 背景 / 3 声音）

function goWizardStep(step) {
  wizardCurrent = Math.min(3, Math.max(1, step));
  for (let i = 1; i <= 3; i++) {
    const panel = document.getElementById(`wizardPanel${i}`);
    if (panel) panel.classList.toggle("hidden", i !== wizardCurrent);
    const stepEl = document.querySelector(`.wizard-step[data-wstep="${i}"]`);
    if (stepEl) {
      stepEl.classList.toggle("active", i === wizardCurrent);
      stepEl.classList.toggle("done", i < wizardCurrent);
    }
  }
  // 按钮显隐：Step1 隐藏"上一步"，Step3 显示"开始生成"隐藏"下一步"
  elements.wizardPrev?.classList.toggle("hidden", wizardCurrent === 1);
  elements.wizardNext?.classList.toggle("hidden", wizardCurrent === 3);
  elements.customTplSubmit?.classList.toggle("hidden", wizardCurrent !== 3);
}

function toggleCustomForm(show) {
  elements.customTemplateForm?.classList.toggle("hidden", !show);
  // 性能优化：弹窗打开时暂停背景循环视频（省 CPU/GPU），关闭后恢复
  if (show) {
    elements.avatarVideo?.pause();
    elements.resultVideo?.pause();
    // 表单重置
    elements.customTplName.value = "";
    elements.customTplImage.value = "";
    elements.customTplBg.value = "";
    elements.customTplVoice.value = "茉莉";
    document.querySelectorAll(".bg-template-card").forEach((c) => c.classList.remove("active"));
    if (elements.voiceCloneArea) elements.voiceCloneArea.classList.add("hidden");
    if (elements.voiceCloneFile) elements.voiceCloneFile.value = "";
    if (elements.voiceCloneStatus) {
      elements.voiceCloneStatus.textContent = "";
      elements.voiceCloneStatus.classList.remove("busy");
    }
    if (elements.customTplPreview) {
      elements.customTplPreview.classList.add("hidden");
      elements.customTplPreview.removeAttribute("src");
    }
    elements.customTplProgress?.classList.add("hidden");
    if (elements.customTplProgressFill) elements.customTplProgressFill.style.width = "0%";
    elements.customTplSubmit.disabled = false;
    elements.customTplSubmit.textContent = "🎬 开始生成模板";
    // 回到第 1 步
    goWizardStep(1);
  } else {
    // 恢复：重新走待机/形象播放逻辑（若当前无其他渲染任务）
    if (!elements.resultVideo?.classList.contains("ready") && !elements.avatarVideo?.classList.contains("rendering")) {
      restoreIdleAvatar();
    }
  }
}

async function generateCustomTemplate() {
  const name = elements.customTplName?.value.trim();
  const imageFile = elements.customTplImage?.files?.[0];
  const bg = elements.customTplBg?.value.trim() || "";  // 留空=保持原图
  const idlePrompt = elements.customTplIdlePrompt?.value.trim() || "平视，固定机位，角色的头随节奏小幅度，微笑";
  const speakPrompt = elements.customTplSpeakPrompt?.value.trim() || "平视，固定机位，角色的头随节奏小幅度，微笑，对着镜头说话，语速 8 秒 12 个字";
  const voice = elements.customTplVoice?.value || "茉莉";
  if (!name) return showToast("请填写模板标题", 2800);
  if (!imageFile) return showToast("请上传一张人物图片", 2800);
  if (!/^image\//.test(imageFile.type || "")) return showToast("请上传 PNG/JPG/WebP 图片", 2800);

  elements.customTplSubmit.disabled = true;
  elements.customTplSubmit.textContent = "生成中…";
  elements.customTplProgress?.classList.remove("hidden");
  if (elements.customTplProgressFill) elements.customTplProgressFill.style.width = "2%";
  if (elements.customTplProgressMsg) elements.customTplProgressMsg.textContent = "任务创建中…";
  try {
    const formData = new FormData();
    formData.append("title", name);
    formData.append("image", imageFile);
    formData.append("bg_prompt", bg);
    formData.append("idle_prompt", idlePrompt);
    formData.append("speak_prompt", speakPrompt);
    formData.append("voice", voice);
    const resp = await fetch("/api/custom-template/generate", { method: "POST", body: formData });
    const data = await resp.json();
    if (!resp.ok) {
      // 权益用尽 → 单次付费引导（莱卡币抵扣）
      if (resp.status === 402 && data?.detail?.code === "quota_exhausted") {
        const pay = data.detail.pay || {};
        const price = pay.price_lk || 500;
        const balance = pay.balance_lk ?? 0;
        if (pay.affordable) {
          const ok = await confirmDialog(
            `自定义模板权益已用完。\n可用莱卡币抵扣生成一次（${price} LK，余额 ${balance} LK）。\n确定继续吗？`
          );
          if (!ok) {
            elements.customTplSubmit.disabled = false;
            elements.customTplSubmit.textContent = "🎬 开始生成模板";
            return;
          }
          // 调付费生成
          const resp2 = await fetch("/api/custom-template/pay-and-generate", { method: "POST", body: formData });
          const data2 = await resp2.json();
          if (!resp2.ok) throw new Error(data2.detail?.message || data2.detail || "付费生成失败");
          state.genTaskId = data2.task_id;
          if (elements.customTplProgressMsg) elements.customTplProgressMsg.textContent = "已扣 LK，模板生成中，约 3-5 分钟…";
          showToast(data2.message || "模板生成已开始", 3000);
          return;
        }
        // 余额不足 → 引导赚 LK 或升级会员
        await confirmDialog(
          `自定义模板权益已用完，莱卡币余额不足（${balance} LK < ${price} LK）。\n邀请好友可赚莱卡币，或升级会员解锁更多权益。`
        );
        elements.customTplSubmit.disabled = false;
        elements.customTplSubmit.textContent = "🎬 开始生成模板";
        return;
      }
      throw new Error(data.detail || "生成任务提交失败");
    }
    state.genTaskId = data.task_id;
    if (elements.customTplProgressMsg) elements.customTplProgressMsg.textContent = "模板生成中，约 3-5 分钟（可关闭面板，进度会实时推送）…";
    showToast("模板生成已开始，请留意进度", 2600);
  } catch (error) {
    elements.customTplProgress?.classList.add("hidden");
    showToast(friendlyError(error, "生成失败"), 4200);
    elements.customTplSubmit.disabled = false;
    elements.customTplSubmit.textContent = "🎬 开始生成模板";
  }
}

function updateGenProgress(taskId, step, progress, message) {
  if (state.genTaskId && state.genTaskId !== taskId) return;
  if (elements.customTplProgressFill) elements.customTplProgressFill.style.width = `${progress}%`;
  if (elements.customTplProgressMsg) elements.customTplProgressMsg.textContent = message;
  if (step === "done") {
    elements.customTplSubmit.disabled = false;
    elements.customTplSubmit.textContent = "🎬 开始生成模板";
    setTimeout(() => {
      toggleCustomForm(false);
      loadCustomTemplates();
      loadTemplates();
      showToast("模板生成完成 🎉 可在预设模板中切换", 3600);
    }, 800);
  } else if (step === "failed") {
    elements.customTplSubmit.disabled = false;
    elements.customTplSubmit.textContent = "🎬 开始生成模板";
    showToast(`生成失败：${message}`, 5000);
  }
}

async function applyCustomTemplate(tpl) {
  try {
    const resp = await fetch("/api/auth/custom-template/apply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: tpl.name,
        avatar_file: tpl.avatar_file,
        idle_file: tpl.idle_file,
        voice: tpl.voice || "茉莉",
      }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.detail || "应用失败");
    showToast(data.message || "模板已应用", 2600);
    restoreIdleAvatar();
  } catch (error) {
    showToast(friendlyError(error, "应用失败"), 4200);
  }
}

async function deleteCustomTemplate(id) {
  try {
    const resp = await fetch(`/api/auth/custom-templates/${id}`, { method: "DELETE" });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.detail || "删除失败");
    showToast("模板已删除", 2200);
    await loadCustomTemplates();
  } catch (error) {
    showToast(friendlyError(error, "删除失败"), 3200);
  }
}

async function switchTemplate(name) {
  // 防双击：切换中禁用模板按钮
  if (switchingTemplate) return;
  switchingTemplate = true;
  // 确认弹窗：让用户确认是否切换（自定义弹窗，兼容所有浏览器）
  const ok = await confirmDialog(`确定切换到「${name}」吗？\n切换后页面将刷新，当前对话会保留。`);
  if (!ok) { switchingTemplate = false; return; }
  const status = elements.templateStatus;
  if (status) status.textContent = "切换中…";
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    const resp = await fetch(`/api/template/switch?template=${encodeURIComponent(name)}`, {
      method: "POST",
      signal: controller.signal,
    });
    clearTimeout(timeout);
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.detail || "切换失败");
    // 切换成功 → 关闭设置面板 + 刷新页面（回到主界面，人格/音色/视频/历史全状态重载）
    // ⚠️ 2026-08-16 恢复原行为：之前改成"免刷新局部更新"导致切换后停留设置窗口 + 界面状态不完整
    // reload 后 initialize → loadPersona（新模板人格）→ loadHistory（新模板历史，身份隔离自动正确）
    closeSettings();
    showToast(`${data.message} · 刷新中…`);
    setTimeout(() => location.reload(), 400);
  } catch (error) {
    if (status) status.textContent = "切换失败";
    showToast(friendlyError(error, "模板切换失败"), 4200);
  } finally {
    switchingTemplate = false;
  }
}

let switchingTemplate = false;

function applyTemplateSwitch(name, data) {
  const enc = encodeURIComponent(name);
  // 1. 模板网格高亮
  document.querySelectorAll(".template-card").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.template === name);
  });
  // 2. 说话/待机视频指向模板只读 URL（内容与 switch 复制到 INPUT_ROOT 的文件一致）
  //    预加载已把模板视频拉进浏览器缓存 → 切换秒开，无需重新下载
  state.avatar = { name, url: `/media/template/${enc}/heygem`, kind: "video" };
  state.idleVideo = { name, url: `/media/template/${enc}/idle` };
  if (data.voice) state.voice = data.voice;
  // ⚠️ 2026-08-16 修复（独立审查发现）: 免刷新切换必须同步身份索引 state.personaTemplate
  // → saveHistory/loadHistory 按新模板读写，避免"前后端身份分裂、对话写错桶"
  const prevTemplate = state.personaTemplate;
  state.personaTemplate = name;
  if (prevTemplate !== name) {
    // 按新模板重载该模板的历史（身份一致性索引：记忆随身份实例切换）
    const saved = localStorage.getItem(historyKeyForTemplate(name));
    if (saved) {
      try {
        state.history = JSON.parse(saved);
        if (!Array.isArray(state.history)) state.history = [];
      } catch {
        state.history = [];
      }
    } else {
      state.history = [];
    }
    renderHistory();
    // 回灌新模板历史给语音链路（若已连接）
    if (state.socket?.readyState === WebSocket.OPEN) replayHistory();
  }
  restoreIdleAvatar();
}

// 预加载全部模板视频（说话 + 待机），让切换模板时浏览器缓存命中
function preloadTemplateVideos(templates) {
  for (const tpl of templates) {
    if (!tpl.ready) continue;
    const enc = encodeURIComponent(tpl.name);
    ["idle", "heygem"].forEach((kind) => {
      const v = document.createElement("video");
      v.preload = "auto";
      v.muted = true;
      v.src = `/media/template/${enc}/${kind}`;
    });
  }
}

function replayHistory() {
  const hist = state.history || [];
  if (!hist.length) return;
  // 只回灌最近 15 轮（30 条 user/assistant 消息），防上下文超限
  const recent = hist.slice(-30);
  const items = recent.map((h) => ({
    role: h.role === "assistant" ? "assistant" : "user",
    text: String(h.text || "").slice(0, 500),
  }));
  if (!items.length) return;
  console.log("[voice] 回灌历史:", items.length, "条");
  sendSocket({ type: "history.replay", items });
}

function isCurrentResponseEvent(event) {
  if (!state.responseOpen) return false;
  const responseId = responseIdFromEvent(event);
  return !state.activeResponseId || !responseId || responseId === state.activeResponseId;
}

function ensureResponseOpen(event) {
  const responseId = responseIdFromEvent(event);
  if (
    state.responseOpen &&
    (!state.activeResponseId || !responseId || responseId === state.activeResponseId)
  ) {
    return;
  }

  setBusy(true);
  state.activeResponseId = responseId || null;
  state.responseEventIds.clear();
  state.responseOpen = true;
  state.responseParts = [];
  state.responseRawText = "";
  state.responseText = "";
  state.latestResultUrl = null;
  audioPlayer.stop();
  elements.replayButton.classList.add("hidden");
  beginAssistantTurn();
}

async function handleRealtimeEvent(event) {
  console.log("[ws-event]", event && event.type);
  const type = event.type || "";

  if (type === "session.created") {
    setPresence("在线", "listen");
    // 重启后回灌本地历史：让 AI 记得之前聊过什么（不触发回复）
    setTimeout(replayHistory, 300);
    return;
  }

  if (type === "system.prompt.changed") {
    showToast("人设已保存，下一轮对话立即生效。");
    return;
  }

  if (type === "quota.exhausted") {
    openPurchaseGuide();
    return;
  }

  // ⚠️ 2026-08-19：服务端权威扣次后推送剩余额度（原前端手动 consume 已移除）
  if (type === "quota.updated" && msg && typeof msg.remaining === "number") {
    state.quota = msg;
    updateQuotaUI();
    return;
  }

  if (type === "conversation.item.input_audio_transcription.completed") {
    clearVoiceResultTimeout();
    const transcript = event.transcript?.trim();
    if (transcript) {
      expandDialogue();
      addHistory("user", transcript);
      setTurnLabel(`你刚刚说：“${transcript}”`, true);
      setPresence("正在回应", "think");
    } else {
      setPresence("在线", "listen");
      showToast("没有听清，再按住说一次。", 4200);
    }
    return;
  }

  if (type === "response.created") {
    clearVoiceResultTimeout();
    ensureResponseOpen(event);
    setPresence("正在回应", "think");
    return;
  }

  if (type === "response.output_audio.delta" || type === "response.audio.delta") {
    ensureResponseOpen(event);
    setPresence("正在说话", "voice");
    // 本地 qwen3 TTS 回退路径：把流式 PCM 喂给播放器，否则 mac 上完全没声音
    if (event.delta) audioPlayer.enqueue(event.delta);
    return;
  }

  if (
    type === "response.output_audio_transcript.done" ||
    type === "response.audio_transcript.done" ||
    type === "response.output_text.done" ||
    type === "response.text.done"
  ) {
    ensureResponseOpen(event);
    if (!isCurrentResponseEvent(event)) return;
    const eventId = String(event.event_id || "").trim();
    if (eventId && state.responseEventIds.has(eventId)) return;
    if (eventId) state.responseEventIds.add(eventId);
    const part = cleanAssistantText(event.transcript ?? event.text ?? "");
    if (!part) return;
    state.responseParts.push(part);
    state.responseRawText = state.responseParts.join(" ");
    state.responseText = cleanAssistantText(state.responseRawText);
    // Mac+小米整段 MP3 链路没有 lipsync.audio.segment 流，
    // 文字直接在回复气泡里显示（segment 流场景重复 set 幂等，无副作用）
    setAssistantText(state.responseText, false);
    return;
  }

  if (type === "response.done") {
    if (!isCurrentResponseEvent(event)) return;
    if (state.responseText) addHistory("assistant", state.responseText);
    state.responseOpen = false;
    setPresence("等待口型", "lipsync");
    settleDialogue();
    return;
  }

  if (type === "lipsync.queued" || type === "heygem.queued") {
    setPresence("口型排队", "lipsync");
    elements.stageFrame.classList.add("is-rendering");
    elements.avatarVideo.classList.add("rendering");
    elements.avatarImage.classList.add("rendering");
    return;
  }

  if (
    type === "lipsync.started" ||
    type === "lipsync.progress" ||
    type === "heygem.started" ||
    type === "heygem.progress"
  ) {
    setPresence("正在生成口型", "lipsync");
    return;
  }

  if (type === "lipsync.done" || type === "heygem.done") {
    state.latestResultUrl = `${event.url}?v=${Date.now()}`;
    elements.stageFrame.classList.remove("is-rendering");
    elements.avatarVideo.classList.remove("rendering");
    elements.avatarImage.classList.remove("rendering");
    elements.replayButton.classList.remove("hidden");
    setPresence("回放就绪", "listen");
    setBusy(false);
    refreshStatus();
    await playRenderedVideo();
    return;
  }

  if (type === "lipsync.audio") {
    // 无角色视频时的纯音频兜底：播完即恢复待机
    if (event.format === "mp3" && event.data) {
      try {
        const duration = await audioPlayer.playMp3(event.data);
        window.setTimeout(() => restoreIdleAvatar(), (duration + 0.25) * 1000);
      } catch {
        restoreIdleAvatar();
      }
    } else {
      restoreIdleAvatar();
    }
    return;
  }

  if (type === "lipsync.audio.segment") {
    if (event.format === "mp3" && event.data) {
      playMp3Segment(event.data, event.text || "");
    }
    return;
  }

  if (type === "lipsync.audio.end") {
    endMp3Stream(event.total || 0);
    return;
  }

  if (type === "lipsync.pretend") {
    console.log("[event] lipsync.pretend url=", event.url, "[diag] hasMp3=", Boolean(event.audio?.data), "hasText=", Boolean(event.text));
    // 整段 MP3 携带回复文字：声音开始播时同步显示到气泡（双保险，
    // 即使 output_text.done 事件丢失文字也能显示）
    if (event.text) {
      const reply = cleanAssistantText(event.text);
      if (reply) {
        state.responseParts = [reply];
        state.responseRawText = reply;
        state.responseText = reply;
        setAssistantText(reply, false);
      }
    }
    // 同步强制显示说话视频（绕过 playPretendVideo 异步链路，
    // 修复：源视频从未被加载/ui.log 无 heygem 请求 的长期 bug）
    if (event.url) {
      const video = elements.resultVideo;
      const target = `${event.url}?v=${Date.now()}`;
      if (video.getAttribute("src") !== target) {
        video.pause();
        video.src = target;
        video.loop = true;
        video.muted = true;
        video.classList.add("ready");
        elements.avatarVideo.classList.remove("ready");
        video.load();
      }
      video.play().catch(() => {});
    }
    state.latestResultUrl = event.url;
    elements.stageFrame.classList.remove("is-rendering");
    elements.avatarVideo.classList.remove("rendering");
    elements.avatarImage.classList.remove("rendering");
    elements.replayButton.classList.add("hidden");
    setPresence("正在说话", "voice");
    setBusy(false);
    refreshStatus();
    const hasMp3 = Boolean(event.audio && event.audio.format === "mp3" && event.audio.data);
    // 小米模式：音频走 lipsync.audio.segment 流（边收边播），视频不轮询 PCM；
    // 本地 qwen3 回退：轮询 PCM cursor 恢复 idle。
    const voiceProvider = state.config?.services?.voice?.provider;
    const expectPcm = voiceProvider === "xiaomi" ? false : !hasMp3;
    // 播放请求登记必须在异步调用前完成：音频结束(maybeRestoreIdleAfterMp3)
    // 依赖 mp3PretendRequest 与 state.playbackRequest 匹配才能恢复 idle
    const pr = ++state.playbackRequest;
    mp3PretendRequest = pr;
    await playPretendVideo(event.url, expectPcm, pr);
    if (hasMp3) {
      // 兼容旧服务端单段模式：播完按 duration 恢复 idle
      console.log("[diag] pretend → playMp3, playbackRequest=", state.playbackRequest, "mp3PretendRequest=", mp3PretendRequest);
      try {
        const duration = await audioPlayer.playMp3(event.audio.data);
        console.log("[diag] playMp3 成功 duration=", duration.toFixed(2), "s，调度恢复待机");
        window.setTimeout(() => {
          if (state.playbackRequest === pr) restoreIdleAvatar();
        }, (duration + 0.25) * 1000);
      } catch (err) {
        console.error("[diag] playMp3 抛异常，立即恢复待机", err);
        restoreIdleAvatar();
      }
    } else {
      console.log("[diag] hasMp3=false，不播语音");
    }
    return;
  }

  if (type === "lipsync.skipped" || type === "heygem.skipped") {
    elements.stageFrame.classList.remove("is-rendering");
    elements.avatarVideo.classList.remove("rendering");
    elements.avatarImage.classList.remove("rendering");
    setPresence("在线", "listen");
    setBusy(false);
    restoreIdleAvatar();
    showToast(event.reason || "本轮没有生成口型。");
    return;
  }

  if (type === "lipsync.error" || type === "heygem.error") {
    elements.stageFrame.classList.remove("is-rendering");
    elements.avatarVideo.classList.remove("rendering");
    elements.avatarImage.classList.remove("rendering");
    setPresence("口型失败", "listen");
    setBusy(false);
    showToast(`口型生成失败：${event.message}`, 5200);
    return;
  }

  if (type === "template_gen.progress") {
    updateGenProgress(event.task_id, event.step, event.progress, event.message);
    return;
  }

  if (type === "gateway.error" || type === "error") {
    clearVoiceResultTimeout();
    const error = event.error?.message || event.message || "服务发生错误。";
    showToast(error, 5200);
  }
}

async function playRenderedVideo() {
  if (!state.latestResultUrl) return;
  const request = ++state.playbackRequest;
  const video = elements.resultVideo;
  audioPlayer.stop();
  video.pause();
  video.classList.remove("ready");
  if (video.getAttribute("src") !== state.latestResultUrl) {
    video.src = state.latestResultUrl;
    video.load();
  } else {
    video.currentTime = 0;
  }
  try {
    if (video.readyState < HTMLMediaElement.HAVE_FUTURE_DATA) {
      await new Promise((resolve, reject) => {
        const timeout = window.setTimeout(() => {
          cleanup();
          reject(new Error("视频预加载超时"));
        }, 15000);
        const cleanup = () => {
          window.clearTimeout(timeout);
          video.removeEventListener("canplay", ready);
          video.removeEventListener("error", failed);
        };
        const ready = () => {
          cleanup();
          resolve();
        };
        const failed = () => {
          cleanup();
          reject(video.error || new Error("视频加载失败"));
        };
        video.addEventListener("canplay", ready, { once: true });
        video.addEventListener("error", failed, { once: true });
        if (video.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) ready();
      });
    }
    if (request !== state.playbackRequest) return;
    await video.play();
    if (typeof video.requestVideoFrameCallback === "function") {
      await new Promise((resolve) => video.requestVideoFrameCallback(resolve));
    } else {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    if (request !== state.playbackRequest) return;
    video.classList.add("ready");
  } catch {
    if (request !== state.playbackRequest) return;
    elements.replayButton.classList.remove("hidden");
    showToast("点击“播放口型成片”开始有声回放。");
  }
}

async function playPretendVideo(url, expectPcmAudio = true, request = null) {
  if (!url) {
    restoreIdleAvatar();
    return 0;
  }
  if (request === null) request = ++state.playbackRequest;
  const video = elements.resultVideo;

  video.pause();
  video.classList.remove("ready");
  const target = `${url}?v=${Date.now()}`;
  if (video.getAttribute("src") !== target) {
    video.src = target;
    video.load();
  } else {
    video.currentTime = 0;
  }
  video.loop = true;
  video.muted = true;

  try {
    if (video.readyState < HTMLMediaElement.HAVE_FUTURE_DATA) {
      await new Promise((resolve, reject) => {
        const timeout = window.setTimeout(() => {
          cleanup();
          reject(new Error("回复视频预加载超时"));
        }, 10000);
        const cleanup = () => {
          window.clearTimeout(timeout);
          video.removeEventListener("canplay", ready);
          video.removeEventListener("error", failed);
        };
        const ready = () => {
          cleanup();
          resolve();
        };
        const failed = () => {
          cleanup();
          reject(video.error || new Error("回复视频加载失败"));
        };
        video.addEventListener("canplay", ready, { once: true });
        video.addEventListener("error", failed, { once: true });
        if (video.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) ready();
      });
    }
    if (request !== state.playbackRequest) return;
    await video.play();
    if (request !== state.playbackRequest) return;
    video.classList.add("ready");

    // 仅当走本地 qwen3 PCM 回退时才轮询 cursor 恢复 idle；
    // 小米 MP3 模式由 lipsync.pretend 处理器按音频时长调度恢复。
    if (expectPcmAudio) {
      const waitForAudioEnd = () => {
        const now = audioPlayer.context ? audioPlayer.context.currentTime : 0;
        const remaining = audioPlayer.cursor - now;
        if (remaining <= 0.1 || audioPlayer.sources.size === 0) {
          restoreIdleAvatar();
        } else {
          window.setTimeout(waitForAudioEnd, 100);
        }
      };
      window.setTimeout(waitForAudioEnd, 100);
    }
  } catch {
    if (request !== state.playbackRequest) return;
    showToast("回复视频播放失败");
    restoreIdleAvatar();
  }
  return request;
}

function textToPcm16(floatSamples, inputRate, outputRate = 16000) {
  if (inputRate === outputRate) {
    return Int16Array.from(floatSamples, (sample) =>
      Math.max(-32768, Math.min(32767, Math.round(sample * 32767))),
    );
  }
  const ratio = inputRate / outputRate;
  const outputLength = Math.round(floatSamples.length / ratio);
  const output = new Int16Array(outputLength);
  let outputIndex = 0;
  let inputIndex = 0;

  while (outputIndex < outputLength) {
    const nextInputIndex = Math.round((outputIndex + 1) * ratio);
    let sum = 0;
    let count = 0;
    for (let index = inputIndex; index < nextInputIndex && index < floatSamples.length; index += 1) {
      sum += floatSamples[index];
      count += 1;
    }
    const sample = count ? sum / count : 0;
    output[outputIndex] = Math.max(-32768, Math.min(32767, Math.round(sample * 32767)));
    outputIndex += 1;
    inputIndex = nextInputIndex;
  }
  return output;
}

function pcmToBase64(pcm) {
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

async function startRecording() {
  if (
    !state.recordingRequested ||
    state.recording ||
    state.recordingStarting ||
    state.stoppingRecording
  ) {
    // 兜底：若录音状态残留（异常中断/多标签页被挤导致未复位），
    // 本次按下强制清理后重新开始，避免"永远录不进去"
    if (state.recordingRequested && !state.recording && !state.recordingStarting && state.stoppingRecording) {
      state.stoppingRecording = false;
    }
    if (state.recordingRequested && state.recordingStarting) {
      state.recordingStarting = false;
    }
    if (state.recordingRequested && state.recording) {
      try { state.microphoneStream?.getTracks().forEach((t) => t.stop()); } catch {}
      state.recording = false;
      try { state.inputProcessor?.disconnect(); } catch {}
      try { state.inputSource?.disconnect(); } catch {}
      try { state.inputSink?.disconnect(); } catch {}
      try { state.inputContext?.close(); } catch {}
      state.inputProcessor = null;
      state.inputSource = null;
      state.inputSink = null;
      state.microphoneStream = null;
      state.inputContext = null;
      state.stoppingRecording = false;
      console.log("[voice] 残留录音状态已清理，重新开始");
    }
    // 清理后如果仍有阻断条件（例如真在录音），保持 return
    if (state.recording || state.recordingStarting || state.stoppingRecording) return;
  }
  clearVoiceResultTimeout();
  expandDialogue();
  state.recordingStarting = true;
  try {
    await audioPlayer.activate();
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    if (!state.recordingRequested) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    const context = new AudioContext({ latencyHint: "interactive" });
    await context.resume();
    if (!state.recordingRequested) {
      stream.getTracks().forEach((track) => track.stop());
      await context.close();
      return;
    }
    const source = context.createMediaStreamSource(stream);
    const processor = context.createScriptProcessor(1024, 1, 1);
    const sink = context.createGain();
    sink.gain.value = 0;

    processor.onaudioprocess = (audioEvent) => {
      if (!state.recording || state.socket?.readyState !== WebSocket.OPEN) return;
      const input = audioEvent.inputBuffer.getChannelData(0);
      const pcm = textToPcm16(input, context.sampleRate);
      sendSocket({
        type: "input_audio_buffer.append",
        audio: pcmToBase64(pcm),
      });
    };

    state.microphoneStream = stream;
    state.inputContext = context;
    state.inputProcessor = processor;
    state.inputSource = source;
    state.inputSink = sink;
    state.recording = true;
    state.stoppingRecording = false;

    source.connect(processor);
    processor.connect(sink);
    sink.connect(context.destination);
    elements.voiceButton.classList.add("recording");
    elements.voiceOrbWrap.classList.add("recording");
    elements.voiceLabel.textContent = "松开结束录音";
    if (elements.voiceHint) elements.voiceHint.textContent = "松开结束";
    elements.voiceButton.setAttribute("aria-label", "正在录音，松开结束");
    elements.voiceButton.setAttribute("aria-pressed", "true");
    elements.voiceButton.title = "松开结束";
    setPresence("正在倾听", "listen");
    setTurnLabel("我在听，慢慢说。");
  } catch (error) {
    state.recordingRequested = false;
    elements.voiceOrbWrap.classList.remove("holding");
    elements.composer.classList.add("attention");
    showToast("没有可用麦克风，已保留键盘输入。");
    elements.messageInput.focus();
  } finally {
    state.recordingStarting = false;
  }
}

async function stopRecording() {
  state.recordingRequested = false;
  elements.voiceOrbWrap.classList.remove("holding");
  if (!state.recording || state.stoppingRecording) return;
  state.stoppingRecording = true;
  elements.voiceLabel.textContent = "正在收尾……";
  try {
    // Keep the graph alive for a few processing quanta so the samples spoken
    // immediately before release are delivered before disconnecting.
    await new Promise((resolve) => setTimeout(resolve, 90));
    state.recording = false;
    elements.voiceButton.classList.remove("recording");
    elements.voiceOrbWrap.classList.remove("recording");
    elements.voiceLabel.textContent = "按住说话";
    if (elements.voiceHint) elements.voiceHint.textContent = "点击按着语音输入";
    elements.voiceButton.setAttribute("aria-label", "按住说话");
    elements.voiceButton.setAttribute("aria-pressed", "false");
    elements.voiceButton.title = "按住说话";

    // 清理资源（各自 try/catch：多标签页被挤/context 已关闭时 close() 会抛，
    // 不能因此卡死 stoppingRecording 状态）
    try { state.inputProcessor?.disconnect(); } catch {}
    try { state.inputSource?.disconnect(); } catch {}
    try { state.inputSink?.disconnect(); } catch {}
    try { state.microphoneStream?.getTracks().forEach((track) => track.stop()); } catch {}
    try { await state.inputContext?.close(); } catch {}

    state.inputProcessor = null;
    state.inputSource = null;
    state.inputSink = null;
    state.microphoneStream = null;
    state.inputContext = null;
  } finally {
    // 关键：无论上面哪一步抛异常，都复位停止状态，下次才能重新录音
    state.stoppingRecording = false;
  }

  setPresence("正在听懂你", "think");
  // Keep a deliberate 0.5s tail after the user's last sample so the recognizer
  // does not clip the final syllable. The remaining silence flushes server VAD.
  const totalSilenceMs = RECORDING_TAIL_PADDING_MS + SERVER_VAD_FLUSH_MS;
  const silence = pcmToBase64(new Int16Array(Math.round((16000 * totalSilenceMs) / 1000)));
  const appended = sendSocket({ type: "input_audio_buffer.append", audio: silence });
  const committed = appended && sendSocket({ type: "input_audio_buffer.commit" });
  if (committed) {
    armVoiceResultTimeout();
  }
}

function submitText() {
  const text = elements.messageInput.value.trim();
  if (!text) return;
  clearVoiceResultTimeout();
  expandDialogue();
  audioPlayer.activate().catch(() => {});
  if (!sendSocket({ type: "user.text", text })) return;
  // ⚠️ 2026-08-19：扣次已移到服务端（WS 收到 user.text 时权威扣除，防绕过）
  // 前端改为监听 quota.updated 事件刷新剩余；此处不再主动调 /api/quota/consume（避免双扣）
  addHistory("user", text);
  setTurnLabel(`你说：“${text}”`, true);
  elements.messageInput.value = "";
  elements.messageInput.style.height = "auto";
  setPresence("正在回应", "think");
}

function uploadAvatar(file) {
  const imageMode = state.avatarDriver === "image";
  const validMime = imageMode
    ? ["image/jpeg", "image/png", "image/webp"].includes(file.type)
    : ["video/mp4", "video/quicktime", "video/webm"].includes(file.type);
  const validSuffix = imageMode
    ? /\.(jpe?g|png|webp)$/i.test(file.name)
    : /\.(mp4|mov|m4v|webm)$/i.test(file.name);
  if (!validMime && !validSuffix) {
    showToast(
      imageMode
        ? "图片驱动请选择 JPG、PNG 或 WebP 图片。"
        : "视频驱动请选择 MP4、MOV、M4V 或 WebM 视频。",
    );
    return;
  }
  if (imageMode && file.size > 20 * 1024 * 1024) {
    showToast("角色图片不能超过 20MB。");
    return;
  }

  const previewUrl = URL.createObjectURL(file);
  if (imageMode) {
    elements.avatarVideo.pause();
    elements.avatarVideo.classList.remove("ready");
    elements.avatarImage.src = previewUrl;
    elements.avatarImage.classList.add("ready");
    elements.avatarPlaceholder.classList.add("hidden");
  } else {
    elements.avatarImage.classList.remove("ready");
    elements.avatarVideo.src = previewUrl;
    freezeAvatarOnFirstFrame(previewUrl);
  }
  elements.avatarName.textContent = file.name;
  elements.uploadProgress.style.width = "2%";

  const request = new XMLHttpRequest();
  request.open(
    "POST",
    `/api/avatar?driver=${encodeURIComponent(state.avatarDriver)}&filename=${encodeURIComponent(file.name)}`,
  );
  request.upload.addEventListener("progress", (event) => {
    if (event.lengthComputable) {
      elements.uploadProgress.style.width = `${Math.round((event.loaded / event.total) * 100)}%`;
    }
  });
  request.addEventListener("load", () => {
    URL.revokeObjectURL(previewUrl);
    elements.uploadProgress.style.width = "100%";
    setTimeout(() => (elements.uploadProgress.style.width = "0%"), 600);
    if (request.status >= 200 && request.status < 300) {
      const payload = JSON.parse(request.responseText);
      state.avatarDriver = payload.driver;
      elements.avatarDriver.value = payload.driver;
      updateAvatarDriverMode();
      setAvatar(payload.avatar);
      closeSettings();
      showToast(
        payload.driver === "image"
          ? "图片驱动的角色图片已更新，下一轮会使用它生成口型。"
          : "视频驱动的角色视频已更新，下一轮会使用它生成口型。",
      );
    } else {
      let detail = request.statusText;
      try {
        detail = JSON.parse(request.responseText).detail || detail;
      } catch {
        // Keep the HTTP status text when the response is not JSON.
      }
      showToast(`上传失败：${detail}`);
    }
  });
  request.addEventListener("error", () => showToast("素材上传失败，请检查本地服务。"));
  request.send(file);
}

function uploadIdleVideo(file) {
  const validMime = ["video/mp4", "video/quicktime", "video/webm"].includes(file.type);
  const validSuffix = /\.(mp4|mov|m4v|webm)$/i.test(file.name);
  if (!validMime && !validSuffix) {
    showToast("待机视频请选择 MP4、MOV、M4V 或 WebM 文件。");
    return;
  }
  if (file.size > 2 * 1024 * 1024 * 1024) {
    showToast("待机视频不能超过 2GB。");
    return;
  }

  const previous = state.idleVideo;
  const previewUrl = URL.createObjectURL(file);
  elements.idleVideoName.textContent = file.name;
  elements.avatarVideo.src = previewUrl;
  playIdleVideo(previewUrl);
  elements.idleUploadProgress.style.width = "2%";

  const request = new XMLHttpRequest();
  request.open(
    "POST",
    `/api/idle-video?filename=${encodeURIComponent(file.name)}`,
  );
  request.upload.addEventListener("progress", (event) => {
    if (event.lengthComputable) {
      elements.idleUploadProgress.style.width =
        `${Math.round((event.loaded / event.total) * 100)}%`;
    }
  });
  request.addEventListener("load", () => {
    elements.idleUploadProgress.style.width = "100%";
    setTimeout(() => (elements.idleUploadProgress.style.width = "0%"), 600);
    if (request.status >= 200 && request.status < 300) {
      const payload = JSON.parse(request.responseText);
      state.idleVideo = payload.idleVideo;
      restoreIdleAvatar();
      closeSettings();
      showToast("待机视频已更新，空闲时会自动循环播放。");
    } else {
      state.idleVideo = previous;
      restoreIdleAvatar();
      let detail = request.statusText;
      try {
        detail = JSON.parse(request.responseText).detail || detail;
      } catch {
        // Keep the HTTP status text when the response is not JSON.
      }
      showToast(`待机视频上传失败：${detail}`);
    }
    URL.revokeObjectURL(previewUrl);
  });
  request.addEventListener("error", () => {
    state.idleVideo = previous;
    restoreIdleAvatar();
    elements.idleUploadProgress.style.width = "0%";
    URL.revokeObjectURL(previewUrl);
    showToast("待机视频上传失败，请检查本地服务。");
  });
  request.send(file);
}

async function refreshStatus() {
  try {
    const response = await fetch("/api/status");
    const services = await response.json();
    if (state.config) state.config.services = services;
    updateServices(services);
  } catch {
    showToast("无法读取本地服务状态。");
  }
}

async function fetchQuota() {
  try {
    const resp = await fetch("/api/quota");
    state.quota = await resp.json();
    updateQuotaUI();
  } catch {
    /* 本地配额不可读时保持占位 */
  }
}

function updateQuotaUI() {
  const el = elements.quotaBadge;
  if (!el || !state.quota) return;
  el.classList.remove("unlimited", "exhausted");
  if (state.quota.unlimited) {
    el.textContent = "∞ 无限";
    el.classList.add("unlimited");
  } else {
    el.textContent = `剩余 ${state.quota.remaining} 次`;
    if (state.quota.remaining <= 0) el.classList.add("exhausted");
  }
}

function openPurchaseGuide() {
  // 对话次数用尽 → 引导解锁（桌面版跳会员页；MAS 版可接 IAP）
  showToast("对话次数已用完：解锁终身会员享无限对话。", 6000);
  try {
    if (window.bwmIAP && typeof bwmIAP.getProducts === "function") {
      window.open("https://laikaton-tech.com/roadshow", "_blank");
    } else {
      window.open("https://laikaton-tech.com/roadshow", "_blank");
    }
  } catch {
    /* 打开失败静默 */
  }
}

async function initialize() {
  elements.voiceButton.disabled = true;
  try {
    const response = await fetch("/api/config");
    const config = await response.json();
    state.config = config;
    state.avatarDriver = config.lipsync?.driver === "image" ? "image" : "video";
    elements.avatarDriver.value = state.avatarDriver;
    updateAvatarDriverMode();
    state.avatar = config.avatar || null;
    state.idleVideo = config.idleVideo || null;
    loadLlmProvider(config.llmProvider || null);
    if (elements.characterName) elements.characterName.textContent = config.character.name;
    fetchQuota();
    loadTemplates();
    loadVoices();
    await loadPersona();
    // 身份一致性索引：先拿到当前模板名，再加载该模板的独立聊天记录（专利权利要求3：记忆随身份实例）
    state.history = loadHistory();
    renderHistory();
    initAuth();
    restoreIdleAvatar();
  } catch (error) {
    showToast(friendlyError(error, "界面配置加载失败"));
    restoreIdleAvatar();
  }
  connectSocket();
  setInterval(refreshStatus, 15000);
}

elements.composer.addEventListener("submit", (event) => {
  event.preventDefault();
  submitText();
});

elements.messageInput.addEventListener("input", () => {
  elements.messageInput.style.height = "auto";
  elements.messageInput.style.height = `${Math.min(elements.messageInput.scrollHeight, 110)}px`;
  if (elements.messageInput.value.trim()) {
    expandDialogue();
  } else if (!state.responseOpen) {
    settleDialogue(420);
  }
});

elements.messageInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    submitText();
  }
});

/* ── 账号 / 会员事件绑定（P4）── */
elements.loginButton?.addEventListener("click", doLogin);
elements.logoutButton?.addEventListener("click", doLogout);
elements.addCustomTemplate?.addEventListener("click", () => {
  if (!AUTH.loggedIn) {
    showPaywall();
    return;
  }
  // 2026-08-18：免费用户也开放（权益用尽 → 生成时 LK 单次付费引导）
  toggleCustomForm(true);
});

// ── 背景模板预设卡：点选填充背景描述（可再编辑）──
elements.bgTemplateGrid?.addEventListener("click", (event) => {
  const card = event.target.closest(".bg-template-card");
  if (!card) return;
  document.querySelectorAll(".bg-template-card").forEach((c) => c.classList.remove("active"));
  card.classList.add("active");
  elements.customTplBg.value = card.dataset.prompt || "";
  if (elements.customTplBg) elements.customTplBg.focus();
});

// ── 照片预览：选图立即显示缩略图 ──
elements.customTplImage?.addEventListener("change", () => {
  const file = elements.customTplImage.files?.[0];
  if (!file || !elements.customTplPreview) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    elements.customTplPreview.src = e.target.result;
    elements.customTplPreview.classList.remove("hidden");
  };
  reader.readAsDataURL(file);
});

// ── 音色克隆：选「我的声音」显示克隆区 ──
elements.customTplVoice?.addEventListener("change", () => {
  const isClone = elements.customTplVoice.value === "__clone__";
  if (elements.voiceCloneArea) elements.voiceCloneArea.classList.toggle("hidden", !isClone);
});

// ── 克隆我的声音：上传音频 → 后端克隆 → 返回新音色ID ──
elements.voiceCloneBtn?.addEventListener("click", async () => {
  const file = elements.voiceCloneFile?.files?.[0];
  if (!file) {
    if (elements.voiceCloneStatus) elements.voiceCloneStatus.textContent = "请先选择音频文件";
    return;
  }
  if (elements.voiceCloneStatus) {
    elements.voiceCloneStatus.textContent = "克隆中（约 10-30 秒）…";
    elements.voiceCloneStatus.classList.add("busy");
  }
  const fd = new FormData();
  fd.append("audio", file);
  try {
    const resp = await fetch("/api/voice/clone", { method: "POST", body: fd });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.detail || "克隆失败");
    // 克隆成功：把新音色加入选择器并选中
    const opt = document.createElement("option");
    opt.value = data.voice_id;
    opt.textContent = `🎙️ 我的声音（${data.voice_id}）`;
    elements.customTplVoice.appendChild(opt);
    elements.customTplVoice.value = data.voice_id;
    elements.voiceCloneArea.classList.add("hidden");
    if (elements.voiceCloneStatus) {
      elements.voiceCloneStatus.textContent = "✅ 声音克隆成功！";
      elements.voiceCloneStatus.classList.remove("busy");
    }
    showToast("声音克隆成功，数字人将用你的声音说话 🎙️", 3000);
  } catch (error) {
    if (elements.voiceCloneStatus) {
      elements.voiceCloneStatus.textContent = `克隆失败: ${friendlyError(error, "声音克隆失败")}`;
      elements.voiceCloneStatus.classList.remove("busy");
    }
  }
});

elements.customTplSubmit?.addEventListener("click", generateCustomTemplate);
elements.personaSaveBtn?.addEventListener("click", savePersona);
elements.customTplCancel?.addEventListener("click", () => toggleCustomForm(false));
elements.customTplModalClose?.addEventListener("click", () => toggleCustomForm(false));
elements.customTemplateForm?.addEventListener("click", (event) => {
  // 点遮罩空白处关闭（点弹窗内部不关）
  if (event.target === elements.customTemplateForm) toggleCustomForm(false);
});

// ── 向导：上一步 / 下一步 ──
elements.wizardPrev?.addEventListener("click", () => goWizardStep(wizardCurrent - 1));
elements.wizardNext?.addEventListener("click", () => {
  // Step1 校验：标题 + 图片必填
  if (wizardCurrent === 1) {
    if (!elements.customTplName?.value.trim()) return showToast("请填写模板标题", 2800);
    if (!elements.customTplImage?.files?.[0]) return showToast("请上传一张人物图片", 2800);
  }
  // Step2 校验：背景不能全空
  if (wizardCurrent === 2) {
    const hasBg = elements.customTplBg?.value.trim() ||
                  document.querySelector(".bg-template-card.active") !== null;
    if (!hasBg) return showToast("请选择或填写背景描述", 2800);
  }
  goWizardStep(wizardCurrent + 1);
});
elements.paywallClose?.addEventListener("click", hidePaywall);
elements.paywallMask?.addEventListener("click", (event) => {
  if (event.target === elements.paywallMask) hidePaywall();
});
elements.iapBuyButton?.addEventListener("click", async () => {
  if (!window.bwmIAP) return;
  setIapStatus("正在连接 App Store…");
  const result = await window.bwmIAP.purchase();
  if (!result.ok && result.error) {
    setIapStatus(friendlyError({ message: result.error }, "购买失败"), true);
  }
  // 购买成功由 onTransaction 回调处理（等待系统交易确认）
});
elements.iapRestoreButton?.addEventListener("click", async () => {
  if (!window.bwmIAP) return;
  setIapStatus("正在恢复购买…");
  const res = await window.bwmIAP.restore();
  if (!res.ok) {
    setIapStatus(res.error || "未找到可恢复的购买", true);
    return;
  }
  const ok = await verifyIapReceipt();
  if (ok) {
    await refreshEntitlements();
    renderAuthUI();
    renderCustomTemplates();
    setTimeout(hidePaywall, 1200);
  }
});
elements.loginPassword?.addEventListener("keydown", (event) => {
  if (event.key === "Enter") doLogin();
});

elements.voiceButton.addEventListener("pointerdown", (event) => {
  if (elements.voiceButton.disabled || (event.pointerType === "mouse" && event.button !== 0)) {
    return;
  }
  event.preventDefault();
  state.recordingRequested = true;
  state.voicePointerId = event.pointerId;
  elements.voiceOrbWrap.classList.add("holding");
  try {
    elements.voiceButton.setPointerCapture(event.pointerId);
  } catch {
    // Pointer capture is optional; pointerup on the button still stops recording.
  }
  startRecording();
});

function endVoicePointer(event) {
  if (state.voicePointerId !== event.pointerId) return;
  event.preventDefault();
  state.voicePointerId = null;
  stopRecording();
}

elements.voiceButton.addEventListener("pointerup", endVoicePointer);
elements.voiceButton.addEventListener("pointercancel", endVoicePointer);
elements.voiceButton.addEventListener("lostpointercapture", endVoicePointer);
elements.voiceButton.addEventListener("contextmenu", (event) => event.preventDefault());
elements.voiceButton.addEventListener("keydown", (event) => {
  if (
    !event.repeat &&
    (event.key === " " || event.key === "Enter") &&
    !elements.voiceButton.disabled
  ) {
    event.preventDefault();
    state.recordingRequested = true;
    elements.voiceOrbWrap.classList.add("holding");
    startRecording();
  }
});
elements.voiceButton.addEventListener("keyup", (event) => {
  if (event.key === " " || event.key === "Enter") {
    event.preventDefault();
    stopRecording();
  }
});
window.addEventListener("blur", () => {
  if (state.recordingRequested) {
    state.voicePointerId = null;
    stopRecording();
  }
});

elements.historyToggle.addEventListener("click", () => elements.history.classList.toggle("open"));
elements.settingsButton.addEventListener("click", openSettings);
elements.settingsClose.addEventListener("click", closeSettings);
elements.settingsScrim.addEventListener("click", closeSettings);
elements.refreshStatus.addEventListener("click", refreshStatus);
elements.avatarDriver.addEventListener("change", () => {
  updateAvatarDriverMode();
  saveAvatarDriver();
});
elements.llmProvider.addEventListener("change", updateLlmProviderMode);
elements.llmModel.addEventListener("input", updateLlmProviderMode);
elements.saveLlmProvider.addEventListener("click", saveLlmProvider);
elements.clearLlmApiKey.addEventListener("click", clearLlmApiKey);
elements.replayButton.addEventListener("click", playRenderedVideo);
elements.avatarInput.addEventListener("change", () => {
  const [file] = elements.avatarInput.files;
  if (file) uploadAvatar(file);
  elements.avatarInput.value = "";
});
elements.idleVideoInput.addEventListener("change", () => {
  const [file] = elements.idleVideoInput.files;
  if (file) uploadIdleVideo(file);
  elements.idleVideoInput.value = "";
});

$$("[data-open-upload]").forEach((button) => button.addEventListener("click", openSettings));

elements.resultVideo.addEventListener("ended", () => {
  elements.resultVideo.classList.remove("ready");
  setPresence("在线", "listen");
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeSettings();
});

window.addEventListener("resize", () => {
  $$(".assistant-reply", elements.assistantReplies).forEach(fitAssistantLine);
});

fitAssistantLine(elements.assistantText);
renderAuthorCredit();
initialize();

// ── 更新功能（2026-08-16：检查 → 下载 → 打开安装包）────────────
const update = {
  checking: false,
  downloading: false,
  lastResult: null,
  downloadedPath: null,
};

function updateEl(id) {
  return document.getElementById(id);
}

function fmtSize(bytes) {
  if (!bytes) return "";
  const mb = bytes / 1024 / 1024;
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}

// 打开更新弹窗
function openUpdateDialog() {
  elements.updateMask.classList.remove("hidden");
}

function closeUpdateDialog() {
  elements.updateMask.classList.add("hidden");
}

// 弹窗 UI 状态重置
function resetUpdateDialog() {
  elements.updateNotes.classList.add("hidden");
  elements.updateProgress.classList.add("hidden");
  elements.updateAction.disabled = false;
  elements.updateAction.textContent = "下载更新";
  update.downloadedPath = null;
}

// 检查更新（设置面板按钮）
async function checkForUpdateNow() {
  if (update.checking) return;
  if (!window.bwmUpdate) {
    elements.updateInfoBox.classList.remove("hidden");
    elements.updateInfoBox.innerHTML = '<span class="update-err">当前环境不支持更新检查</span>';
    return;
  }
  update.checking = true;
  elements.checkUpdateBtn.disabled = true;
  elements.checkUpdateBtn.textContent = "检查中…";
  elements.updateInfoBox.classList.remove("hidden");
  elements.updateInfoBox.innerHTML = "正在检查更新…";
  try {
    const result = await window.bwmUpdate.check();
    update.lastResult = result;
    if (!result.ok) {
      elements.updateInfoBox.innerHTML = `<span class="update-err">检查失败：${escapeHtml(result.error || "网络异常")}</span>`;
      return;
    }
    if (result.hasUpdate) {
      elements.checkUpdateBtn.classList.add("has-update");
      elements.updateStatusText.textContent = `发现 v${result.latestVersion}`;
      elements.updateInfoBox.innerHTML =
        `<span class="update-new">发现新版本 v${result.latestVersion}</span>（当前 v${result.currentVersion}）<br>` +
        `大小 ${fmtSize(result.download?.sizeBytes) || "未知"}${result.download?.url ? "" : "，暂无可下载安装包"}`;
      // 有更新 → 直接弹窗引导
      showUpdateDialog(result);
    } else {
      elements.checkUpdateBtn.classList.remove("has-update");
      elements.updateStatusText.textContent = `已是最新 v${result.currentVersion}`;
      elements.updateInfoBox.innerHTML = `<span class="update-ok">已是最新版本 v${result.currentVersion}</span>`;
      showToast("已是最新版本");
    }
  } catch (e) {
    elements.updateInfoBox.innerHTML = `<span class="update-err">检查失败：${escapeHtml(e.message || "未知错误")}</span>`;
  } finally {
    update.checking = false;
    elements.checkUpdateBtn.disabled = false;
    elements.checkUpdateBtn.textContent = "检查更新";
  }
}

// 填充并弹出更新弹窗
function showUpdateDialog(result) {
  resetUpdateDialog();
  elements.updateTitle.textContent = `发现新版本 v${result.latestVersion}`;
  elements.updateDesc.textContent = `当前版本 v${result.currentVersion} · ${fmtSize(result.download?.sizeBytes) || ""}`.trim();
  if (result.releaseNotes) {
    elements.updateNotes.classList.remove("hidden");
    elements.updateNotes.textContent = result.releaseNotes;
  }
  elements.updateAction.dataset.mode = result.download?.url ? "download" : "disabled";
  elements.updateAction.textContent = result.download?.url ? "下载更新" : "暂时没有可下载的安装包";
  if (!result.download?.url) elements.updateAction.disabled = true;
  openUpdateDialog();
}

// 开始下载
async function startUpdateDownload() {
  const result = update.lastResult;
  if (!result || !result.download?.url || update.downloading) return;
  update.downloading = true;
  elements.updateAction.disabled = true;
  elements.updateAction.textContent = "下载中…";
  elements.updateProgress.classList.remove("hidden");
  elements.updateProgressFill.style.width = "0%";
  elements.updateProgressMsg.textContent = "准备下载…";
  try {
    const dl = await window.bwmUpdate.download(result.download);
    update.downloading = false;
    if (!dl.ok) {
      elements.updateProgress.classList.add("hidden");
      elements.updateAction.disabled = false;
      elements.updateAction.textContent = "重试下载";
      showToast(`下载失败：${dl.error || "未知错误"}`);
      return;
    }
    update.downloadedPath = dl.filePath;
    elements.updateProgressFill.style.width = "100%";
    elements.updateProgressMsg.textContent = "下载完成 ✅";
    elements.updateAction.textContent = "立即更新";
    elements.updateAction.disabled = false;
    elements.updateAction.dataset.mode = "install";
  } catch (e) {
    update.downloading = false;
    elements.updateProgress.classList.add("hidden");
    elements.updateAction.disabled = false;
    elements.updateAction.textContent = "重试下载";
    showToast(`下载失败：${e.message || "未知错误"}`);
  }
}

// ⚠️ 2026-08-19 一键自动安装：关当前 App → 装新包 → 自动重启（替代原"打开安装包"手动流程）
async function installUpdatePackage() {
  if (!update.downloadedPath) return;
  try {
    elements.updateAction.disabled = true;
    elements.updateAction.textContent = "正在更新…";
    elements.updateProgressMsg.textContent = "正在自动安装，App 将自动重启…";
    const res = await window.bwmUpdate.install(update.downloadedPath);
    if (!res.ok) {
      elements.updateAction.disabled = false;
      elements.updateAction.textContent = "重新更新";
      elements.updateProgressMsg.textContent = `安装失败：${res.error || "未知错误"}`;
      showToast(`自动更新失败：${res.error || "未知错误"}`);
      return;
    }
    // 安装已接管，App 即将退出——给用户提示后关闭对话框
    closeUpdateDialog();
    showToast("正在自动更新，稍后 App 会自动重启 🚀");
  } catch (e) {
    elements.updateAction.disabled = false;
    elements.updateAction.textContent = "重新更新";
    showToast(`自动更新失败：${e.message || "未知错误"}`);
  }
}

// 事件绑定
elements.checkUpdateBtn.addEventListener("click", checkForUpdateNow);
elements.updateAction.addEventListener("click", () => {
  const mode = elements.updateAction.dataset.mode;
  if (mode === "install") installUpdatePackage();
  else if (mode === "download") startUpdateDownload();
});
elements.updateLater.addEventListener("click", closeUpdateDialog);
elements.updateClose.addEventListener("click", closeUpdateDialog);
elements.updateMask.addEventListener("click", (event) => {
  if (event.target === elements.updateMask) closeUpdateDialog();
});

// 启动静默检查（主界面加载完成后由 UI 主动查询——修复 splash 时序 bug）
// ⚠️ 2026-08-16：原实现靠 main.js whenReady 后 5s 推送 update:available，但此时窗口在 splash.html
//    无监听器 → 事件丢失 → 用户看不到更新提示。改为 UI 端延迟查询（单通道，避免双 toast）。
if (window.bwmUpdate?.check) {
  setTimeout(async () => {
    try {
      const result = await window.bwmUpdate.check();
      update.lastResult = result;
      if (result && result.ok && result.hasUpdate) {
        // 设置面板按钮高亮 + toast 轻提示（不强制弹窗）
        elements.checkUpdateBtn.classList.add("has-update");
        elements.updateStatusText.textContent = `发现 v${result.latestVersion}`;
        showToast(`发现新版本 v${result.latestVersion}，可在设置中查看`);
      }
    } catch (e) {
      // 静默失败不打扰（用户可手动点检查更新）
      console.error("[update] 静默检查失败:", e);
    }
  }, 6000); // 等主界面渲染稳定后再查（避开 splash 阶段）
}

// 下载进度（主进程推送）
if (window.bwmUpdate?.onProgress) {
  window.bwmUpdate.onProgress(({ percent }) => {
    if (!update.downloading) return;
    elements.updateProgressFill.style.width = `${percent}%`;
    elements.updateProgressMsg.textContent = `下载中… ${percent}%`;
  });
}

// 打开设置面板时刷新版本显示
const _origOpenSettings = openSettings;
openSettings = function () {
  _origOpenSettings();
  if (window.bwmUpdate?.getVersion) {
    window.bwmUpdate.getVersion().then((info) => {
      if (info?.version) {
        elements.appVersionText.textContent = info.version;
        elements.updateStatusText.textContent = `v${info.version}`;
      }
    }).catch(() => {});
  }
};
