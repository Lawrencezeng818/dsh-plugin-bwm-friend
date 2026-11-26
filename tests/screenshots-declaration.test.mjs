/**
 * 市场截图声明自检（0.8.51 建）
 *
 * 约束抄自 awesome-dsh-plugin 三条硬规则（contributing.md §Screenshots +
 * scripts/build-site.mjs::SCREENSHOT_HOSTS + scripts/probe-screenshots.mjs）：
 *   1. 声明文件放在 package.json 旁，列出 1–8 张图；
 *   2. 路径相对该文件解析（写死绝对 raw URL 会静默烂成 404——上游 773 张里有 41 张如此）；
 *   3. 若写绝对 URL，只接受 GitHub 自家托管。
 *
 * 另加两条本地约束（上游不查、但会真的坏）：
 *   4. 引用的文件必须在本仓库里存在（上游探测到 404 只会静默剔除该图）；
 *   5. 单张 ≤ 1.5MB，避免市场详情页拖着 3MB 图走。
 *
 * 运行：node --test tests/screenshots-declaration.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert'
import { readFileSync, existsSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const FILE = join(ROOT, 'screenshots.json')
const GITHUB_HOSTS = new Set(['raw.githubusercontent.com', 'user-images.githubusercontent.com', 'camo.githubusercontent.com', 'github.com'])
const EXT = ['.png', '.jpg', '.jpeg', '.webp']
const MAX_ITEMS = 8
const MAX_BYTES = 1_500_000

function load() {
  const raw = JSON.parse(readFileSync(FILE, 'utf8'))
  const list = Array.isArray(raw) ? raw : raw.screenshots
  assert.ok(Array.isArray(list), 'screenshots.json 必须是数组或 {"screenshots": [...]}')
  return list
}

test('声明存在且为 1–8 条字符串', () => {
  assert.ok(existsSync(FILE), 'screenshots.json 必须在 package.json 同级')
  const list = load()
  assert.ok(list.length >= 1 && list.length <= MAX_ITEMS, `条数须 1–${MAX_ITEMS}，实际 ${list.length}`)
  for (const s of list) assert.strictEqual(typeof s, 'string', '每一条都必须是字符串')
})

test('每条要么是本仓库内存在的相对路径，要么是 GitHub 托管的 https 绝对 URL', () => {
  for (const s of load()) {
    if (/^https?:\/\//i.test(s)) {
      const u = new URL(s)
      assert.strictEqual(u.protocol, 'https:', `绝对 URL 必须 https：${s}`)
      assert.ok(GITHUB_HOSTS.has(u.hostname), `绝对 URL 只允许 GitHub 托管（防追踪像素）：${s}`)
      continue
    }
    assert.ok(!s.startsWith('/'), `必须写相对路径，不能以 / 开头：${s}`)
    const abs = resolve(ROOT, s)
    assert.ok(abs.startsWith(resolve(ROOT) + '/'), `路径越出仓库：${s}`)
    assert.ok(existsSync(abs), `引用的文件不存在（上游探测到 404 会静默剔除）：${s}`)
    assert.ok(EXT.some((e) => s.toLowerCase().endsWith(e)), `扩展名须为 ${EXT.join('/')}：${s}`)
    const size = statSync(abs).size
    assert.ok(size <= MAX_BYTES, `单张过大 ${Math.round(size / 1024)}KB > 1500KB：${s}`)
  }
})

test('文件名带序号，保证市场里的展示顺序稳定', () => {
  const rel = load().filter((s) => !/^https?:/i.test(s))
  rel.forEach((s, i) => {
    const base = s.split('/').pop()
    assert.ok(/^\d{2}-/.test(base), `第 ${i + 1} 张建议以两位序号开头（现状：${base}）`)
  })
})

test('首图不得是大片白底（市场卡片首图决定点不点进来）', () => {
  const first = load()[0]
  if (/^https?:/i.test(first)) return // 绝对路径是别家托管，本地无从判断，跳过
  const abs = resolve(ROOT, first)
  // 近白像素占比。0.8.52 前首图是 work 页（DSH 原生白底工作台）实测 34.3%，
  // 缩略图里就是一大片白；深色陪伴图 0%。阈值取 12%：留合理边距，仍能拦住旧图。
  const py = `from PIL import Image
import sys
im = Image.open(sys.argv[1]).convert('RGB').resize((160,100))
px = list(im.getdata())
w = sum(1 for r,g,b in px if r>235 and g>235 and b>235)
print(round(w/len(px)*100,2))`
  const pct = parseFloat(execFileSync('python3', ['-c', py, abs], { encoding: 'utf8' }).trim())
  assert.ok(pct < 12, `首图近白像素 ${pct}% ≥ 12%（白底工作台会毁掉市场缩略图），请换深色图`)
})
