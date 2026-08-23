// dsh-plugin-bwm-friend — host 半（P1/M1：资产描述符 + 媒体路由 + 配置持久化）
// 职责：同源 HTTP 路由（资产 inventory / 媒体流 Range / 配置读写 / bwm 服务探测）
// 纯 ESM，无需构建（lib/index.js 即源码）。
import { readFile, writeFile, mkdir, readdir, stat } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';

export const inject = ['webServer'];

const CONFIG_DIR = join(homedir(), '.dsh-bwm-friend');
const CONFIG_PATH = join(CONFIG_DIR, 'config.json');
const DEFAULT_CONFIG = {
  version: 1, // schema version（升级不炸）
  mode: 'work', // work | companion（§6 Mode 枚举）
  avatar: { theme: '电竞男友', idle: null },
  layout: { type: 'stage', chatWidth: 720 }, // stage=5.3b 默认
  power: { pauseOnBlur: true, pauseOnBattery: false },
};

// bwm 待机/说话视频资产根目录（打包路径优先，开发工程兜底）
const ASSET_ROOTS = [
  '/Users/zengtian/projects/bwm-electron/app_runtime/heygem-data/input',
  '/Users/zengtian/projects/AI-Girlfriend-OneClick-2026.07.31/app/heygem-data/input',
];

const BWM_UI_PORT = 7860;
// bwm friend 聊天页前端资源（陪伴模式 = 这个页面，外观与原版一致）
const BWM_STATIC = '/Users/zengtian/projects/bwm-electron/app_runtime/ui/static';
const tokenFor = (absPath) => Buffer.from(absPath, 'utf8').toString('base64url');

// token → 绝对路径白名单（仅 inventory 扫描过的路径可被 /media 访问，不暴露任意文件系统）
const mediaMap = new Map();

async function readConfig() {
  try {
    const parsed = JSON.parse(await readFile(CONFIG_PATH, 'utf8'));
    return { ...DEFAULT_CONFIG, ...parsed };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

async function writeConfig(cfg) {
  await mkdir(CONFIG_DIR, { recursive: true });
  await writeFile(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

// 探测 bwm friend UI 服务（7860）是否在线
function probeBwm() {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: BWM_UI_PORT, path: '/', timeout: 1500 }, (res) => {
      res.resume();
      resolve(res.statusCode >= 200 && res.statusCode < 500);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

// 资产描述符（四轮评审：asset:// 结构化契约，扩展 idle/talk/gesture/emotion/reaction）
// checksum/resolution 为 P1 占位（接入 ffprobe 后升级）
async function buildInventory() {
  const items = [];
  const seen = new Set();
  for (const root of ASSET_ROOTS) {
    let entries;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch {
      continue; // 目录不存在 → 跳过
    }
    for (const entry of entries) {
      const files = entry.isDirectory()
        ? await readdir(join(root, entry.name)).catch(() => [])
        : [entry.name];
      for (const f of files) {
        if (!/\.mp4$/i.test(f)) continue;
        const abs = entry.isDirectory() ? join(root, entry.name, f) : join(root, f);
        if (seen.has(abs)) continue;
        seen.add(abs);
        const type = /^idle-/.test(f) ? 'idle' : /^heygem-/.test(f) ? 'talk' : 'other';
        const theme = entry.isDirectory() ? entry.name : '(root)';
        const base = f.replace(/\.mp4$/i, '');
        const token = tokenFor(abs);
        mediaMap.set(token, abs);
        const st = await stat(abs).catch(() => null);
        items.push({
          id: `${type}-${base.replace(/[^a-zA-Z0-9_-]/g, '-')}`,
          type,
          theme,
          name: f,
          url: `/bwm-friend/media/${token}`,
          resolution: null, // P1 占位：ffprobe 后填 "1280x704"
          checksum: st ? `${st.size}_${st.mtimeMs}` : null, // P1 占位：文件指纹，可升级 sha256
        });
      }
    }
  }
  return items;
}

// Mira 陪伴人设（简洁、温和、be water my friend）
const MIRA_PERSONA = '你是 Mira（be water my friend）——用户的 AI 陪伴伙伴。语气温柔、亲切、简短自然，像老朋友聊天。用中文回复，通常 1-3 句，不啰嗦。';

// 读 DeepSeek key（真实 ~/.dsh/.credentials.yaml）
function readDeepseekKey() {
  try {
    const raw = readFileSync(join(homedir(), '.dsh', '.credentials.yaml'), 'utf8');
    const m = /DEEPSEEK_API_KEY:\s*['"]?([^'"\s]+)/.exec(raw);
    return m ? m[1] : null;
  } catch { return null; }
}

// DSML（工具调用 XML）→ 可读"🔧 调用工具：X（命令）"；其余标签剔除
function stripDSML(t) {
  return String(t || '')
    // 整段 tool_calls 块（含未闭合）→ 提取 invoke 名
    .replace(/<tool_calls>[\s\S]*?<invoke name="([^"]+)"[\s\S]*?(?:<\/invoke>|<\/tool_calls>|$)/g, (m, name) => '\n🔧 调用工具:' + name + '\n')
    .replace(/<invoke name="([^"]+)"[\s\S]*?<\/invoke>/g, (m, name) => '\n🔧 调用工具:' + name + '\n')
    .replace(/<tool_calls>|<\/tool_calls>|<parameter[^>]*>|<\/parameter>/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

// 真实 DSH agent 任务执行（host 端，跑真 harness agent）
// 参考 dsh-headless：agents.create → followup(user) → whenIdle → session.events 收集过程
async function runRealAgentTask(ctx, task) {
  try {
    const agents = ctx.get('agents');
    const defaultModel = ctx.get('agentDefaultModel');
    const sessions = ctx.get('sessions');
    if (!agents || !defaultModel || !sessions) return { error: 'agent services unavailable 1' };
    const dshSession = await import('@deepseek-ai/dsh-session');
    const dshLlm = await import('@deepseek-ai/dsh-llm');
    const dshAgent = await import('@deepseek-ai/dsh-agent');
    const selection = defaultModel.currentSelection();
    const { agent } = await agents.create({
      sessionId: dshSession.SessionId('session-' + randomUUID()),
      meta: { cwd: '/Users/zengtian/projects' },
      agentOptions: { provider: selection.provider, model: selection.model },
      setup: (agentCtx) => { dshAgent.installModelSelection(agentCtx, { current: selection, assembled: undefined }); },
    });
    await agent.whenIdle();
    const firstSeq = agent.session.seq;
    agent.followup(dshLlm.createUserMessage({ content: [{ type: 'text', text: task }], source: { kind: 'user' } }));
    await agent.whenIdle();
    await sessions.flush(agent.session);
    // 收集 turn/step/tool 过程 → 任务过程 JSON
    const process = [];
    let text = '', started = false;
    for (const ev of agent.session.events) {
      if (typeof ev.seq === 'number' && ev.seq < firstSeq) continue;
      if (ev.type === 'turn/start') { started = true; process.push({ type: 'turn/start' }); continue; }
      if (!started) continue;
      if (ev.type === 'assistant/message') {
        const joined = ((ev.data.message.content || []).filter(b => b.type === 'text').map(b => b.text).join(''));
        if (joined) { text = stripDSML(joined); process.push({ type: 'assistant', text: stripDSML(joined) }); }
      } else if (ev.type === 'tool/call') {
        process.push({ type: 'tool/call', tool: ev.data.toolName || ev.data.tool, args: ev.data.args });
      } else if (ev.type === 'tool/result') {
        process.push({ type: 'tool/result', tool: ev.data.toolName || ev.data.tool, ok: ev.data.ok });
      } else if (ev.type === 'step/start' || ev.type === 'step/end') {
        process.push({ type: ev.type });
      } else if (ev.type === 'turn/end') {
        process.push({ type: 'turn/end', reason: ev.data.reason });
      }
    }
    return { text, process: process.slice(0, 200), sessionId: String(agent.session.id || '') };
  } catch (e) {
    return { error: 'real agent failed: ' + (e instanceof Error ? e.message : String(e)) };
  }
}

// 工作区枚举：列出真实 DSH 会话作为「工作区」条目
async function listWorkspaces(ctx) {
  try {
    const sessions = ctx.get('sessions');
    if (!sessions || typeof sessions.list !== 'function') return { items: [], note: 'sessions unavailable' };
    const items = sessions.list().map((s) => {
      let title = '';
      for (const ev of (s.events || [])) {
        if (ev.type === 'user/message') {
          const d = ev.data || {};
          const msg = d.message || d;
          const blocks = Array.isArray(msg?.content) ? msg.content : (Array.isArray(msg) ? msg : []);
          let joined = '';
          for (const b of blocks) {
            if (typeof b === 'string') joined += b;
            else if (b && b.type === 'text' && b.text !== undefined) joined += b.text;
          }
          joined = joined.trim();
          if (joined) { title = joined.slice(0, 40); break; }
        }
      }
      const cwd = s.header?.meta?.cwd || '';
      return { id: String(s.id), title: title || cwd || '未命名任务', cwd };
    });
    return { items };
  } catch (e) {
    return { items: [], error: String(e instanceof Error ? e.message : e) };
  }
}

// 干活人设（DeepSeek 工作助手）
const WORK_PERSONA = '你是 DeepSeek 工作助手，帮用户高效完成任务：分析、编码、写作、资料研究等。回复专业、结构化、可直接执行。用中文，先给结论再给步骤。';

// 干活聊天：POST {message, history} → DeepSeek(工作) → {reply}
async function workChat(req) {
  let body = '';
  for await (const chunk of req) body += chunk;
  let parsed = {};
  try { parsed = JSON.parse(body || '{}'); } catch {}
  const message = String(parsed.message || '').trim();
  const history = Array.isArray(parsed.history) ? parsed.history.slice(-10) : [];
  const key = readDeepseekKey();
  if (!key) return { reply: '（未配置 DEEPSEEK_API_KEY，无法干活）' };
  if (!message) return { reply: '有什么任务交给我？' };
  try {
    const res = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
      body: JSON.stringify({ model: 'deepseek-chat', messages: [{ role: 'system', content: WORK_PERSONA }, ...history, { role: 'user', content: message }], max_tokens: 600 }),
    });
    const data = await res.json();
    const reply = data && data.choices && data.choices[0] && data.choices[0].message ? data.choices[0].message.content : '(任务执行中断，请重试)';
    return { reply };
  } catch { return { reply: '（连接不上，稍后再试）' }; }
}

// 陪伴聊天：POST {message, history} → DeepSeek(Mira) → {reply}
async function companionChat(req) {
  let body = '';
  for await (const chunk of req) body += chunk;
  let parsed = {};
  try { parsed = JSON.parse(body || '{}'); } catch {}
  const message = String(parsed.message || '').trim();
  const history = Array.isArray(parsed.history) ? parsed.history.slice(-10) : [];
  if (!message) return { reply: '嗯？我在这儿呢，想聊什么？' };
  const key = readDeepseekKey();
  if (!key) return { reply: '（未配置 DEEPSEEK_API_KEY，暂时只能陪你发呆）' };
  try {
    const res = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [{ role: 'system', content: MIRA_PERSONA }, ...history, { role: 'user', content: message }],
        max_tokens: 200,
      }),
    });
    const data = await res.json();
    const reply = data && data.choices && data.choices[0] && data.choices[0].message
      ? data.choices[0].message.content : '(Mira 走神了，再说一遍？)';
    return { reply };
  } catch (e) {
    return { reply: '（连接不上，等一下再找我）' };
  }
}

// 陪伴模式：伺服 bwm friend 聊天页（index.html + styles.css + 品牌图 + init shim）
// 外观完全复刻原版；视频由 shim 指向本插件 idle 资产；不加载 app.js（避免无后端时大量 /api 失败报错）
const COMPANION_SHIM = [
  '(async function(){',
  '  try {',
  '    const inv = await (await fetch("/bwm-friend/inventory")).json();',
  '    const idle = (inv.items||[]).filter(i=>i.type==="idle");',
  '    const pick = idle[0] || (inv.items||[])[0];',
  '    if (pick) {',
  '      const v = document.getElementById("avatarVideo");',
  '      if (v) {',
  '        // bwm CSS: avatar-video 默认 opacity:0，须加 ready 类才可见（原 app.js 的职责，这里补上）',
  '        const show = () => v.classList.add("ready");',
  '        v.addEventListener("loadeddata", show);',
  '        v.addEventListener("canplay", show);',
  '        v.src = pick.url;',
  '        const tryPlay = () => { if (v.paused) v.play().catch(()=>{}); };',
  '        tryPlay();',
  '        document.addEventListener("pointerdown", tryPlay, { once: true }); // 自动播放被拦时首点恢复',
  '        setTimeout(show, 3000); // 兜底：事件未触发也显示',
  '      }',
  '      const ph = document.getElementById("avatarPlaceholder");',
  '      if (ph) ph.style.display = "none";',
  '    }',
  '  } catch(e) { console.error("companion init:", e); }',
  '  // 设置抽屉默认完全推出屏幕外（bwm 原右缘露一截 → 修掉残影）',
  '  const sp = document.querySelector("[class*=settings-panel]");',
  '  if (sp && !sp.classList.contains("open")) sp.style.transform = "translateX(calc(100% + 24px))";',
  '})();',
].join('\n');

// companion-chat.js — 陪伴聊天：把 bwm 页面的 composer 接到插件聊天接口
// 1:1 复刻布局不动；只让聊天真正能收发（Mira 人设走 DeepSeek，语音= M3）
const COMPANION_CHAT_JS = `(function(){
  // 顶部加"切换到干活"按钮（陪伴页 → 干活页）；embedded 时通知父页，独立时跳转 /
  var actions = document.querySelector('.topbar-actions');
  if (actions && !document.getElementById('bwm-switch-work')) {
    var work = document.createElement('button');
    work.id = 'bwm-switch-work';
    work.type = 'button';
    work.title = '切换到干活页';
    work.setAttribute('aria-label', '切换到干活页');
    work.textContent = '干活';
    work.style.cssText = 'height:32px; padding:0 14px; border-radius:999px; border:1px solid rgba(123,242,210,.5); background:rgba(8,13,22,.6); color:#7bf2d2; font-size:12px; font-weight:600; cursor:pointer; display:flex; align-items:center; letter-spacing:.05em;';
    work.addEventListener('click', function () {
      if (window.parent !== window) {
        window.parent.postMessage({ type: 'bwm-switch-mode', mode: 'work' }, '*');
      } else {
        window.location.href = '/bwm-friend/work/';
      }
    });
    actions.insertBefore(work, actions.firstChild);
  }
  const form = document.getElementById('composer');
  const input = document.getElementById('messageInput');
  const replies = document.getElementById('assistantReplies');
  const turn = document.getElementById('turnLabel');
  if (!form || !input || !replies) return;
  const history = [];
  const esc = (t) => String(t).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const replyBubble = (text) => {
    const el = document.createElement('div');
    el.className = 'assistant-reply';
    el.innerHTML = '<span class="reply-text">' + esc(text) + '</span>';
    replies.appendChild(el);
    replies.scrollTop = replies.scrollHeight;
    return el;
  };
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    // bwm 结构：用户的话 = turn label（mint user-turn），回复 = replies 区
    if (turn) { turn.textContent = text; turn.classList.add('user-turn'); }
    history.push({ role: 'user', content: text });
    const wait = replyBubble('…');
    try {
      const res = await fetch('/bwm-friend/companion/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text, history }),
      });
      const data = await res.json();
      const reply = (data && data.reply) || '（她没听清，再说一遍？）';
      wait.querySelector('.reply-text').textContent = reply;
      history.push({ role: 'assistant', content: reply });
    } catch (err) {
      wait.querySelector('.reply-text').textContent = '（连接失败，稍后再试）';
    }
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); }
  });
})();`;

// work-init：标记 work 模式（布局与 companion 完全一致，仅内容/按钮不同）
const WORK_INIT_JS = `document.body.setAttribute('data-bwm-mode','work');`;

// work-chat：左窗口 = iframe 内嵌原生 DSH 会话视图（业务流原生）；右上按钮（陪伴 / ☰工作区）
const WORK_CHAT_JS = `(function(){
  document.body.setAttribute('data-bwm-mode','work');
  // 右上控制区加按钮：陪伴切换、☰ 工作区（弹出 iframe 内侧栏抽屉）
  var actions = document.querySelector('.topbar-actions');
  function mkBtn(id, label, title, fn) {
    var b = document.createElement('button');
    b.id = id; b.type = 'button'; b.title = title; b.setAttribute('aria-label', title); b.textContent = label;
    b.style.cssText = 'height:32px; padding:0 14px; border-radius:999px; border:1px solid rgba(123,242,210,.5); background:rgba(8,13,22,.6); color:#7bf2d2; font-size:12px; font-weight:600; cursor:pointer; display:flex; align-items:center; letter-spacing:.05em;';
    b.addEventListener('click', fn);
    return b;
  }
  function openHarness(msg) {
    var f = document.getElementById('bwm-harness-frame');
    if (f && f.contentWindow) f.contentWindow.postMessage(msg, '*');
  }
  function toggleHarnessSidebar() {
    var f = document.getElementById('bwm-harness-frame');
    if (f && f.contentDocument) {
      var sb = f.contentDocument.querySelector('[class*=sidebarCol]');
      if (sb) sb.classList.toggle('bwm-emb-open');
    }
  }
  if (actions) {
    if (!document.getElementById('bwm-switch-companion')) {
      actions.insertBefore(mkBtn('bwm-switch-companion','陪伴','切换到陪伴', function(){ window.location.href='/bwm-friend/companion/'; }), actions.firstChild);
    }
    if (!document.getElementById('bwm-sidebar-drawer-btn')) {
      actions.appendChild(mkBtn('bwm-sidebar-drawer-btn','☰ 工作区','工作区/会话', function(){ toggleHarnessSidebar(); }));
    }
  }
  // 左窗口 = iframe 内嵌原生 DSH 会话视图（内容列宽 = bwm 589px，撑满面板内容区）
  var panel = document.querySelector('.dialogue-panel');
  if (panel) {
    while (panel.firstChild) panel.removeChild(panel.firstChild);
    // 左内边距减小（BWM 原窗口更靠左；右内边距保持用蓝虚线分隔视频）
    panel.style.paddingLeft = '46px';
    var f = document.createElement('iframe');
    f.id = 'bwm-harness-frame';
    f.src = window.location.origin + '/?bwm=embedded';
    f.setAttribute('allow', 'clipboard-read; clipboard-write');
    // 作为面板 flex 子项，落在内容列（面板内边距 77px → 内容 589px），不撑满 742px 面板
    f.style.cssText = 'flex:1 1 auto; min-height:0; width:100%; border:0; background:transparent;';
    panel.appendChild(f);
  }
})();`;

async function serveCompanion(pathname, res) {
  // work /companion 共用同一 bwm 页面（像素一致），仅注入内容脚本不同
  const isWork = pathname.startsWith('/bwm-friend/work');
  const base = isWork ? '/bwm-friend/work' : '/bwm-friend/companion';
  const rel = pathname.replace(base, '');
  const file = rel === '' || rel === '/' ? 'index.html' : rel.slice(1);
  const abs = join(BWM_STATIC, file);
  try {
    if (file === 'index.html') {
      let html = await readFile(abs, 'utf8');
      // 将 root 绝对路径改为相对（在 /bwm-friend/companion/ 前缀下可解析）
      html = html
        .replace(/href="\/styles\.css\?v=([^"]*)"/g, 'href="styles.css?v=$1"')
        .replace(/href="\/favicon\.png"/g, 'href="favicon.png"')
        .replace(/src="\/brand-mark-54\.png"/g, 'src="brand-mark-54.png"')
        .replace(/srcset="\/brand-mark-54\.png 1x, \/brand-mark-108\.png 2x"/g, 'srcset="brand-mark-54.png 1x, brand-mark-108.png 2x"')
        .replace(/<script[^>]*src="\/app\.js[^>]*><\/script>/, '') // 去掉 app.js（无后端时省掉一堆 /api 失败）
        .replace('</body>', isWork
          ? '<script src="work-init.js"></script><script src="work-chat.js"></script><script src="companion-init.js"></script></body>'
          : '<script src="companion-chat.js"></script><script src="companion-init.js"></script></body>');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(html);
    }
    if (file === 'work-init.js') {
      res.writeHead(200, { 'Content-Type': 'application/javascript', 'Cache-Control': 'no-store' });
      return res.end(WORK_INIT_JS);
    }
    if (file === 'work-chat.js') {
      res.writeHead(200, { 'Content-Type': 'application/javascript', 'Cache-Control': 'no-store' });
      return res.end(WORK_CHAT_JS);
    }
    if (file === 'companion-chat.js') {
      res.writeHead(200, { 'Content-Type': 'application/javascript', 'Cache-Control': 'no-store' });
      return res.end(COMPANION_CHAT_JS);
    }
    if (file === 'companion-init.js') {
      res.writeHead(200, { 'Content-Type': 'application/javascript', 'Cache-Control': 'no-store' });
      return res.end(COMPANION_SHIM);
    }
    const mime = file.endsWith('.css') ? 'text/css' : file.endsWith('.png') ? 'image/png' : 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime });
    return createReadStream(abs).pipe(res);
  } catch (e) {
    return serveJson(res, { error: 'companion asset not found' }, 404);
  }
}

function serveJson(res, obj, status = 200) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(obj));
}

// 媒体流（支持 Range，供 <video> 拖动/循环；仅白名单 token）
function serveMedia(absPath, req, res) {
  stat(absPath)
    .then((st) => {
      const total = st.size;
      const range = req.headers.range;
      let start = 0;
      let end = total - 1;
      if (range) {
        const m = /bytes=(\d*)-(\d*)/.exec(range);
        if (m) {
          if (m[1]) start = Number(m[1]);
          if (m[2]) end = Number(m[2]);
        }
      }
      if (start >= total || end >= total) {
        res.writeHead(416, { 'Content-Range': `bytes */${total}` });
        return res.end();
      }
      res.writeHead(206, {
        'Content-Type': 'video/mp4',
        'Accept-Ranges': 'bytes',
        'Content-Range': `bytes ${start}-${end}/${total}`,
        'Content-Length': String(end - start + 1),
      });
      createReadStream(absPath, { start, end }).pipe(res);
    })
    .catch(() => {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'media not found' }));
    });
}

export function apply(ctx) {
  const webServer = ctx.webServer;
  if (!webServer || typeof webServer.register !== 'function') {
    return () => {}; // headless/TUI 无 webServer 时安全退出
  }

  const disposers = [];
  disposers.push(
    webServer.register({
      kind: 'prefix',
      path: '/bwm-friend',
      handler: async (req, res) => {
        const pathname = new URL(req.url || '/', 'http://x').pathname;
        if (pathname === '/bwm-friend/settings' && req.method === 'GET') {
          return serveJson(res, await readConfig());
        }
        if (pathname === '/bwm-friend/settings' && req.method === 'PUT') {
          let body = '';
          for await (const chunk of req) body += chunk;
          const cfg = { ...(await readConfig()), ...JSON.parse(body || '{}') };
          await writeConfig(cfg);
          return serveJson(res, cfg);
        }
        if (pathname === '/bwm-friend/inventory') {
          return serveJson(res, { items: await buildInventory() });
        }
        if (pathname === '/bwm-friend/status') {
          const cfg = await readConfig();
          return serveJson(res, {
            version: cfg.version,
            mode: cfg.mode,
            theme: cfg.avatar.theme,
            bwmOnline: await probeBwm(),
          });
        }
        const mediaMatch = /^\/bwm-friend\/media\/([A-Za-z0-9_-]+)$/.exec(pathname);
        if (mediaMatch && req.method === 'GET') {
          const abs = mediaMap.get(mediaMatch[1]);
          if (abs) return serveMedia(abs, req, res);
          return serveJson(res, { error: 'unknown token' }, 404);
        }
        if (pathname === '/bwm-friend/health') {
          return serveJson(res, { ok: true });
        }
        if (pathname === '/bwm-friend/companion/chat' && req.method === 'POST') {
          return serveJson(res, await companionChat(req));
        }
        if (pathname === '/bwm-friend/work/task' && req.method === 'POST') {
          let body = '';
          for await (const chunk of req) body += chunk;
          let parsed = {};
          try { parsed = JSON.parse(body || '{}'); } catch {}
          const msg = String(parsed.message || '').trim();
          if (!msg) return serveJson(res, { reply: '有什么任务？', process: [] });
          return serveJson(res, await runRealAgentTask(ctx, msg));
        }
        if (pathname === '/bwm-friend/work/workspaces' && req.method === 'GET') {
          return serveJson(res, await listWorkspaces(ctx));
        }
        if (pathname.startsWith('/bwm-friend/companion') || pathname.startsWith('/bwm-friend/work')) {
          return serveCompanion(pathname, res);
        }
        return serveJson(res, { error: 'not found' }, 404);
      },
    }),
  );

  return () => {
    for (const d of disposers) d();
  };
}
