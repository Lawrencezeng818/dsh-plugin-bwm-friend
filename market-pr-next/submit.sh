#!/usr/bin/env bash
# 第二批市场条目 PR：加 icon + 描述 skin→shell。
#
# 为什么单独一批、且必须等 #18604 合并后才跑：
#   两个 PR 改的是同一条 description 行，同时开着必然冲突。#18604 只做「删安全注记」
#   一件事，本批做「改词 + 加 icon」，分开才能让评审各自看懂。
#
# 用法：./submit.sh
# 退出码：0 = PR 已创建；78 = #18604 尚未合并（未就绪，稍后重跑）；其他 = 出错
set -euo pipefail

VAULT="/Users/zengtian/曾添个人/AI学习总结文档/开发环境配置密码箱/环境配置密码总txt.txt"
UP="awesome-dsh-plugin/awesome-dsh-plugin"
FORK="Lawrencezeng818/awesome-dsh-plugin"
BRANCH="entry-icon-and-shell-wording"
ENTRY="data/plugins/Lawrencezeng818__dsh-plugin-bwm-friend.yml"
WORK="/tmp/adp-next"
HERE="$(cd "$(dirname "$0")" && pwd)"

TOKEN=$(grep -A1 '### GitHub 个人访问令牌' "${VAULT}" 2>/dev/null | grep '本体值' | sed 's/.*：//' | tr -d ' \r\n')
if [ -z "${TOKEN}" ]; then echo "PR_ERROR 取不到 GitHub token"; exit 1; fi

api_get() {
  curl -s -H "Authorization: Bearer ${TOKEN}" -H "Accept: application/vnd.github+json" \
    "https://api.github.com$1"
}

echo "== 1/6 前置闸门：#18604 是否已合并（看 main 上那句注记还在不在） =="
CUR=$(api_get "/repos/${UP}/contents/${ENTRY}?ref=main" | python3 -c "
import sys,json,base64
d=json.load(sys.stdin)
print(base64.b64decode(d['content']).decode() if d.get('content') else '')
")
if printf '%s' "${CUR}" | grep -q "no DSH access check"; then
  echo "NOT_READY  #18604 还没合并，main 上仍带安全注记。"
  echo "           本批改的是同一条 description 行，现在发必冲突。等它合并后重跑本脚本。"
  exit 78
fi
echo "OK  上游条目已无注记，可以在这条基础上改词。"

echo "== 2/6 浅克隆上游 main =="
rm -rf "${WORK}"
git clone -q --depth 1 --single-branch --branch main "https://github.com/${UP}.git" "${WORK}"
cd "${WORK}"
git checkout -q -b "${BRANCH}"
echo "   HEAD $(git log -1 --format='%h %s' | cut -c1-70)"

echo "== 3/6 写入目标条目 =="
cp "${HERE}/Lawrencezeng818__dsh-plugin-bwm-friend.yml" "${ENTRY}"

echo "== 4/6 diff 守卫：只允许 description 两行 + 新增 icon 一行 =="
git -c core.quotepath=false diff -- "${ENTRY}" | sed -n '5,40p'
STAT=$(git -c core.quotepath=false diff --numstat -- "${ENTRY}" | awk '{print $1" "$2}')
ADD=$(echo "${STAT}" | cut -d' ' -f1); DEL=$(echo "${STAT}" | cut -d' ' -f2)
FILES=$(git -c core.quotepath=false diff --name-only | wc -l | tr -d ' ')
if [ "${FILES}" != "1" ] || [ "${ADD}" != "2" ] || [ "${DEL}" != "1" ]; then
  echo "PR_ERROR diff 形状不符预期（files=${FILES} +${ADD}/-${DEL}，期望 1 个文件 +2/-1：en 行改 skin→shell，新增 icon 行）。已停手，请人工看上面的 diff。"
  exit 1
fi
echo "   形状正确：1 个文件 +${ADD}/-${DEL}"

echo "== 5/6 提交并用 SSH 推送（token 缺 workflow scope，走 SSH 才通） =="
git add "${ENTRY}"
git -c core.quotepath=false commit -q -F - <<'MSG'
Add storefront icon; say shell, not skin (category stays ui)

Two wording/tile corrections to the same entry, deliberately kept out of
#18604 so that PR stays a one-line change.

skin -> shell: the description called this a workbench "skin" while the entry
is filed under ui, and contributing.md asks skins to go under Themes &
Appearance. The plugin does not restyle the DSH UI — it embeds the native
conversation view unchanged and adds a separate page with its own routes, so
ui is the right category and the wording was the wrong half of the pair. The
Chinese line already said 外壳.

icon: a square 512x512 PNG at assets/icon-512.png, built from the project's
existing 108px brand mark by upscaling (Lanczos, RGB-only sharpen). Not
redrawn — a regenerated tile moves the gem outline and the starfield.

Moving to theme instead was considered and rejected: dsh-market keeps exactly
one theme active, so a plugin with working routes there is disabled whenever
the user switches themes.
MSG
git push git@github.com:${FORK}.git HEAD:refs/heads/${BRANCH} 2>&1 | tail -3

echo "== 6/6 创建 PR =="
python3 - "${TOKEN}" "${HERE}/PR_BODY.md" "${BRANCH}" > /tmp/adp-next-pr.json <<'PY'
import json,sys
tok,bodyf,branch=sys.argv[1],sys.argv[2],sys.argv[3]
print(json.dumps({
 "title":"Add storefront icon, and say shell rather than skin (category stays ui)",
 "head":"Lawrencezeng818:"+branch,
 "base":"main",
 "body":open(bodyf,encoding='utf-8').read(),
 "maintainer_can_modify":True,
},ensure_ascii=False))
PY
curl -s -X POST -H "Authorization: Bearer ${TOKEN}" -H "Accept: application/vnd.github+json" \
  -H "Content-Type: application/json" -d @/tmp/adp-next-pr.json \
  "https://api.github.com/repos/${UP}/pulls" | python3 -c "
import sys,json
d=json.load(sys.stdin)
if d.get('number'):
    print('PR_CREATED  #%s  %s' % (d['number'], d['html_url']))
    print('            changed_files=%s +%s/-%s' % (d['changed_files'], d['additions'], d['deletions']))
else:
    msgs=[e.get('message') for e in d.get('errors',[])]
    print('PR_ERROR   %s %s' % (d.get('message'), msgs))
"
