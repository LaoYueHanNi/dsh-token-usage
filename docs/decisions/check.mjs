#!/usr/bin/env node
// 决策记录校验：node docs/decisions/check.mjs
// 检查文件名格式、头部前两行、Status 与目录一致、骨架段落齐全、反规划残留、归档标记、相对链接死链。零依赖。
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const root = dirname(fileURLToPath(import.meta.url));
const errors = [];

const SLUG_RE = /^\d{4}-\d{2}-\d{2}-[a-z0-9-]+\.md$/;

function listMd(dir) {
  const p = join(root, dir);
  if (!existsSync(p)) return [];
  return readdirSync(p)
    .filter((f) => f.endsWith('.md') && !f.startsWith('_template') && f !== '.gitkeep.md')
    .map((f) => join(p, f));
}

const SECTIONS = {
  implemented: ['## Problem', '## Decision', '## Alternatives considered', '## Consequences'],
  proposed: ['## Problem', '## Proposal', '## Alternatives considered'],
  rejected: ['## Problem', '## Proposal'],
};

const FORBIDDEN_SECTIONS = {
  implemented: ['## Proposal', '## Plan', '## Migration plan', '## Acceptance criteria', '## Risks'],
  archived: ['## Proposal', '## Plan', '## Migration plan', '## Acceptance criteria', '## Risks'],
};

function check(file, lifecycle, text) {
  const short = file.slice(root.length + 1);
  const base = basename(file);

  // 1. 文件名格式校验
  if (!SLUG_RE.test(base)) {
    errors.push(short + ': 文件名必须符合 "yyyy-mm-dd-slug.md" 格式: ' + base);
  }

  // 2. 头部前两行严格校验
  const lines = text.split(/\r?\n/);
  if (!lines[0].startsWith('# DR: ')) {
    errors.push(short + ': 第 1 行必须以 "# DR: <标题>" 开头');
  }
  if (lines.length > 1 && lines[1].trim() !== '') {
    errors.push(short + ': 第 2 行必须为空行');
  }

  // 3. Status 行校验
  const m = text.match(/^Status:\s*(.+)$/m);
  if (!m) {
    errors.push(short + ': 缺少 Status 行');
  } else {
    const v = m[1].trim();
    if (lifecycle === 'rejected' && !/^rejected\s+—\s+\S/.test(v)) {
      errors.push(short + ': rejected 记录的 Status 必须是 "rejected — 一行理由": ' + v);
    } else if (lifecycle === 'archived') {
      if (v !== 'implemented') errors.push(short + ': archived 记录的 Status 必须仍为 implemented: ' + v);
      if (!/^Archived:\s*\d{4}-\d{2}-\d{2}\s*$/m.test(text)) errors.push(short + ': 缺少 "Archived: yyyy-mm-dd" 行');
    } else if (lifecycle !== 'rejected' && v !== lifecycle) {
      errors.push(short + ': Status "' + v + '" 与目录 ' + lifecycle + '/ 不一致');
    }
  }

  // 4. 骨架段落必填校验
  const skeleton = lifecycle === 'archived' ? SECTIONS.implemented : SECTIONS[lifecycle];
  if (skeleton) {
    for (const s of skeleton) {
      if (!text.includes(s)) errors.push(short + ': 缺少段落 ' + s);
    }
  }

  // 5. 规划性段落禁用校验（反规划残留）
  const forbidden = FORBIDDEN_SECTIONS[lifecycle];
  if (forbidden) {
    for (const s of forbidden) {
      if (text.includes(s)) errors.push(short + ': ' + lifecycle + ' 记录禁止包含规划性段落 ' + s);
    }
  }

  // 6. Markdown 相对链接死链校验（清洗 title 与 hash）
  const re = /\]\(([^)]+)\)/g;
  let lm;
  while ((lm = re.exec(text))) {
    const raw = lm[1].trim();
    if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) continue;
    const target = raw.split(/\s+/)[0].split('#')[0];
    if (!target) continue;
    if (!existsSync(resolve(dirname(file), target))) errors.push(short + ': 死链 ' + target);
  }
}

let count = 0;
for (const lifecycle of ['proposed', 'implemented', 'rejected', 'archived']) {
  for (const file of listMd(lifecycle)) {
    count++;
    check(file, lifecycle, readFileSync(file, 'utf8'));
  }
}
if (errors.length) {
  console.error('决策记录校验失败:\n' + errors.join('\n'));
  process.exit(1);
}
console.log('决策记录校验通过: ' + count + ' 条记录');
