#!/usr/bin/env node
/**
 * Repair legacy v0 sessions poisoned by the transient development-branch
 * `origin` member in `permission/preset` event payloads.
 *
 * Between 2026-08-19 and 2026-08-21 the harness mainline briefly shipped a
 * `permission/preset` payload carrying a non-released `"origin"` member
 * (commit 35778ec2ff, fully reverted in 7ce85283b5 before release). Sessions
 * created by local dev-branch builds in that window hold
 * `{"preset":"workspace-write","origin":"default"}` as an early event, and the
 * strict official migration `@deepseek-ai/dsh-session-format-v0-to-v1`
 * refuses the file with:
 *
 *   refuses this format v0 Session: permission/preset N data has unexpected member "origin"
 *
 * This script removes ONLY that `origin` member from `permission/preset` data
 * objects — never any conversation content, tool call, or token accounting —
 * keeps every untouched JSONL record byte-for-byte, preserves the original
 * frame layout, and validates the rewritten file through the official
 * `sessionFormatCatalog.createRestore` v0→v1→v2→v3 migration chain.
 *
 * Modes:
 *   (default)          scan — enumerate and classify sessions, no writes
 *   --repair           backup (.bak) + clean + rewrite + post-verify (writes)
 *   --verify           official restore validation of every active generation (read-only)
 *
 * Options:
 *   --root <dir>           sessions root (default: ~/.dsh/sessions)
 *   --harness-root <dir>   harness checkout providing the format catalog
 *                          (default: $DSH_HARNESS_ROOT or D:\Code\deepseek-harness)
 *   --force                repair even when a .bak backup already exists or a
 *                          target file was modified within the last 10 minutes
 *
 * Run with the harness (host) shut down: a concurrent writer on a target file
 * is the one thing the .bak backup cannot reconcile. See the decision record
 * `2026-09-19-repair-legacy-v0-origin-sessions` under docs/decisions/.
 */

import { constants as zlibConstants, zstdCompress as zstdCompressCb, zstdDecompress as zstdDecompressCb } from 'node:zlib'
import { copyFile, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const zstdCompress = promisify(zstdCompressCb)
const zstdDecompress = promisify(zstdDecompressCb)

const ZSTD_MAGIC = 0xFD2FB528
/** Canonical session generation log basename, versioned (`session.vN.jsonl`) or v0 (`session.jsonl`). */
const CANONICAL_LOG_NAME = /^session(?:\.v([1-9][0-9]*))?\.jsonl(\.zstd)?$/
/** A target file touched this recently suggests a live host writer. */
const RECENT_WRITE_MS = 10 * 60 * 1000

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const args = process.argv.slice(2)
const mode = args.includes('--repair') ? 'repair' : args.includes('--verify') ? 'verify' : 'scan'
function flagValue(name) {
  const prefix = `${name}=`
  const inline = args.find(arg => arg.startsWith(prefix))
  if (inline !== undefined) return inline.slice(prefix.length)
  const index = args.indexOf(name)
  return index !== -1 && index + 1 < args.length && !args[index + 1].startsWith('--') ? args[index + 1] : undefined
}
for (const arg of args) {
  if (arg === '--repair' || arg === '--verify' || arg === '--force') continue
  if (arg === '--root' || arg === '--harness-root') continue
  if (arg.startsWith('--root=') || arg.startsWith('--harness-root=')) continue
  if (arg === flagValue('--root') || arg === flagValue('--harness-root')) continue
  console.error(`未知参数：${arg}`)
  console.error('用法：node scripts/repair-v0-origin-sessions.mjs [--repair|--verify] [--root <dir>] [--harness-root <dir>] [--force]')
  process.exit(2)
}
const force = args.includes('--force')
const root = flagValue('--root') ?? join(homedir(), '.dsh', 'sessions')
const harnessRoot = flagValue('--harness-root') ?? process.env.DSH_HARNESS_ROOT ?? 'D:\\Code\\deepseek-harness'

// ---------------------------------------------------------------------------
// Official format catalog (from the harness checkout; the validator of record)
// ---------------------------------------------------------------------------

const catalogEntry = join(harnessRoot, 'packages', 'session', 'session-format-catalog', 'lib', 'index.js')
if (!existsSync(catalogEntry)) {
  console.error(`未找到官方格式目录构建产物：${catalogEntry}`)
  console.error('请通过 --harness-root <dir> 或环境变量 DSH_HARNESS_ROOT 指向 deepseek-harness 检出目录。')
  process.exit(2)
}
const { sessionFormatCatalog } = await import(pathToFileURL(catalogEntry).href)

// ---------------------------------------------------------------------------
// Zstandard frame primitives (port of dsh-session-persistence-jsonl/src/zstd.ts)
// ---------------------------------------------------------------------------

/** Locate complete frames without decompressing their blocks; EOF mid-frame returns its start. */
function scanZstdFrames(buffer) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) return { frames, tornStart: start }
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new Error(`corrupt Zstandard session log: invalid frame magic at byte ${offset}`)
    }
    offset += 4
    if (offset === buffer.length) return { frames, tornStart: start }
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    if ((descriptor & 0x18) !== 0) {
      throw new Error(`corrupt Zstandard session log: reserved frame-header bit at byte ${offset - 1}`)
    }
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 0x20) !== 0
    const checksum = (descriptor & 0x04) !== 0
    const dictionaryFlag = descriptor & 0x03
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start }
    offset += remainingHeaderBytes
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start }
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 0x03
      const blockSize = blockHeader >>> 3
      if (blockType === 0x03) {
        throw new Error(`corrupt Zstandard session log: reserved block type at byte ${offset - 3}`)
      }
      const payloadBytes = blockType === 0x01 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start }
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start }
      offset += 4
    }
    frames.push({ start, end: offset })
  }
  return { frames }
}

/** One frame = one JSONL batch; the first frame is exactly the header line. */
async function decodeFrame(batch, start, end, label) {
  try {
    return await zstdDecompress(batch.subarray(start, end))
  } catch (error) {
    throw new Error(`${label}: frame at byte ${start} failed validation`, { cause: error })
  }
}

/** One checksummed, independently decodable frame, matching the host writer. */
function compressFrame(text) {
  return zstdCompress(Buffer.from(text, 'utf8'), {
    params: { [zlibConstants.ZSTD_c_checksumFlag]: 1 },
  })
}

// ---------------------------------------------------------------------------
// Physical artifact reading (mirrors the official read path)
// ---------------------------------------------------------------------------

function splitBodyRecords(text, label) {
  if (!text.endsWith('\n')) throw new Error(`${label}: complete frames end inside a JSONL record (torn tail)`)
  const lines = text.split('\n')
  lines.pop()
  return lines
}

/**
 * Load one canonical generation file into header + raw body lines + parsed
 * records, with the record count of each body frame kept for a
 * layout-preserving rewrite. Frame 0 must be exactly one header line
 * (official `assertIndependentHeaderFrame`).
 */
async function loadGenerationFile(path) {
  const label = path
  const name = basename(path)
  const match = CANONICAL_LOG_NAME.exec(name)
  if (match === null) throw new Error(`${label}: not a canonical generation filename`)
  const version = match[1] === undefined ? 0 : Number(match[1])
  const compressed = match[2] === '.zstd'
  const bytes = await readFile(path)

  let frameTexts
  if (!compressed) {
    const text = bytes.toString('utf8')
    const headerEnd = text.indexOf('\n')
    if (headerEnd === -1) throw new Error(`${label}: empty or header-less session log`)
    frameTexts = [text.slice(0, headerEnd + 1), text.slice(headerEnd + 1)]
  } else {
    const { frames, tornStart } = scanZstdFrames(bytes)
    if (tornStart !== undefined) throw new Error(`${label}: torn physical tail (incomplete final frame at byte ${tornStart})`)
    if (frames.length === 0) throw new Error(`${label}: empty or header-less Zstandard session log`)
    frameTexts = []
    for (const { start, end } of frames) {
      frameTexts.push((await decodeFrame(bytes, start, end, label)).toString('utf8'))
    }
  }

  const headerText = frameTexts[0]
  if (headerText.length === 0 || headerText.indexOf('\n') !== headerText.length - 1) {
    throw new Error(`${label}: first frame is not exactly one header line`)
  }
  let header
  try {
    header = JSON.parse(headerText.slice(0, -1))
  } catch (error) {
    throw new Error(`${label}: header line is not valid JSON`, { cause: error })
  }
  if (header?.version !== version) {
    throw new Error(`${label}: filename identifies v${version}, but its header identifies v${header?.version}`)
  }

  const rawLines = splitBodyRecords(frameTexts.slice(1).join(''), label)
  const records = rawLines.map((line, index) => {
    try {
      return JSON.parse(line)
    } catch (error) {
      throw new Error(`${label}: unparsable committed event at line ${index + 1}`, { cause: error })
    }
  })
  const bodyFrameTexts = frameTexts.slice(1)
  const frameRecordCounts = []
  let cursor = 0
  for (const text of bodyFrameTexts) {
    const lines = splitBodyRecords(text, label)
    frameRecordCounts.push(lines.length)
    cursor += lines.length
  }
  if (cursor !== rawLines.length) throw new Error(`${label}: frame/record accounting mismatch`)
  return { path, version, compressed, header, rawLines, records, frameRecordCounts }
}

// ---------------------------------------------------------------------------
// Official restore validation (the acceptance criterion of record)
// ---------------------------------------------------------------------------

/**
 * Run the full official chain: v0→v1→v2→v3 plus installed-current validation.
 * The chain takes ownership of the rows it streams (packed Assistant rows are
 * transformed in place during the v1→v2 embedding), so every call gets its own
 * deep copy: a classify pass must never poison a later verify pass over the
 * same parsed records.
 */
function officialRestore(header, records) {
  const input = structuredClone({ header, records })
  const restore = sessionFormatCatalog.createRestore(input.header, { recovery: 'strict', validation: 'current' })
  for (const record of input.records) restore.decodeRow(record)
  return restore.finish()
}

/** `permission/preset` events carrying the non-released `origin` member. */
function originDefects(records) {
  return records.filter(record =>
    record?.type === 'permission/preset'
    && typeof record.data === 'object' && record.data !== null
    && Object.hasOwn(record.data, 'origin'))
}

/**
 * Scope guard: this script only understands `permission/preset` payloads made
 * of `preset` plus the stray `origin`. Anything else is reported, never touched.
 */
function withinRepairScope(defects) {
  return defects.every(record => typeof record.data.preset === 'string'
    && Object.keys(record.data).every(key => key === 'preset' || key === 'origin'))
}

/** An identical record set with every `origin` defect neutralized, in memory only. */
function neutralizedRecords(records, defects) {
  return records.map(record => defects.includes(record)
    ? (() => {
      const clone = { ...record }
      const data = { ...record.data }
      delete data.origin
      clone.data = data
      return clone
    })()
    : record)
}

// ---------------------------------------------------------------------------
// Session discovery
// ---------------------------------------------------------------------------

async function* canonicalGenerationFiles(rootDir) {
  let projects
  try {
    projects = await import('node:fs/promises').then(fs => fs.readdir(rootDir, { withFileTypes: true }))
  } catch (error) {
    throw new Error(`无法读取会话根目录 ${rootDir}: ${error.message}`, { cause: error })
  }
  const fs = await import('node:fs/promises')
  for (const project of projects) {
    if (!project.isDirectory()) continue
    const projectDir = join(rootDir, project.name)
    const sessions = await fs.readdir(projectDir, { withFileTypes: true }).catch(() => [])
    for (const session of sessions) {
      if (!session.isDirectory()) continue
      const sessionDir = join(projectDir, session.name)
      const entries = await fs.readdir(sessionDir, { withFileTypes: true }).catch(() => [])
      for (const entry of entries) {
        if (!entry.isFile() || !CANONICAL_LOG_NAME.test(entry.name)) continue
        yield { sessionDir, sessionId: session.name, path: join(sessionDir, entry.name) }
      }
    }
  }
}

/** Group one session directory's generation files; the active file is the highest version. */
async function inspectSession(sessionDir, sessionId, paths) {
  const files = []
  for (const path of paths) {
    try {
      files.push(await loadGenerationFile(path))
    } catch (error) {
      return { sessionDir, sessionId, status: 'structural-error', error, files: [], active: undefined }
    }
  }
  const byVersion = new Map()
  for (const file of files) {
    if (byVersion.has(file.version)) {
      return { sessionDir, sessionId, status: 'mixed-encoding', error: new Error(`同一代次存在多种物理编码：${file.path}`), files, active: undefined }
    }
    byVersion.set(file.version, file)
  }
  const active = files.reduce((best, file) => (file.version > best.version ? file : best), files[0])
  return { sessionDir, sessionId, status: undefined, error: undefined, files, active }
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

function classifyFile(file) {
  const defects = originDefects(file.records)
  if (defects.length === 0) {
    // Nothing this script targets; whether the file reads is still worth reporting.
    try {
      officialRestore(file.header, file.records)
      return { verdict: 'readable', defects }
    } catch (error) {
      return { verdict: 'unreadable-other', defects, error }
    }
  }
  try {
    officialRestore(file.header, file.records)
    // A file with the member that still restores would mean the whitelist
    // loosened upstream; there is nothing to repair.
    return { verdict: 'readable', defects }
  } catch (error) {
    if (!withinRepairScope(defects)) return { verdict: 'out-of-scope', defects, error }
    try {
      // Repairability of record: origin removal alone must satisfy the chain.
      // A second, unrelated defect makes this session a report-only case.
      officialRestore(file.header, neutralizedRecords(file.records, defects))
      return { verdict: 'affected-origin', defects, error }
    } catch (secondError) {
      return { verdict: 'origin-plus-other', defects, error, secondError }
    }
  }
}

// ---------------------------------------------------------------------------
// Repair
// ---------------------------------------------------------------------------

/** Strip `origin` from one defect record's data; key order of survivors is preserved. */
function repairedLine(rawLine, record) {
  const clone = { ...record }
  const data = { ...record.data }
  delete data.origin
  clone.data = data
  const text = JSON.stringify(clone)
  return text === JSON.stringify(record) ? rawLine : text
}

async function repairFile(file, verdict) {
  const backup = `${file.path}.bak`
  if (existsSync(backup) && !force) {
    return { outcome: 'skipped', reason: `备份已存在，避免覆盖（--force 可覆盖）：${backup}` }
  }
  const info = await stat(file.path)
  if (Date.now() - info.mtimeMs < RECENT_WRITE_MS && !force) {
    return { outcome: 'skipped', reason: '文件在 10 分钟内被修改过，疑似宿主正在写入；请关闭 Harness 后重试（或 --force）' }
  }

  // 0. Pre-flight against the official oracle, in memory only: neutralize the
  //    defects and demand the full chain to accept the result. This proves the
  //    repair will succeed and yields the reference artifact the rewritten
  //    file must reproduce event-for-event.
  const reference = officialRestore(file.header, neutralizedRecords(file.records, verdict.defects))
  if (reference.header.id !== file.header.id) throw new Error('预检失败：会话 id 不一致')

  // 1. Lossless backup before any write.
  await copyFile(file.path, backup)

  // 2. Rebuild the body: defect records re-serialized without `origin`, every
  //    other record byte-for-byte; frame grouping preserved.
  let defectIndex = 0
  const newRawLines = file.rawLines.map((rawLine, index) => {
    if (verdict.defects.includes(file.records[index])) {
      const line = repairedLine(rawLine, file.records[index])
      defectIndex += 1
      return line
    }
    return rawLine
  })
  if (defectIndex !== verdict.defects.length) throw new Error('内部错误：缺陷记录与行号失配，放弃写入')

  const bodyFrameTexts = []
  let cursor = 0
  for (const count of file.frameRecordCounts) {
    bodyFrameTexts.push(newRawLines.slice(cursor, cursor + count).join('\n') + '\n')
    cursor += count
  }

  // 3. Rewrite atomically: temp file in the same directory, then rename over.
  const headerText = JSON.stringify(file.header) + '\n'
  let payload
  if (file.compressed) {
    payload = Buffer.concat([
      await compressFrame(headerText),
      ...await Promise.all(bodyFrameTexts.map(compressFrame)),
    ])
  } else {
    payload = Buffer.from(headerText + bodyFrameTexts.join(''), 'utf8')
  }
  await writeFile(`${file.path}.repair-tmp`, payload)
  await rename(`${file.path}.repair-tmp`, file.path)

  // 4. Re-read from disk and demand event-for-event parity with the in-memory
  //    reference artifact through the same official chain.
  const reloaded = await loadGenerationFile(file.path)
  if (reloaded.header.id !== file.header.id) throw new Error('回读校验失败：会话 id 不一致')
  if (originDefects(reloaded.records).length !== 0) throw new Error('回读校验失败：仍存在 origin 缺陷记录')
  const actual = officialRestore(reloaded.header, reloaded.records)
  if (actual.header.id !== reference.header.id) throw new Error('迁移校验失败：会话 id 不一致')
  if ((actual.inheritedEventCount ?? 0) !== (reference.inheritedEventCount ?? 0)) {
    throw new Error('迁移校验失败：inheritedEventCount 不一致')
  }
  if (JSON.stringify(actual.events) !== JSON.stringify(reference.events)) {
    throw new Error(`迁移校验失败：清洗后产物与参照不一致（参照 ${reference.events.length} 条，实际 ${actual.events.length} 条）`)
  }
  return { outcome: 'repaired', defectCount: verdict.defects.length, eventCount: reference.events.length }
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function shortPath(path, rootDir) {
  return path.startsWith(rootDir) ? path.slice(rootDir.length + 1) : path
}

function printVerdict(status, session, extra = '') {
  const flag = {
    repaired: '✅',
    'affected-origin': '🚑',
    'origin-plus-other': '🧬',
    readable: '✓',
    'unreadable-other': '✗',
    'out-of-scope': '⊘',
    'structural-error': '⚠',
    'mixed-encoding': '⚠',
    'repair-failed': '❌',
    skipped: '⏭',
  }[status] ?? ' '
  console.log(`${flag} [${status}] ${session} ${extra}`.trimEnd())
}

async function collectSessions() {
  const grouped = new Map()
  for await (const found of canonicalGenerationFiles(root)) {
    const key = found.sessionDir
    if (!grouped.has(key)) grouped.set(key, { ...found, paths: [] })
    grouped.get(key).paths.push(found.path)
  }
  const sessions = []
  for (const { sessionDir, sessionId, paths } of grouped.values()) {
    sessions.push(await inspectSession(sessionDir, sessionId, paths))
  }
  return sessions
}

function classifySession(session) {
  if (session.status !== undefined) return session
  const verdict = classifyFile(session.active)
  session.fileVerdict = verdict
  if (verdict.verdict === 'affected-origin') session.status = 'affected-origin'
  else if (verdict.verdict === 'origin-plus-other') session.status = 'origin-plus-other'
  else if (verdict.verdict === 'out-of-scope') session.status = 'out-of-scope'
  else if (verdict.verdict === 'unreadable-other') session.status = 'unreadable-other'
  else {
    const affectedLeftover = session.files.find(file => file !== session.active && originDefects(file.records).length > 0)
    session.status = affectedLeftover !== undefined ? 'readable-leftover' : 'readable'
  }
  return session
}

// ---------------------------------------------------------------------------
// Modes
// ---------------------------------------------------------------------------

const sessions = (await collectSessions()).map(classifySession)
const tally = {}
for (const session of sessions) tally[session.status] = (tally[session.status] ?? 0) + 1

if (mode === 'scan') {
  console.log(`扫描 ${root}（共 ${sessions.length} 个会话目录）\n`)
  for (const session of sessions) {
    const extra = []
    if (session.fileVerdict?.defects.length > 0) extra.push(`origin 缺陷 ${session.fileVerdict.defects.length} 条`)
    if (session.status === 'unreadable-other' || session.status === 'structural-error' || session.status === 'out-of-scope' || session.status === 'origin-plus-other') {
      extra.push(session.fileVerdict?.secondError?.message ?? session.fileVerdict?.error?.message ?? session.error?.message ?? '')
    }
    if (session.status === 'origin-plus-other') extra.unshift('origin 之外还有其他缺陷，修复无法使其可读')
    if (session.status === 'readable-leftover') extra.push('存在带 origin 的低代次遗留文件（会话可读，不处理）')
    printVerdict(session.status, shortPath(session.sessionDir, root), extra.length > 0 ? ` — ${extra.filter(Boolean).join('；')}` : '')
  }
  console.log('\n汇总：')
  for (const [status, count] of Object.entries(tally).sort((a, b) => b[1] - a[1])) console.log(`  ${status}: ${count}`)
  const affected = tally['affected-origin'] ?? 0
  console.log(affected > 0 ? `\n${affected} 个会话可修复：追加 --repair 执行（请先关闭 Harness）。` : '\n没有需要修复的会话。')
} else if (mode === 'verify') {
  console.log(`校验 ${root} 的全部活动代次（官方 v0→v3 迁移 + 当前代次验证）\n`)
  let passed = 0
  let failed = 0
  for (const session of sessions) {
    if (session.status === 'structural-error' || session.status === 'mixed-encoding') {
      printVerdict(session.status, shortPath(session.sessionDir, root), `— ${session.error.message}`)
      failed += 1
      continue
    }
    try {
      officialRestore(session.active.header, session.active.records)
      printVerdict('readable', shortPath(session.sessionDir, root), `— v${session.active.version}，${session.active.records.length} 条记录`)
      passed += 1
    } catch (error) {
      printVerdict('unreadable-other', shortPath(session.sessionDir, root), `— ${error.message}`)
      failed += 1
    }
  }
  console.log(`\n汇总：通过 ${passed}，失败 ${failed}`)
  process.exitCode = failed === 0 ? 0 : 1
} else {
  const affected = sessions.filter(session => session.status === 'affected-origin')
  console.log(`修复模式：${affected.length} 个受影响会话，根目录 ${root}${force ? '（--force）' : ''}\n`)
  let repaired = 0
  let failed = 0
  let skipped = 0
  for (const session of affected) {
    const label = shortPath(session.active.path, root)
    try {
      const result = await repairFile(session.active, session.fileVerdict)
      if (result.outcome === 'repaired') {
        repaired += 1
        printVerdict('repaired', label, `— 移除 ${result.defectCount} 条 origin，迁移后 ${result.eventCount} 条事件，与内存参照逐事件一致`)
      } else {
        skipped += 1
        printVerdict('skipped', label, `— ${result.reason}`)
      }
    } catch (error) {
      failed += 1
      printVerdict('repair-failed', label, `— ${error.message}`)
    }
  }
  console.log(`\n汇总：修复 ${repaired}，跳过 ${skipped}，失败 ${failed}`)
  if (failed === 0 && repaired > 0) {
    console.log('\n下一步：在 Harness 插件设置面板点击【重新扫描】（或重启宿主），确认"无法读取 session"归零、用量回填。')
  }
  process.exitCode = failed === 0 ? 0 : 1
}
