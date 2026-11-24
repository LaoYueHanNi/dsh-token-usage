/**
 * tsdown config for the browser client bundle (lib/client.js): the closure
 * factory artifact the web shell's module loader consumes. Mirrors the
 * harness's shared client preset — same banner/footer handoff, same
 * platform-module externals, same inlined CSS Modules — but standalone, so
 * this package builds itself without the harness monorepo. The node half is
 * built by tsc (`pnpm run build`); this config only emits the client bundle.
 */

import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { basename, dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { transform } from 'lightningcss'
import type { UserConfig } from 'tsdown'

const PACKAGE_DIR = dirname(fileURLToPath(import.meta.url))

/**
 * Plugin id stamped into the loader handoff and the injected style tags.
 * Derived from package.json so the bundle's registration id always equals
 * the installed package name — the web shell rejects a bundle whose
 * __ModuleLoader__.load id differs from the loader entry's package.
 */
const PLUGIN_ID: string = createRequire(import.meta.url)('./package.json').name

/**
 * The browser platform modules the web shell shares into its frozen module
 * table. The bundle resolves these through the loader's injected require
 * instead of inlining them (mirror of PLATFORM_MODULES in the harness web
 * shell); everything else is inlined.
 */
const PLATFORM_MODULES = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-attachment',
  '@deepseek-ai/dsh-client-schema-form',
] as const

/** Virtual-id wrapper keeping module CSS away from tsdown's own css pipeline. */
const CSS_VIRTUAL_PREFIX = '\0dsh-css:'
const CSS_VIRTUAL_SUFFIX = '.mjs'

interface CompiledStylesheet {
  readonly path: string
  readonly tagId: string
  readonly css: string
}

const compiledStyles = new Map<string, CompiledStylesheet>()

export default {
  name: `${PLUGIN_ID}/client`,
  entry: { client: 'src/client/index.ts' },
  // Browser bundle lands next to the node half (single lib/ artifact dir);
  // the entryFileNames pin keeps it exactly lib/client.js. clean stays off —
  // a default clean would wipe the tsc-emitted node half.
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  dts: false,
  sourcemap: true,
  clean: false,
  deps: {
    // Platform modules stay external: the loader's injected require answers
    // them from the module table.
    neverBundle: [...PLATFORM_MODULES],
    // Anything not in the module table must inline (the table cannot answer it).
    alwaysBundle: (id: string) => (PLATFORM_MODULES.includes(id) ? undefined : true),
  },
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
  },
  plugins: [{
    name: 'dsh-css-modules-inline',
    resolveId(source: string, importer: string | undefined) {
      if (!source.endsWith('.module.css')) return null
      const abs = importer !== undefined ? resolve(dirname(importer), source) : source
      return CSS_VIRTUAL_PREFIX + abs + CSS_VIRTUAL_SUFFIX
    },
    async load(virtualId: string) {
      if (!virtualId.startsWith(CSS_VIRTUAL_PREFIX)) return null
      const fileId = virtualId.slice(CSS_VIRTUAL_PREFIX.length, -CSS_VIRTUAL_SUFFIX.length)
      this.addWatchFile(fileId)
      const source = await readFile(fileId)
      const { code, exports: cssExports } = transform({
        filename: fileId,
        code: source,
        cssModules: { pattern: '[hash]_[local]' },
        minify: true,
      })
      const classMap: Record<string, string> = {}
      // Sort deterministically: lightningcss returns exports in a per-run
      // order, which would make every rebuild churn lib/client.js.
      for (const [local, exp] of Object.entries(cssExports ?? {})
        .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
        classMap[local] = exp.name
      }
      const relPath = relative(PACKAGE_DIR, fileId).replace(/\\/g, '/')
      const tagId = `${PLUGIN_ID}/${basename(fileId)}`
      compiledStyles.set(virtualId, { path: relPath, tagId, css: code.toString() })
      return {
        code: `export default ${JSON.stringify(classMap)};`,
        moduleSideEffects: 'no-treeshake' as const,
      }
    },
  }],
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load((() => { const __dsh_id = ${JSON.stringify(PLUGIN_ID)}; let __dsh_meta_used = false; const __dsh_factory = (require) => {`,
    footer(chunk: { modules: Record<string, unknown> }) {
      const entries: CompiledStylesheet[] = []
      for (const moduleId of Object.keys(chunk.modules)) {
        const sheet = compiledStyles.get(moduleId)
        if (sheet !== undefined) entries.push(sheet)
      }
      entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
      const serialized = JSON.stringify(entries.map(e => [e.path, e.tagId, e.css]))
      return `const __dsh_exports = module.exports; const __dsh_result = (__dsh_exports && typeof __dsh_exports.apply === 'function') ? Object.assign({}, __dsh_exports, { apply(ctx, config) { if (!__dsh_meta_used && typeof document !== 'undefined' && ctx && typeof ctx.effect === 'function') { ctx.effect(() => { if (__dsh_meta_used) return () => {}; const mounted = []; for (const [, tagId, css] of __dsh_sheets) { if (document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') === null) { const tag = document.createElement('style'); tag.dataset.plugin = __dsh_id; tag.dataset.pluginCss = tagId; tag.textContent = css; document.head.appendChild(tag); mounted.push(tag); } } return () => { for (const tag of mounted) tag.remove(); }; }, 'token-usage: fallback stylesheets'); } return __dsh_exports.apply.call(this, ctx, config); } }) : __dsh_exports; return __dsh_result; }; const __dsh_sheets = ${serialized}; const __dsh_remove_fallback = () => { if (typeof document === 'undefined') return; for (const [, tagId] of __dsh_sheets) { const el = document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']'); if (el) el.remove(); } }; return { id: __dsh_id, meta: () => { __dsh_meta_used = true; __dsh_remove_fallback(); const stylesheets = {}; for (const [path, , css] of __dsh_sheets) stylesheets[path] = { text: () => css }; return { stylesheets }; }, factory: __dsh_factory }; })());`
    },
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
} satisfies UserConfig
