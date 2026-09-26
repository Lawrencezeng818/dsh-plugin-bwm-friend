#!/bin/bash
# restart-3080-0.7.2.sh — B 级同步：重启 3080 主 GUI，加载 dsh-plugin-bwm-friend 0.7.2
# 执行方式：经 python3 os.setsid() 分离执行（旧会话随 3080 中断后，本脚本继续完成重启+验证）
# 启动参数与原进程（PID 779, 2026-09-19 20:56 启动）逐字一致，含 --trusted-host 47.84.28.40:18082
# 回滚方式：cd /Users/zengtian/projects/dsh-plugin-bwm-friend && git checkout f118412 -- lib packages src && npm run build && 重跑本脚本
# 配置备份：~/.dsh-bwm-friend/config.json.bak-20260926-072
set -u
LOG=/Users/zengtian/projects/dsh-plugin-bwm-friend/restart-3080-0.7.2.log
RESULT=/Users/zengtian/projects/dsh-plugin-bwm-friend/restart-3080-0.7.2.result.txt
HARNESS=/Users/zengtian/projects/deepseek-harness
NODE=/opt/homebrew/bin/node
export HOME=/Users/zengtian
say(){ echo "[$(date '+%F %T')] $*" | tee -a "$LOG"; }

sleep 8  # 等派发方（旧会话）退出并落盘最终消息
say "=== B 级重启开始（0.7.2 同步）==="

# 0) 备份真实用户配置（回滚保险）
if [ -f "$HOME/.dsh-bwm-friend/config.json" ]; then
  cp "$HOME/.dsh-bwm-friend/config.json" "$HOME/.dsh-bwm-friend/config.json.bak-20260926-072" && say "配置已备份 -> config.json.bak-20260926-072"
fi

# 1) 停旧进程（SIGTERM → 宽限 15s → SIGKILL）
OLDPID=$(cat "$HARNESS/.web-3080.pid" 2>/dev/null || echo 779)
say "停止旧 3080 进程 pid=$OLDPID"
kill "$OLDPID" 2>/dev/null
for i in $(seq 1 15); do kill -0 "$OLDPID" 2>/dev/null || break; sleep 1; done
if kill -0 "$OLDPID" 2>/dev/null; then say "SIGTERM 未退出，改 SIGKILL"; kill -9 "$OLDPID" 2>/dev/null; sleep 2; fi
say "旧进程已退出"

# 2) 启动新 3080（cwd=deepseek-harness；nohup 脱离；日志落 web-3080.log）
cd "$HARNESS" || { say "❌ cd 失败"; echo "FAIL cd" > "$RESULT"; exit 1; }
nohup "$NODE" --import tsx/esm apps/cli/src/bin.ts web --port 3080 --trusted-host 47.84.28.40:18082 --no-open >> "$HARNESS/web-3080.log" 2>&1 &
NEWPID=$!
echo "$NEWPID" > "$HARNESS/.web-3080.pid"
say "新 3080 已拉起 pid=$NEWPID"

# 3) 等待响应（最长 120s）
UP=no
for i in $(seq 1 120); do
  curl -sf -o /dev/null -m 2 "http://127.0.0.1:3080/" && { UP=yes; break; }
  sleep 1
done
if [ "$UP" = yes ]; then say "3080 已响应"; else say "❌ 120s 未响应，查日志 $HARNESS/web-3080.log"; echo "FAIL no-response $(date '+%F %T')" > "$RESULT"; exit 1; fi
sleep 3

# 4) 冒烟验证
H=$(curl -s -m 5 "http://127.0.0.1:3080/bwm-friend/health")
say "health: $H"
echo "$H" | grep -q '"version":"0.7.2"' && say "✅ health 版本 0.7.2（深度形态）" || say "❌ health 版本非 0.7.2"
W=$(curl -s -o /dev/null -w '%{http_code}' -m 5 "http://127.0.0.1:3080/bwm-friend/work/")
say "work 页 HTTP $W"
SZ=$(curl -s -m 5 "http://127.0.0.1:3080/bwm-friend/work/work-chat.js" | wc -c | tr -d ' ')
say "work-chat.js $SZ 字节（0.7.2 应约 20961；旧版 6657）"
C=$(curl -s -o /dev/null -w '%{http_code}' -m 5 "http://127.0.0.1:3080/bwm-friend/companion/")
say "companion 页 HTTP $C"
CFG=$(curl -s -m 5 "http://127.0.0.1:3080/bwm-friend/settings")
CODE=$(printf '%s' "$CFG" | curl -s -o /dev/null -w '%{http_code}' -m 5 -X PUT -H 'Content-Type: application/json' --data @- "http://127.0.0.1:3080/bwm-friend/settings")
say "settings 回写冒烟（GET→原样 PUT）: HTTP $CODE（期望 200）"

# 5) 重拉 3200 沙盒（3080 重启会进程组连带杀掉它——HANDOVER 红线）
if curl -sf -o /dev/null -m 2 "http://127.0.0.1:3200/bwm-friend/health"; then
  say "3200 存活，无需重拉"
else
  say "3200 已被连带杀掉，重拉…"
  /Users/zengtian/projects/dsh-sandbox/stop.sh >/dev/null 2>&1
  if /Users/zengtian/projects/dsh-sandbox/start.sh 3200 >/dev/null 2>&1; then say "3200 已重拉"; else say "❌ 3200 重拉失败（稍后手动 cd ~/projects/dsh-sandbox && ./start.sh 3200）"; fi
fi

say "=== B 级重启完成 ==="
echo "DONE $(date '+%F %T')" > "$RESULT"
