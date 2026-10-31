import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { providerLabel, ProviderNameStore } from '../src/provider-names.ts'

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'token-usage-providers-'))
}

describe('ProviderNameStore', () => {
  it('keeps the latest name and never deletes a route that left the directory', async () => {
    const dir = await tempDir()
    const store = new ProviderNameStore(dir)
    await store.upsert({ 'deepseek-official': 'DeepSeek', 'zai-coding-cn': 'Z.ai' })
    await store.upsert({ 'deepseek-official': 'DeepSeek Official' })
    expect(await store.read()).toEqual({
      'deepseek-official': 'DeepSeek Official',
      'zai-coding-cn': 'Z.ai',
    })
    expect(providerLabel('zai-coding-cn', await store.read())).toBe('Z.ai')
    expect(providerLabel('gone', await store.read())).toBe('gone')
  })

  it('ignores empty keys and empty names and skips a no-op rewrite', async () => {
    const dir = await tempDir()
    const store = new ProviderNameStore(dir)
    await store.upsert({ '': 'x', 'deepseek-official': '' })
    await expect(readFile(join(dir, 'providers.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    await store.upsert({ 'deepseek-official': 'DeepSeek' })
    const before = await readFile(join(dir, 'providers.json'), 'utf8')
    await store.upsert({ 'deepseek-official': 'DeepSeek' })
    expect(await readFile(join(dir, 'providers.json'), 'utf8')).toBe(before)
  })

  it('never overwrites a registry it cannot read back', async () => {
    const dir = await tempDir()
    const store = new ProviderNameStore(dir)
    // A registry that lost its shape (a torn write, a hand edit) must not
    // be replaced by the incoming patch alone: the display names it still
    // holds are not recoverable from the session logs.
    await writeFile(join(dir, 'providers.json'), '{"deepseek-official": "DeepSeek"', 'utf8')
    await store.upsert({ 'zai-coding-cn': 'Z.ai' })
    expect(await readFile(join(dir, 'providers.json'), 'utf8')).toBe('{"deepseek-official": "DeepSeek"')
    // The read path still serves what it can, so the page degrades to the
    // raw route keys instead of failing.
    expect(await store.read()).toEqual({})
  })

  it('writes over a registry it can read back', async () => {
    const dir = await tempDir()
    const store = new ProviderNameStore(dir)
    await store.upsert({ 'deepseek-official': 'DeepSeek' })
    await store.upsert({ 'zai-coding-cn': 'Z.ai' })
    expect(await store.read()).toEqual({
      'deepseek-official': 'DeepSeek',
      'zai-coding-cn': 'Z.ai',
    })
  })
})
