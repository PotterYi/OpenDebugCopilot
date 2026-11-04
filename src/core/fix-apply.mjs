import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { normalizeFix, resolveFixTarget } from './fixes.mjs';

function toFileEol(text, eol) {
  return String(text).replace(/\r\n/g, '\n').replace(/\n/g, eol);
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

async function atomicWrite(file, content) {
  const info = await stat(file);
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  try {
    await writeFile(tmp, content, 'utf8');
    await chmod(tmp, info.mode);
    await rename(tmp, file);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
}

/**
 * Apply one structured fix after re-validating it against the current file.
 * The original file is copied to backupPath before the atomic write.
 *
 * @param {{
 *   fix: any,
 *   roots: { sourceRoot?: string | null, frontendSourceRoot?: string | null },
 *   backupPath: string
 * }} options
 */
export async function applyFix({ fix: rawFix, roots, backupPath }) {
  const fix = normalizeFix(rawFix);
  if (!fix) throw new Error('无效的修复建议');
  if (fix.kind !== 'edit') throw new Error('该建议没有可应用的代码修改');
  if (!fix.search) throw new Error('search 片段不能为空');

  const target = await resolveFixTarget(fix, roots);
  if (target.error) throw new Error(target.error);

  const raw = await readFile(target.resolved, 'utf8');
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const search = toFileEol(fix.search, eol);
  const replace = toFileEol(fix.replace, eol);
  const occurrences = countOccurrences(raw, search);
  if (occurrences === 0) throw new Error('未在文件中找到 search 片段（文件可能已被修改）');
  if (occurrences > 1) throw new Error(`search 片段在文件中出现 ${occurrences} 次，无法唯一定位`);
  if (search === replace) throw new Error('修改前后内容相同');

  const index = raw.indexOf(search);
  const line = raw.slice(0, index).split(/\r?\n/).length;
  const next = `${raw.slice(0, index)}${replace}${raw.slice(index + search.length)}`;

  await mkdir(path.dirname(backupPath), { recursive: true });
  await writeFile(backupPath, raw, 'utf8');
  await atomicWrite(target.resolved, next);

  return {
    file: target.relative,
    root: target.name,
    line,
    bytes: Buffer.byteLength(next, 'utf8'),
  };
}

/**
 * Restore a previously backed-up file. Used by the UI's undo action.
 *
 * @param {{
 *   fix: any,
 *   roots: { sourceRoot?: string | null, frontendSourceRoot?: string | null },
 *   backupPath: string
 * }} options
 */
export async function revertFix({ fix: rawFix, roots, backupPath }) {
  const fix = normalizeFix(rawFix);
  if (!fix) throw new Error('无效的修复建议');
  const target = await resolveFixTarget(fix, roots);
  if (target.error) throw new Error(target.error);

  const backup = await readFile(backupPath, 'utf8');
  await atomicWrite(target.resolved, backup);
  return { file: target.relative, root: target.name };
}
