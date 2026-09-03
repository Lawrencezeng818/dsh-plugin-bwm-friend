#!/usr/bin/env node
/**
 * tests/verify-shim.mjs — bwm-friend 状态同步验证 shim 服务
 *
 * 用法: node tests/verify-shim.mjs <lib/index.js 路径> <端口>
 *
 * 把任意版本的 lib/index.js（修复前/后）以真实路由挂到一个独立 HTTP 服务上，
 * 并在同源 /__verify 驱动页里 iframe 加载 work 页做 DOM 断言（dump-dom 回收结果）。
 * 关键隔离：用 HOME=$临时目录 启动（见 status-sync-verify.sh），配置读写不碰真实 ~/.dsh-bwm-friend。
 */
import http from 'node:http';
import { pathToFileURL } from 'node:url';

const libPath = process.argv[2];
const port = Number(process.argv[3] || 8081);
if (!libPath) { console.error('usage: verify-shim.mjs <lib/index.js> <port>'); process.exit(1); }

const mod = await import(pathToFileURL(libPath).href);

// 驱动页：同源 iframe 内断言 work 页状态（结果写 <pre> + title，dump-dom 回收）
const DRIVER = `<!doctype html><meta charset="utf-8"><title>sync-selftest</title>
<iframe id="f" src="/bwm-friend/work/" style="width:1440px;height:900px;border:0"></iframe>
<pre id="out">PENDING</pre>
<script>
(function(){
  var out=[]; function ok(n,c){ out.push((c?'PASS ':'FAIL ')+n); }
  var f=document.getElementById('f');
  f.addEventListener('load',function(){ setTimeout(async function(){
    try{
      var d=f.contentDocument, w=f.contentWindow;
      // 等 companion-chat.js 动态加载 + inventory/settings fetch 完成（模板网格填充 >1 卡）
      var tries=0;
      while(tries<60){
        var g=d.getElementById('templateGrid');
        if(g && g.children.length>1) break;
        await new Promise(function(r){setTimeout(r,250);}); tries++;
      }
      var grid=d.getElementById('templateGrid');
      if(!grid||grid.children.length<2){ out.push('FAIL 模板网格未填充（页面脚本未跑起来?）'); throw 0; }
      var act=grid.querySelector('.template-card.active');
      ok('T1 初始高亮=配置主题(电竞男孩)', !!act && act.getAttribute('data-template')==='电竞男孩');
      ok('T2 无 custom_uploads 垃圾模板卡', !grid.querySelector('[data-template="custom_uploads"]'));
      ok('T3 默认卡存在且值为(root)', !!grid.querySelector('[data-template="(root)"]'));
      var pn=d.getElementById('personaTemplateName');
      ok('T4 当前模板标签含电竞男孩', !!pn && pn.textContent.indexOf('电竞男孩')>-1);
      var vs=d.getElementById('voiceSelect');
      ok('T5 音色回显=配置(冰糖)', !!vs && vs.value==='冰糖');
      var pInput=d.getElementById('personaInput');
      ok('T10 启动人格=按主题(personas[电竞男孩])', !!pInput && pInput.value==='电竞人格X');
      var v=d.getElementById('avatarVideo');
      var srcBefore=(v&&(v.getAttribute('src')||''))||'';
      // 点击热切同步：甜心女孩
      var card=grid.querySelector('[data-template="甜心女孩"]');
      if(card){
        card.click();
        await new Promise(function(r){setTimeout(r,1500);});
        var act2=grid.querySelector('.template-card.active');
        ok('T6 点击后高亮跟随(甜心女孩)', !!act2 && act2.getAttribute('data-template')==='甜心女孩');
        ok('T7 当前模板标签热更新', !!pn && pn.textContent.indexOf('甜心女孩')>-1);
        var srcAfter=(v&&(v.getAttribute('src')||''))||'';
        ok('T8 视频idle热切(src变化)', srcAfter!=='' && srcAfter!==srcBefore);
        // 皮肤卡初始/联动高亮（皮肤主题=甜心女孩，点击后应亮）
        var skin=d.querySelector('#customTemplateGrid [data-skin="甜心女孩"]');
        ok('T9 皮肤卡联动高亮', !!skin && skin.classList.contains('active'));
        // ── 模板⇒音色联动（2026-09-03 P1 用户报告：切模板声音音色不变）──
        var vs2=d.getElementById('voiceSelect');
        var vst=d.getElementById('voiceStatus');
        ok('T11a 切模板音色跟随预设(甜心女孩→茉莉)', !!vs2 && vs2.value==='茉莉');
        ok('T11b 音色状态注明随模板', !!vst && vst.textContent.indexOf('随模板')>-1);
        var cfg1=await (await fetch('/bwm-friend/settings')).json();
        ok('T11c 一次PUT原子持久化(theme+voice)', cfg1.avatar.theme==='甜心女孩' && cfg1.voice.voice==='茉莉');
        ok('T11d 人格回退=legacy(甜心女孩无personas→空)', !!pInput && pInput.value==='');
      } else out.push('FAIL 找不到 甜心女孩 模板卡');
      // 切回电竞男孩：音色预设 Milo + 人格回到该主题专属
      var card2=grid.querySelector('[data-template="电竞男孩"]');
      if(card2){
        card2.click();
        await new Promise(function(r){setTimeout(r,1500);});
        var vs3=d.getElementById('voiceSelect');
        ok('T12 切回电竞男孩音色跟随(Milo)', !!vs3 && vs3.value==='Milo');
        ok('T13 人格回到主题专属(电竞人格X)', !!pInput && pInput.value==='电竞人格X');
        // 人格保存写 personas[当前主题]
        if(pInput){ pInput.value='新人格Y'; }
        var psBtn=d.getElementById('personaSaveBtn');
        if(psBtn){ psBtn.click(); await new Promise(function(r){setTimeout(r,1200);}); }
        var cfg2=await (await fetch('/bwm-friend/settings')).json();
        var ps=(cfg2&&cfg2.avatar&&cfg2.avatar.personas)||{};
        ok('T14 人格保存写入personas[电竞男孩]', ps['电竞男孩']==='新人格Y');
      } else out.push('FAIL 找不到 电竞男孩 模板卡');
      // 还原隔离配置（此处 HOME 已隔离，不影响真实配置）
      await fetch('/bwm-friend/settings',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({avatar:{theme:'电竞男孩'}})});
      out.push('DONE');
    }catch(e){ if(e!==0) out.push('FAIL exception '+(e&&e.message||e)); }
    var pre=document.getElementById('out');
    pre.textContent='SYNCSELFTEST\\n'+out.join('\\n');
    var all=out.length>0 && out.every(function(l){return l.indexOf('FAIL')!==0;}) && out.indexOf('DONE')>=0;
    document.title= all?'SYNC-ALL-PASS':'SYNC-HAS-FAIL';
  },400); });
})();
</script>`;

const handlers = [];
const webServer = { register: (o) => { handlers.push(o); return () => {}; } };
await mod.apply({ webServer });

const server = http.createServer((req, res) => {
  const u = new URL(req.url || '/', 'http://x');
  if (u.pathname === '/__verify') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(DRIVER);
  }
  const h = handlers.find((x) => u.pathname.startsWith(x.path));
  if (h) return h.handler(req, res);
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
});
server.listen(port, '127.0.0.1', () => console.log('shim listening on ' + port));
