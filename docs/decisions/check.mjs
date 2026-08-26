#!/usr/bin/env node
// 决策记录校验：node docs/decisions/check.mjs
// 检查 Status 与目录一致、骨架段落齐全、归档标记、相对链接死链。零依赖。
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const root = dirname(fileURLToPath(import.meta.url));
const errors = [];

function listMd(dir) {
  const p = join(root, dir);
  if (!existsSync(p)) return [];
  return readdirSync(p).filter((f) => f.endsWith('.md') && f !== '.gitkeep.md').map((f) => join(p, f));
}

const SECTIONS = {
  implemented: ['## Problem', '## Decision', '## Alternatives considered', '## Consequences'],
  proposed: ['## Problem', '## Proposal', '## Alternatives considered'],
  rejected: ['## Problem', '## Proposal'],
};

function check(file, lifecycle, text) {
  const short = file.slice(root.length + 1);
  const m = text.match(/^Status:\s*(.+)$/m);
  if (!m) { errors.push(short + ': 缺少 Status 行'); }
  else {
    const v = m[1].trim();
    if (lifecycle === 'rejected' && !/^rejected\s+—\s+\S/.test(v)) errors.push(short + ': rejected 记录的 Status 必须是 "rejected — 一行理由": ' + v);
    else if (lifecycle === 'archived') {
      if (v !== 'implemented') errors.push(short + ': archived 记录的 Status 必须仍为 implemented: ' + v);
      if (!/^Archived:\s*\d{4}-\d{2}-\d{2}\s*$/m.test(text)) errors.push(short + ': 缺少 "Archived: yyyy-mm-dd" 行');
    }
    else if (lifecycle !== 'rejected' && v !== lifecycle) errors.push(short + ': Status "' + v + '" 与目录 ' + lifecycle + '/ 不一致');
  }
  const skeleton = lifecycle === 'archived' ? SECTIONS.implemented : SECTIONS[lifecycle];
  if (skeleton) for (const s of skeleton) if (!text.includes(s)) errors.push(short + ': 缺少段落 ' + s);
  const re = /\]\(([^)]+)\)/g;
  let lm;
  while ((lm = re.exec(text))) {
    const raw = lm[1];
    if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) continue;
    const target = raw.split('#')[0];
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
if (errors.length) { console.error('决策记录校验失败:\n' + errors.join('\n')); process.exit(1); }
console.log('决策记录校验通过: ' + count + ' 条记录');
