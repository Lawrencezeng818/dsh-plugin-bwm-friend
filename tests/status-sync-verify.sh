#!/bin/bash
# ═══════════════════════════════════════════════════════════════
# tests/status-sync-verify.sh — BWM Friend 设置状态同步回归自检
# （T1-T14：主题高亮/标签/音色回显/垃圾卡/点击热切联动 + 模板⇒音色预设联动
#   + 按主题人格 personas 读写，boss-bug-hunt Step2/4）
#
# 用法: tests/status-sync-verify.sh [lib/index.js 路径]
#   缺省测当前工作树；传 /tmp/bwm-pre-lib.js 可对修复前代码复现红灯。#
# 隔离：HOME 指向临时目录（配置写 ~/.dsh-bwm-friend 不碰真实配置），
#       预置 config：theme=电竞男孩、voice=冰糖、personas={电竞男孩:电竞人格X}。
# ═══════════════════════════════════════════════════════════════
set -uo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
LIB="${1:-$REPO/lib/index.js}"
CHROME="${AGENT_BROWSER_EXECUTABLE_PATH:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
[ -f "$LIB" ] || { echo "FAIL 找不到 $LIB"; exit 1; }
PORT=$(( 8090 + RANDOM % 40 ))

TMP=$(mktemp -d /tmp/bwm-sync-verify.XXXX)
mkdir -p "$TMP/home/.dsh-bwm-friend"
cat > "$TMP/home/.dsh-bwm-friend/config.json" <<'EOF'
{"version":1,"account":{"subject":null,"loggedIn":false},"avatar":{"theme":"电竞男孩","idle":null,"persona":"","personas":{"电竞男孩":"电竞人格X"},"driver":"video"},"voice":{"voice":"冰糖","volume":1},"llm":{"provider":"local","baseUrl":"","model":"deepseek-chat"},"ui":{"mode":"work","type":"stage","chatWidth":720},"power":{"pauseOnBlur":true}}
EOF
# 变体 lib 必须放在 lib/ 同层：模块内有 '../packages/...' 相对导入（开发同仓依赖）
VLIB="$REPO/lib/.verify-variant.js"
cp "$LIB" "$VLIB"
trap 'kill $SRV_PID 2>/dev/null; wait $SRV_PID 2>/dev/null; rm -rf "$TMP" "$VLIB"' EXIT

# 素材根环境化（2026-09-03 打包 P0 后代码不再硬编码个人路径）：本机自动发现默认素材，
# 异机用 BWM_ASSET_ROOTS 覆盖（T1/T8/T11 依赖真实主题资产）
if [ -z "${BWM_ASSET_ROOTS:-}" ] && [ -d "$HOME/projects/bwm-electron/app_runtime/heygem-data/input" ]; then
  export BWM_ASSET_ROOTS="$HOME/projects/bwm-electron/app_runtime/heygem-data/input"
fi
HOME="$TMP/home" node "$REPO/tests/verify-shim.mjs" "$VLIB" "$PORT" > "$TMP/shim.log" 2>&1 &
SRV_PID=$!
# 服务就绪（真实 curl 探活）
n=0
while ! curl -s -o /dev/null "http://127.0.0.1:$PORT/bwm-friend/health" 2>/dev/null; do
  sleep 0.3; n=$((n+1)); [ $n -gt 50 ] && { echo "FAIL shim 未启动"; cat "$TMP/shim.log"; exit 1; }
done

# headless Chrome 真实渲染驱动页（安全收尾：只杀自己 PID）
"$CHROME" --headless=new --disable-gpu --hide-scrollbars \
  --password-store=basic --use-mock-keychain \
  --user-data-dir="$(mktemp -d -t chrome-bwmverify)" \
  --window-size=1600,1000 --virtual-time-budget=30000 \
  --dump-dom "http://127.0.0.1:$PORT/__verify" > "$TMP/dom.html" 2>/dev/null &
CPID=$!; n=0
while kill -0 "$CPID" 2>/dev/null && [ $n -lt 60 ]; do sleep 1; n=$((n+1)); done
kill "$CPID" 2>/dev/null; wait "$CPID" 2>/dev/null

echo "── 状态同步断言（隔离 HOME · 真实路由 · lib=$(basename "$LIB")）──"
# 只取 <pre id="out"> 结果块（驱动页脚本源码同样含 PASS/FAIL 字样，必须避开）
sed -n '/<pre id="out">/,/<\/pre>/p' "$TMP/dom.html" \
  | grep -oE '(PASS|FAIL) T[0-9][^<]*|DONE|FAIL exception[^<]*' | sed 's/[[:space:]]*$//'
# verdict 以 <title> 为准（pre 块之外的源码字面量不再干扰）
grep -o '<title>SYNC-[^<]*</title>' "$TMP/dom.html" | head -1
if grep -q '<title>SYNC-ALL-PASS</title>' "$TMP/dom.html"; then echo "✅ ALL PASS"; exit 0
else echo "❌ HAS FAIL"; exit 1; fi
