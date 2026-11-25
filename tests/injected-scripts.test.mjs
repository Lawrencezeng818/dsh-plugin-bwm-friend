/**
 * 注入脚本护栏（0.8.51 建）
 *
 * 起因（实证，非假设）：lib/index.js 以模板字面量携带要在浏览器里执行的脚本，
 * 0.8.48 在其中写 `].join('\n')`。模板里的 `\n` 被引擎转义成**真实换行**，
 * 浏览器收到的是 `].join('` + 换行 + `')` —— work-chat.js 整个文件语法错误，
 * 干活模式自 0.8.48 起全部交互失效（设置按钮点不动、聊天不响应），
 * 三个版本未发现。同一文件里另两处写的是 `\\n` 才是对的。
 *
 * 本测试把「源码里的模板」按 JS 规则还原成「浏览器真正收到的字符串」，
 * 再要求它自身可解析。写错一处 `\n` 即红，不必起宿主、不必开浏览器。
 *
 * 运行：node --test tests/injected-scripts.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = readFileSync(join(ROOT, 'lib', 'index.js'), 'utf8')

/** 浏览器端脚本载体：改这里等于改 syntax gate 的覆盖面 */
const INJECTED = ['DESKTOP_SHIM_JS', 'COMPANION_CHAT_JS', 'WORK_INIT_JS', 'WORK_CHAT_JS']

/**
 * 取出模板字面量的**运行时**取值：先按转义规则切出原文，再交给引擎求值。
 * 求值而非手工替换，是因为要复现的正是引擎的转义行为本身。
 */
function runtimeTemplate(src, name) {
  const decl = `const ${name} = \``
  const at = src.indexOf(decl)
  assert.notStrictEqual(at, -1, `${name} 的定义找不到（改名后请同步本测试）`)
  let i = at + decl.length
  let raw = ''
  while (i < src.length) {
    const ch = src[i]
    if (ch === '\\') { raw += src.slice(i, i + 2); i += 2; continue }
    if (ch === '`') break
    raw += ch
    i += 1
  }
  assert.ok(i < src.length, `${name} 的反引号未闭合`)
  // 这几个模板都不含 ${} 插值（有插值则此处会抛错，正好暴露新增的插值点）
  return new Function('return `' + raw + '`')()
}

test('注入脚本：模板里不含插值（否则运行期行为依赖外部变量）', () => {
  for (const name of INJECTED) {
    const decl = `const ${name} = \``
    const at = SRC.indexOf(decl)
    const seg = SRC.slice(at, at + 40000)
    const body = seg.slice(0, seg.indexOf('\n`;') + 3)
    assert.ok(!body.includes('${'), `${name} 出现 ${'${}'} 插值，请改用显式拼接`)
  }
})

for (const name of INJECTED) {
  test(`注入脚本 ${name} 注入浏览器后必须语法正确`, () => {
    const code = runtimeTemplate(SRC, name)
    assert.doesNotThrow(
      () => new Function(code),
      `${name} 注入后无法解析——最常见原因是模板里的 \\n/\\t 被引擎转义成真控制字符，应写 \\\\n`,
    )
  })
}

test('陪伴门禁不得在 work 页整页拦截（0.8.51 修：门禁文案只约束陪伴模式）', () => {
  const code = runtimeTemplate(SRC, 'COMPANION_CHAT_JS')
  const at = code.indexOf('function initGate')
  assert.notStrictEqual(at, -1, 'initGate 不存在')
  const body = code.slice(at, at + 900)
  const guard = body.indexOf("data-bwm-mode")
  const probe = body.indexOf("auth/status")
  assert.ok(guard !== -1, 'initGate 必须按 data-bwm-mode 分流')
  assert.ok(probe !== -1, 'initGate 必须仍查登录状态')
  assert.ok(guard < probe, 'work 判断必须发生在查询登录状态之前（提前 return）')
})
