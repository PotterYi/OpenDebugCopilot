import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

export const FIX_RISKS = ['low', 'medium', 'high'];

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_SEARCH_BYTES = 100 * 1024;

function clean(value, max = 1000) {
  return String(value ?? '').trim().slice(0, max);
}

function cleanBlock(value) {
  return typeof value === 'string' ? value.slice(0, MAX_SEARCH_BYTES) : '';
}

/**
 * Normalize one fix. Strings (the pre-2a schema) remain text-only suggestions.
 *
 * @param {any} item
 * @returns {any | null}
 */
export function normalizeFix(item) {
  if (typeof item === 'string') {
    const summary = clean(item);
    return summary
      ? { summary, kind: 'text', root: null, file: '', search: '', replace: '', risk: null, verification: '', note: '' }
      : null;
  }
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null;

  const summary = clean(item.summary ?? item.title ?? '');
  const file = clean(item.file, 500);
  const search = cleanBlock(item.search);
  const replace = cleanBlock(item.replace);
  const kind = search || replace ? 'edit' : 'text';
  const root = item.root === 'frontend' ? 'frontend' : item.root === 'backend' ? 'backend' : null;
  const risk = FIX_RISKS.includes(item.risk) ? item.risk : kind === 'edit' ? 'medium' : null;
  if (!summary && !file) return null;

  return {
    summary: summary || `修改 ${file}`,
    kind,
    root,
    file,
    search,
    replace,
    risk,
    verification: clean(item.verification, 1000),
    note: clean(item.note, 1000),
  };
}

export function normalizeFixList(value) {
  if (!Array.isArray(value)) return [];
  return value.map(normalizeFix).filter(Boolean);
}

async function pathKind(target) {
  try {
    const info = await stat(target);
    if (info.isDirectory()) return 'dir';
    if (info.isFile()) return 'file';
    return 'other';
  } catch {
    return null;
  }
}

function isInside(root, target) {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  return resolvedTarget === resolvedRoot || resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`);
}

/**
 * Resolve a fix's relative file inside the configured roots.
 * Exported so the apply/undo path uses exactly the same validation as the preview.
 *
 * @param {any} item
 * @param {{ sourceRoot?: string | null, frontendSourceRoot?: string | null }} roots
 */
export async function resolveFixTarget(item, { sourceRoot = null, frontendSourceRoot = null } = {}) {
  const fix = normalizeFix(item);
  if (!fix) return { error: '无效的修复建议' };
  if (!fix.file) return { error: '修复建议没有指定文件' };
  if (path.isAbsolute(fix.file)) return { error: '文件路径必须是相对路径' };

  const relative = fix.file.replace(/\\/g, '/');
  const candidates = [];
  const add = (name, root) => {
    if (!root) return;
    const resolved = path.resolve(root, relative);
    if (!isInside(root, resolved)) {
      candidates.push({ name, root, outside: true });
      return;
    }
    candidates.push({ name, root, resolved });
  };

  if (fix.root === 'backend') add('backend', sourceRoot);
  else if (fix.root === 'frontend') add('frontend', frontendSourceRoot);
  else {
    add('backend', sourceRoot);
    add('frontend', frontendSourceRoot);
  }

  if (candidates.length === 0) {
    return { error: '未配置后端/前端源码目录，无法生成预览' };
  }
  if (candidates.some((candidate) => candidate.outside)) {
    return { error: `文件路径越出源码目录：${fix.file}` };
  }

  const existing = [];
  for (const candidate of candidates) {
    if (await pathKind(candidate.resolved) !== 'file') continue;
    const [realRoot, realFile] = await Promise.all([
      realpath(candidate.root).catch(() => null),
      realpath(candidate.resolved).catch(() => null),
    ]);
    if (realRoot && realFile && !isInside(realRoot, realFile)) {
      return { error: `文件通过符号链接越出源码目录：${fix.file}` };
    }
    existing.push(candidate);
  }
  if (existing.length === 0) {
    return { error: `未找到文件：${fix.file}${fix.root ? `（${fix.root}）` : ''}` };
  }
  if (existing.length > 1) {
    return { error: `同一相对路径同时存在于后端和前端源码目录，请在修复建议中指定 root：${fix.file}` };
  }
  return { ...existing[0], relative: relative };
}

async function readText(file) {
  const info = await stat(file);
  if (!info.isFile()) throw new Error('目标不是文件');
  if (info.size > MAX_FILE_BYTES) throw new Error('文件超过 2MB，拒绝预览');
  const raw = await readFile(file, 'utf8');
  return raw.replace(/^﻿/, '').replace(/\r\n/g, '\n');
}

function countOccurrences(text, needle) {
  if (!needle) return 0;
  let count = 0;
  let index = 0;
  while ((index = text.indexOf(needle, index)) !== -1) {
    count += 1;
    index += needle.length;
  }
  return count;
}

function splitLines(text) {
  return text === '' ? [] : text.split('\n');
}

function diffLines(oldLines, newLines) {
  if (oldLines.length * newLines.length > 200_000) {
    return [
      ...oldLines.map((line) => ({ type: '-', line })),
      ...newLines.map((line) => ({ type: '+', line })),
    ];
  }
  const rows = oldLines.length + 1;
  const cols = newLines.length + 1;
  const dp = Array.from({ length: rows }, () => new Array(cols).fill(0));
  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      dp[i][j] = oldLines[i - 1] === newLines[j - 1]
        ? dp[i - 1][j - 1] + 1
        : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  const ops = [];
  let i = oldLines.length;
  let j = newLines.length;
  while (i > 0 && j > 0) {
    if (oldLines[i - 1] === newLines[j - 1]) {
      ops.push({ type: ' ', line: oldLines[i - 1] });
      i -= 1;
      j -= 1;
    } else if (dp[i - 1][j] >= dp[i][j - 1]) {
      ops.push({ type: '-', line: oldLines[i - 1] });
      i -= 1;
    } else {
      ops.push({ type: '+', line: newLines[j - 1] });
      j -= 1;
    }
  }
  while (i > 0) {
    ops.push({ type: '-', line: oldLines[i - 1] });
    i -= 1;
  }
  while (j > 0) {
    ops.push({ type: '+', line: newLines[j - 1] });
    j -= 1;
  }
  const reversed = ops.reverse();
  // Keep a conventional diff shape: deletions before additions within a change block.
  const normalized = [];
  let index = 0;
  while (index < reversed.length) {
    if (reversed[index].type === ' ') {
      normalized.push(reversed[index]);
      index += 1;
      continue;
    }
    const deletions = [];
    const additions = [];
    while (index < reversed.length && reversed[index].type !== ' ') {
      (reversed[index].type === '-' ? deletions : additions).push(reversed[index]);
      index += 1;
    }
    normalized.push(...deletions, ...additions);
  }
  return normalized;
}

function buildPatch({ file, line, search, replace, text }) {
  const lines = text.split('\n');
  const oldLines = splitLines(search);
  const newLines = splitLines(replace);
  const beforeStart = Math.max(0, line - 1 - 2);
  const before = lines.slice(beforeStart, line - 1);
  const afterStart = line - 1 + oldLines.length;
  const after = lines.slice(afterStart, afterStart + 2);
  const hunkStart = beforeStart + 1;
  const ops = diffLines(oldLines, newLines);
  return [
    `--- a/${file}`,
    `+++ b/${file}`,
    `@@ -${hunkStart},${before.length + oldLines.length + after.length} +${hunkStart},${before.length + newLines.length + after.length} @@`,
    ...before.map((item) => ` ${item}`),
    ...ops.map((op) => `${op.type}${op.line}`),
    ...after.map((item) => ` ${item}`),
  ].join('\n');
}

/**
 * Build a read-only diff preview for a structured fix. Never writes files.
 *
 * @param {any} item
 * @param {{ sourceRoot?: string | null, frontendSourceRoot?: string | null }} roots
 */
export async function buildFixPreview(item, { sourceRoot = null, frontendSourceRoot = null } = {}) {
  const fix = normalizeFix(item);
  if (!fix) return null;
  if (fix.kind !== 'edit') {
    return { ...fix, preview: { status: 'no-edit', message: '仅文字建议，未提供可预览的代码修改' } };
  }
  if (!fix.search) {
    return { ...fix, preview: { status: 'error', message: 'search 片段不能为空' } };
  }

  const target = await resolveFixTarget(fix, { sourceRoot, frontendSourceRoot });
  if (target.error) return { ...fix, preview: { status: 'error', message: target.error } };

  let text;
  try {
    text = await readText(target.resolved);
  } catch (error) {
    return {
      ...fix,
      root: target.name,
      preview: { status: 'error', message: `读取文件失败：${error?.message ?? error}` },
    };
  }

  const occurrences = countOccurrences(text, fix.search);
  if (occurrences === 0) {
    return {
      ...fix,
      root: target.name,
      preview: { status: 'error', message: '未在文件中找到 search 片段（文件可能已被修改）' },
    };
  }
  if (occurrences > 1) {
    return {
      ...fix,
      root: target.name,
      preview: { status: 'error', message: `search 片段在文件中出现 ${occurrences} 次，无法唯一定位` },
    };
  }
  if (fix.search === fix.replace) {
    return { ...fix, root: target.name, preview: { status: 'no-change', message: '修改前后内容相同' } };
  }

  const index = text.indexOf(fix.search);
  const line = text.slice(0, index).split('\n').length;
  const file = fix.file.replace(/\\/g, '/');
  const patch = buildPatch({ file, line, search: fix.search, replace: fix.replace, text });
  return {
    ...fix,
    root: target.name,
    preview: { status: 'ready', line, occurrences, patch, message: '可预览' },
  };
}

/**
 * Normalize and preview a list of fixes. Previewing is capped to avoid reading many files.
 *
 * @param {any} value
 * @param {{ sourceRoot?: string | null, frontendSourceRoot?: string | null, maxFixes?: number }} [options]
 */
export async function buildFixPreviews(value, options = {}) {
  const fixes = normalizeFixList(value);
  const maxFixes = options.maxFixes ?? 5;
  return Promise.all(fixes.map((fix, index) => (
    index < maxFixes
      ? buildFixPreview(fix, options)
      : Promise.resolve({ ...fix, preview: { status: 'skipped', message: '超出预览数量上限' } })
  )));
}
