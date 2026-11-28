/**
 * Extract the Markdown release notes section for a given version from CHANGELOG.md.
 *
 * CLI usage:
 *   node scripts/release-notes.mjs <version> [changelogPath]
 *
 * Exit codes:
 *   0 - section found and written to stdout
 *   1 - invalid CLI usage or unreadable changelog file
 *   2 - version section missing or empty in changelog
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Extract the release notes body for `version` (with or without leading `v`) from
 * a Keep-a-Changelog formatted Markdown string. Appends the version's reference
 * compare link when defined at the bottom of the file and not already present.
 *
 * @param {string} markdown - Full CHANGELOG.md content.
 * @param {string} rawVersion - Target version, e.g. `0.4.16` or `v0.4.16`.
 * @returns {string | null} Trimmed release notes Markdown, or null when missing/empty.
 */
export function extractReleaseNotes(markdown, rawVersion) {
  const version = rawVersion.trim().replace(/^v/i, '')
  if (version === '') return null

  const normalized = markdown.replace(/\r\n/g, '\n')
  const escaped = escapeRegExp(version)
  const headingRe = new RegExp(`^##\\s+(?:\\[${escaped}\\]|${escaped})(?:\\s.*)?$`, 'm')
  const match = headingRe.exec(normalized)
  if (match === null) return null

  const start = match.index + match[0].length
  const rest = normalized.slice(start)
  const nextHeading = /\n##\s+/.exec(rest)
  let section = nextHeading === null ? rest : rest.slice(0, nextHeading.index)

  // Strip trailing Markdown reference link definitions (e.g. `[0.4.16]: https://...`).
  const refBlock = /\n\[[^\]]+\]:\s+https?:\/\/\S+(?:\n\[[^\]]+\]:\s+https?:\/\/\S+)*\s*$/
  section = section.replace(refBlock, '').trim()
  if (section === '') return null

  const compareRe = new RegExp(`^\\[${escaped}\\]:\\s+(https?:\\/\\/\\S+)\\s*$`, 'm')
  const compareUrl = compareRe.exec(normalized)?.[1]
  if (compareUrl !== undefined && !section.includes(compareUrl)) {
    section = `${section}\n\n**完整变更对比**: ${compareUrl}`
  }
  return section
}

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isMain) {
  const versionArg = process.argv[2]
  const fileArg = process.argv[3] ?? 'CHANGELOG.md'
  if (versionArg === undefined || versionArg.trim() === '') {
    console.error('Usage: node scripts/release-notes.mjs <version> [changelogPath]')
    process.exit(1)
  }
  let content
  try {
    content = readFileSync(resolve(fileArg), 'utf8')
  } catch (error) {
    console.error(`Failed to read ${fileArg}: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
  const notes = extractReleaseNotes(content, versionArg)
  if (notes === null) {
    console.error(`No release notes section found for version "${versionArg}" in ${fileArg}.`)
    process.exit(2)
  }
  process.stdout.write(`${notes}\n`)
}
