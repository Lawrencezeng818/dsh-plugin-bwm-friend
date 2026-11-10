#!/bin/zsh
# fix-3080-mimo-key.sh — 修复 3080 语音识别（launchd 化时 XIAOMI_MIMO_API_KEY 丢失）
#
# 根因（2026-09-27 定案）：
#   0.7.2（09-26 09:52）把 3080 从终端手动启动改为 launchd 守护 com.boss.dsh-bwm-web，
#   plist EnvironmentVariables 只带 PATH/HOME/DSH_HOME/CLAWCHAT_*，未带 XIAOMI_MIMO_API_KEY。
#   此前终端手动启动会继承 shell export，改 launchd 后进程无 key →
#   mimoTranscribe 返回 {ok:false,error:'missing-key-or-audio'}（HTTP 200 包裹）→
#   companion 页长按说话提示「识别失败，请打字或重试」。
#   观测点：GET /bwm-friend/health → components.voice.configured=false；host.log 有
#   transcribe bytes 事件但客户端提示识别失败；key 本体经 MiMo 探针实测有效（HTTP 400 参数错而非 401）。
#
# 动作：备份 plist → 从密码箱读 key 注入 EnvironmentVariables → bootout+bootstrap（kickstart 不重读 plist）→ 验证 health。
#
# ⚠️ 会断当前 3080 会话（包括跑在这个 GUI 里的 agent 会话），执行后重开页面/会话即可。
# 回滚：cp <备份文件> 回原名 → launchctl bootout + bootstrap（脚本每步打印备份路径）。
set -euo pipefail

PLIST="$HOME/Library/LaunchAgents/com.boss.dsh-bwm-web.plist"
VAULT="$HOME/曾添个人/AI学习总结文档/开发环境配置密码箱/环境配置密码总txt.txt"
LABEL="com.boss.dsh-bwm-web"
UID_N=$(id -u)

[ -f "$PLIST" ] || { echo "FAIL plist 不存在: $PLIST"; exit 1; }
[ -f "$VAULT" ] || { echo "FAIL 密码箱不存在: $VAULT"; exit 1; }

# 1. 从密码箱提取 MiMo key（锚定「#小米MiMo API密钥」段落，防止误取 deepseek/kimi 的 sk-；不回显）
KEY=$(awk '/#小米MiMo/{f=1; next} /^#/{f=0} f && /APIKEY/{print; exit}' "$VAULT" | grep -oE 'sk-[A-Za-z0-9._-]{20,}' | head -1)
[ -n "$KEY" ] || { echo "FAIL 密码箱未找到 MiMo key（#小米MiMo API密钥 段）"; exit 1; }
echo "key: ${KEY:0:6}****（长度 ${#KEY}）——仅注入 plist，不落其他位置"

# 2. 备份 plist
BAK="${PLIST}.bak-$(date +%Y%m%d-%H%M%S)"
cp "$PLIST" "$BAK"
echo "备份: $BAK"

# 3. 幂等注入（remove 容忍不存在 → insert → lint 校验，坏 plist 绝不 bootstrap）
plutil -remove EnvironmentVariables.XIAOMI_MIMO_API_KEY "$PLIST" 2>/dev/null || true
plutil -insert EnvironmentVariables.XIAOMI_MIMO_API_KEY -string "$KEY" "$PLIST"
plutil -lint "$PLIST" >/dev/null || { echo "FAIL plist 校验不过，回滚"; cp "$BAK" "$PLIST"; exit 1; }
echo "plist 注入完成（plutil -lint 通过）"

# 4. 重载服务（bootout 停守护 → bootstrap 按新 plist 拉起；kickstart 不会重读 plist）
launchctl bootout "gui/$UID_N/$LABEL" 2>/dev/null || true
sleep 2
launchctl bootstrap "gui/$UID_N" "$PLIST"
echo "服务已重载，等待 health…（3080 会话此刻已断属预期）"

# 5. 验证
OK=0
for i in {1..30}; do
  sleep 2
  H=$(curl -sf --max-time 5 "http://127.0.0.1:3080/bwm-friend/health" 2>/dev/null) || continue
  CFG=$(echo "$H" | /usr/bin/python3 -c "import json,sys;print(json.load(sys.stdin)['components']['voice']['configured'])" 2>/dev/null) || continue
  VER=$(echo "$H" | /usr/bin/python3 -c "import json,sys;print(json.load(sys.stdin)['version'])" 2>/dev/null)
  echo "health: version=$VER voice.configured=$CFG"
  if [ "$CFG" = "True" ] || [ "$CFG" = "true" ]; then OK=1; break; fi
done

[ "$OK" = "1" ] && echo "PASS 语音 key 已注入并生效——companion 页重开后再试长按说话" \
              || { echo "FAIL voice.configured 仍为 false——检查 key 段落与 plist"; exit 1; }
echo "回滚方式：cp '$BAK' '$PLIST' && launchctl bootout gui/$UID_N/$LABEL && launchctl bootstrap gui/$UID_N '$PLIST'"
