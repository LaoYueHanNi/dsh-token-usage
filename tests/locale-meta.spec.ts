/**
 * 包级本地化元数据契约：宿主 `dsh-app-boot` 经 `package.json` 的 exports 解析
 * `<包名>/locale/en.json` 作扫描锚点，再 `readdirSync` 同目录的整份词典集，把各
 * JSON 的 `meta.title` / `meta.description` 合成为 `{ en: <package.json 原值>, zh: … }`，
 * 前端再用 `dsh-client-locale` 的 `resolveText()` 按界面语言取值。
 *
 * 四个环节缺任何一个都是静默失效——宿主不报错，文案只是无声退回 `package.json`
 * 的英文原值：exports 白名单挡住子路径、files 漏掉目录、en.json 缺失让同目录的
 * zh.json 一并被忽略、zh.json 字段为空让宿主 `textOf()` 抛错。这里逐条钉住。
 */
import { readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'

const repoRoot = join(import.meta.dirname, '..')
const localeDir = join(repoRoot, 'locale')
const require = createRequire(join(repoRoot, 'smoke.cjs'))
const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
  name: string
  description: string
  exports: Record<string, string>
  files: string[]
}

/** 宿主 dsh-client-locale 接受的语言 id 形状（LOCALE_ID_PATTERN）。 */
const LOCALE_ID_PATTERN = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/u

/** 一份词典的 meta；字段存在时必须是宿主 textOf() 认可的非空字符串。 */
interface Meta {
  title?: string
  description?: string
}

const readMeta = (id: string): Meta =>
  JSON.parse(readFileSync(join(localeDir, `${id}.json`), 'utf8')).meta ?? {}

/**
 * 复刻宿主 localizedText()：以 en.json 为锚点扫描同目录词典集，en 沿用
 * package.json 原值，其余语言由各自的 meta 覆盖。
 */
const localizedText = (): Record<string, Meta> => {
  const text: Record<string, Meta> = {
    en: { title: pkg.name, description: pkg.description },
  }
  for (const file of readdirSync(localeDir).filter((f) => f.endsWith('.json'))) {
    const id = basename(file, '.json')
    if (!LOCALE_ID_PATTERN.test(id)) continue
    const meta = readMeta(id)
    if (meta.title) text[id] = { ...text[id], title: meta.title }
    if (meta.description) text[id] = { ...text[id], description: meta.description }
  }
  return text
}

/** dsh-client-locale 的浏览器半包是 esbuild IIFE，Node 下需 shim 出 window。 */
interface LocaleRuntime {
  setLocale: (id: string) => void
  resolveText: (text: Record<string, Meta>) => Meta
}
let LocaleRuntime!: new (ctx: unknown, host: undefined, bootstrap: undefined) => LocaleRuntime

beforeAll(() => {
  let namespace: Record<string, unknown> = {}
  ;(globalThis as Record<string, unknown>)['window'] = {
    __ModuleLoader__: {
      load: (module: { factory: (injectedRequire: (spec: string) => unknown) => unknown }) => {
        namespace = module.factory((spec) => {
          try {
            return require(spec)
          } catch {
            // 浏览器 UI 依赖在纯 Node 下不可达，LocaleRuntime 不碰它们。
            return {}
          }
        }) as Record<string, unknown>
      },
    },
  }
  require('@deepseek-ai/dsh-client-locale/client')
  LocaleRuntime = namespace['LocaleRuntime'] as new (
    ctx: unknown, host: undefined, bootstrap: undefined,
  ) => LocaleRuntime
})

describe('package locale metadata contract', () => {
  it('exports 放行 locale 词典子路径（宿主经 ModuleLoader 解析白名单）', () => {
    expect(pkg.exports['./locale/*.json']).toBe('./locale/*.json')
  })

  it('files 收录 locale 目录（否则 npm pack 漏掉词典）', () => {
    expect(pkg.files).toContain('locale')
  })

  it('en.json 存在且 meta 留空——它是目录扫描的锚点，缺失会让 zh.json 一并被忽略', () => {
    expect(readdirSync(localeDir)).toContain('en.json')
    expect(readMeta('en')).toEqual({})
  })

  it('zh.json 的两个字段都是非空字符串（空串会让宿主 textOf 抛错）', () => {
    const { title, description } = readMeta('zh')
    expect(typeof title).toBe('string')
    expect(title).not.toBe('')
    expect(typeof description).toBe('string')
    expect(description).not.toBe('')
  })

  it('词典文件名匹配宿主语言 id 形状（zh 而非 zh-CN）', () => {
    expect(readdirSync(localeDir).filter((f) => f.endsWith('.json')).map((f) => basename(f, '.json')))
      .toEqual(expect.arrayContaining(['en', 'zh']))
    for (const id of readdirSync(localeDir).map((f) => basename(f, '.json'))) {
      expect(LOCALE_ID_PATTERN.test(id)).toBe(true)
    }
  })
})

describe('localized display text', () => {
  it('扫描出的词典集含 zh，且文案未与英文原文拼接', () => {
    const text = localizedText()
    expect(Object.keys(text).sort()).toEqual(['en', 'zh'])
    expect(text['zh']?.description).toBe(readMeta('zh').description)
    expect(text['zh']?.description).not.toBe(pkg.description)
  })

  it('中文界面取到 zh 文案', () => {
    const runtime = new LocaleRuntime({ emit() {} }, undefined, undefined)
    runtime.setLocale('zh')
    const text = runtime.resolveText(localizedText())
    expect(text.title).toBe(readMeta('zh').title)
    expect(text.description).toBe(readMeta('zh').description)
  })

  it('英文界面回落到 package.json 原值（行为与接入前逐字相同）', () => {
    const runtime = new LocaleRuntime({ emit() {} }, undefined, undefined)
    runtime.setLocale('en')
    const text = runtime.resolveText(localizedText())
    expect(text.title).toBe(pkg.name)
    expect(text.description).toBe(pkg.description)
    expect(`${text.title} ${text.description}`).not.toMatch(/[\u4e00-\u9fa5]/u)
  })
})
