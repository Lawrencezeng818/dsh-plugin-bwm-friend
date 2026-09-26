#!/bin/bash
# fix-3080-0.7.2.sh — 3080 插件同步终版：
#   ~/.dsh-bwm（3080 守护服务 DSH_HOME）profile 的 v0.3.1 实体快照 → 换成指向仓库的软链
#   + profile 依赖声明改 link: + launchctl kickstart 重启 + 深度冒烟 + 重拉 3200
# 回滚：mv dsh-plugin-bwm-friend.bak-0.3.1-20260926 回原名；package.json.bak-20260926 回原名；再 kickstart
set -u
export HOME=/Users/zengtian
trap '' HUP INT TERM
LOG=/Users/zengtian/projects/dsh-plugin-bwm-friend/restart-3080-0.7.2.log
RESULT=/Users/zengtian/projects/dsh-plugin-bwm-friend/restart-3080-0.7.2.result.txt
NM=/Users/zengtian/.dsh-bwm/profiles/web/node_modules
P=$NM/dsh-plugin-bwm-friend
REPO=/Users/zengtian/projects/dsh-plugin-bwm-friend
SVC=gui/501/com.boss.dsh-bwm-web
say(){ echo "[$(date '+%F %T')] $*" | tee -a "$LOG"; }

sleep 8  # 等派发方（旧会话）退出并落盘最终消息
say "=== 3080 终版同步开始（.dsh-bwm 快照 → 仓库软链）==="

# 0) 备份实体快照与 profile 依赖声明（回滚保险）
if [ -d "$P" ] && [ ! -L "$P" ]; then
  mv "$P" "${P}.bak-0.3.1-20260926" && say "v0.3.1 实体快照已挪至 .bak-0.3.1-20260926"
fi
PJ=/Users/zengtian/.dsh-bwm/profiles/web/package.json
if [ -f "$PJ" ]; then
  cp "$PJ" "${PJ}.bak-20260926"
  python3 - "$PJ" <<'PY'
import json, sys
p = sys.argv[1]
d = json.load(open(p))
d.setdefault('dependencies', {})['dsh-plugin-bwm-friend'] = 'link:/Users/zengtian/projects/dsh-plugin-bwm-friend'
json.dump(d, open(p, 'w'), indent=2, ensure_ascii=False)
print('decl -> link:')
PY
  say "profile 依赖声明已改 link:（原文件备份 package.json.bak-20260926）"
fi

# 1) 建软链（指向仓库 = 0.7.2）
if [ ! -e "$P" ] && [ ! -L "$P" ]; then
  ln -s "$REPO" "$P" && say "软链已建：node_modules/dsh-plugin-bwm-friend -> $REPO"
else
  say "条目已存在（$( [ -L "$P" ] && echo symlink || echo dir )），跳过建链"
fi

# 2) kickstart 重启（KeepAlive 拉起新进程，加载软链目标 = 仓库 0.7.2）
say "kickstart 重启 $SVC（本操作会中断运行中的 DSH 会话）"
launchctl kickstart -k "$SVC" 2>&1 | tee -a "$LOG"

# 3) 等待响应（最长 180s）
UP=no
for i in $(seq 1 180); do
  curl -sf -o /dev/null -m 2 "http://127.0.0.1:3080/" && { UP=yes; break; }
  sleep 1
done
if [ "$UP" = yes ]; then say "3080 已响应"; else say "❌ 180s 未响应，查 /Users/zengtian/projects/_platform_outputs/dsh-web.log"; echo "FAIL no-response $(date '+%F %T')" > "$RESULT"; exit 1; fi
sleep 5

# 4) 深度冒烟
H=$(curl -s -m 5 "http://127.0.0.1:3080/bwm-friend/health")
say "health: $H"
OK=1
echo "$H" | grep -q '"version":"0.7.2"' && say "✅ health 0.7.2（深度形态）" || { say "❌ health 版本非 0.7.2"; OK=0; }
SZ=$(curl -s -m 5 "http://127.0.0.1:3080/bwm-friend/work/work-chat.js" | wc -c | tr -d ' ')
[ "$SZ" -gt 20000 ] 2>/dev/null && say "✅ work-chat.js $SZ 字节（0.7.2 新壳）" || { say "❌ work-chat.js $SZ 字节（非新壳）"; OK=0; }
M=$(curl -s -o /dev/null -w '%{http_code}' -m 5 "http://127.0.0.1:3080/bwm-friend/metrics")
[ "$M" = 200 ] && say "✅ metrics 200" || { say "❌ metrics HTTP $M"; OK=0; }
W=$(curl -s -o /dev/null -w '%{http_code}' -m 5 "http://127.0.0.1:3080/bwm-friend/work/")
say "work 页 HTTP $W"
CFG=$(curl -s -m 5 "http://127.0.0.1:3080/bwm-friend/settings")
CODE=$(printf '%s' "$CFG" | curl -s -o /dev/null -w '%{http_code}' -m 5 -X PUT -H 'Content-Type: application/json' --data @- "http://127.0.0.1:3080/bwm-friend/settings")
[ "$CODE" = 200 ] && say "✅ settings 回写 200" || { say "❌ settings 回写 HTTP $CODE"; OK=0; }

# 5) 重拉 3200（此前被级联杀掉）
if curl -sf -o /dev/null -m 2 "http://127.0.0.1:3200/bwm-friend/health"; then
  say "3200 存活"
else
  say "重拉 3200 沙盒…"
  /Users/zengtian/projects/dsh-sandbox/stop.sh >/dev/null 2>&1
  /Users/zengtian/projects/dsh-sandbox/start.sh 3200 >/dev/null 2>&1 && say "✅ 3200 已重拉" || say "❌ 3200 重拉失败"
fi

if [ "$OK" = 1 ]; then
  say "=== 3080 终版同步完成：0.7.2 全部冒烟通过 ==="
  echo "DONE $(date '+%F %T')" > "$RESULT"
else
  say "=== 冒烟存在失败项，见上（回滚：mv .bak 回原名 + kickstart）==="
  echo "FAIL $(date '+%F %T')" > "$RESULT"
fi
