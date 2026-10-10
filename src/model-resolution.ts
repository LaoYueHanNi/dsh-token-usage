import type { ModelResolution } from './wire.ts'

export interface ModelIdentity {
  modelId: string
  aliases?: readonly string[]
  aliasPatterns?: readonly string[]
}

/** Full-name comparison only: spelling remains intact in records and displays. */
export const modelKey = (name: string): string => name.toLowerCase()

export function providerSuffix(name: string): string | undefined {
  const parts = name.split('/')
  return parts.length > 1 && parts.every(part => part !== '') ? parts.at(-1) : undefined
}

/** Parse the upstream portable subset rather than accepting arbitrary JS regex. */
export function compileAliasPattern(pattern: string): RegExp {
  if (!pattern.startsWith('^') || !pattern.endsWith('$')) throw new Error('alias pattern requires ^ and $')
  const body = pattern.slice(1, -1)
  let offset = 0
  function expression(depth: number): void {
    if (depth > 32) throw new Error('alias pattern nesting is too deep')
    let atoms = 0
    while (offset < body.length && body[offset] !== ')') {
      const char = body[offset++]!
      if (char === '|') {
        if (atoms === 0) throw new Error('empty alias pattern branch')
        atoms = 0
        continue
      }
      if (char === '(') {
        expression(depth + 1)
        if (body[offset++] !== ')') throw new Error('unclosed alias pattern group')
      } else if (char === '\\') {
        const literal = body[offset++]
        if (literal === undefined || /[A-Za-z0-9\s]/.test(literal)) throw new Error('alias patterns allow escaped punctuation only')
      } else if (!/[A-Za-z0-9_/-]/.test(char)) {
        throw new Error('unsupported alias pattern syntax')
      }
      atoms++
      if (body[offset] === '?') offset++
    }
    if (atoms === 0) throw new Error('empty alias pattern branch')
  }
  expression(0)
  if (offset !== body.length) throw new Error('unbalanced alias pattern group')
  return new RegExp(pattern, 'i')
}

export function validateModelIdentities(models: readonly ModelIdentity[]): void {
  const ids = new Set<string>()
  for (const model of models) {
    const key = modelKey(model.modelId)
    if (ids.has(key)) throw new Error(`duplicate modelId: ${model.modelId}`)
    ids.add(key)
    const patterns = model.aliasPatterns ?? []
    if (new Set(patterns).size !== patterns.length) throw new Error(`duplicate aliasPatterns: ${model.modelId}`)
    for (const pattern of patterns) compileAliasPattern(pattern)
  }
}

export function createModelResolver(models: readonly ModelIdentity[]): (name: string) => ModelResolution {
  validateModelIdentities(models)
  const ids = new Map<string, Set<string>>()
  const aliases = new Map<string, Set<string>>()
  const patterns: Array<{ modelId: string; regex: RegExp }> = []
  const add = (index: Map<string, Set<string>>, name: string, id: string): void => {
    const key = modelKey(name)
    const hits = index.get(key) ?? new Set<string>()
    hits.add(id)
    index.set(key, hits)
  }
  for (const model of models) {
    add(ids, model.modelId, model.modelId)
    for (const alias of model.aliases ?? []) if (alias !== '') add(aliases, alias, model.modelId)
    for (const pattern of model.aliasPatterns ?? []) patterns.push({ modelId: model.modelId, regex: compileAliasPattern(pattern) })
  }
  const cache = new Map<string, ModelResolution>()
  return (rawName): ModelResolution => {
    const cached = cache.get(rawName)
    if (cached !== undefined) return cached
    const suffix = providerSuffix(rawName)
    const resultOf = (hits: Set<string>, method: NonNullable<ModelResolution['method']>, strippedPrefix: boolean): ModelResolution => {
      const candidates = [...hits].sort()
      return candidates.length === 1
        ? { rawName, status: 'matched', modelId: candidates[0]!, method, strippedPrefix, candidates: [] }
        : { rawName, status: 'ambiguous', method, strippedPrefix, candidates }
    }
    let result: ModelResolution | undefined
    for (const [candidate, normalized] of [[rawName, false], ...(suffix === undefined ? [] : [[suffix, true]])] as Array<[string, boolean]>) {
      const idHits = ids.get(modelKey(candidate))
      const aliasHits = aliases.get(modelKey(candidate))
      if (idHits !== undefined) result = resultOf(idHits, normalized ? 'normalized-id' : 'id', normalized)
      else if (aliasHits !== undefined) result = resultOf(aliasHits, normalized ? 'normalized-alias' : 'alias', normalized)
      if (result !== undefined) break
    }
    if (result === undefined && rawName !== '') {
      const hits = new Set<string>()
      let strippedPrefix = false
      for (const { modelId, regex } of patterns) {
        for (const candidate of suffix === undefined ? [rawName] : [rawName, suffix]) {
          const match = regex.exec(candidate)
          if (match !== null && match.index === 0 && match[0].length === candidate.length) {
            hits.add(modelId)
            if (candidate !== rawName) strippedPrefix = true
          }
        }
      }
      if (hits.size > 0) result = resultOf(hits, 'pattern', strippedPrefix)
    }
    result ??= { rawName, status: 'unmatched', strippedPrefix: false, candidates: [] }
    cache.set(rawName, result)
    return result
  }
}
