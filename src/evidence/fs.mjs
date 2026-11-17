import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';
import { AppError } from '../core/errors.mjs';
import { isIgnoredDirectory, isSensitivePath, normalizePath, resolveWithinRoot } from '../core/path-policy.mjs';

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 500;
const MAX_DEPTH = 2;

function numeric(value, fallback, { min, max, code, label }) {
  const number = Number(value ?? fallback);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new AppError(code, `${label} must be an integer between ${min} and ${max}`, { exitCode: 2 });
  }
  return number;
}

/**
 * List a directory inside an authorized source root. Metadata only; sensitive
 * names and .git internals are hidden before they can reach the model.
 */
export async function listDirectory({
  root,
  path: target = '',
  depth = 1,
  limit = DEFAULT_LIMIT,
} = {}) {
  const depthValue = numeric(depth, 1, { min: 1, max: MAX_DEPTH, code: 'INVALID_DEPTH', label: 'depth' });
  const limitValue = numeric(limit, DEFAULT_LIMIT, { min: 1, max: MAX_LIMIT, code: 'INVALID_LIMIT', label: 'limit' });
  const resolved = await resolveWithinRoot(root, target, { requireDirectory: true });
  const entries = [];
  let hiddenSensitive = 0;
  let truncated = false;
  const queue = [{
    dir: resolved.real,
    relative: resolved.relative === '.' ? '' : resolved.relative,
    level: 1,
  }];

  while (queue.length > 0) {
    const current = queue.shift();
    let dirents;
    try {
      dirents = await readdir(current.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    dirents.sort((a, b) => {
      const dirDelta = Number(b.isDirectory()) - Number(a.isDirectory());
      return dirDelta || a.name.localeCompare(b.name);
    });
    for (const entry of dirents) {
      const entryRelative = current.relative ? `${current.relative}/${entry.name}` : entry.name;
      if (entry.name === '.git' || isSensitivePath(entryRelative)) {
        hiddenSensitive += 1;
        continue;
      }
      const absolute = path.join(current.dir, entry.name);
      let info;
      try {
        info = await lstat(absolute);
      } catch {
        continue;
      }
      const type = entry.isSymbolicLink()
        ? 'symlink'
        : entry.isDirectory()
          ? 'dir'
          : entry.isFile()
            ? 'file'
            : 'other';
      entries.push({
        name: entry.name,
        path: normalizePath(entryRelative),
        type,
        size: type === 'file' ? info.size : null,
        mtime: info.mtime?.toISOString?.() ?? null,
      });
      if (entries.length >= limitValue) {
        truncated = true;
        break;
      }
      if (current.level < depthValue && type === 'dir' && !isIgnoredDirectory(entry.name)) {
        queue.push({ dir: absolute, relative: entryRelative, level: current.level + 1 });
      }
    }
    if (truncated) break;
  }

  return {
    path: resolved.relative,
    depth: depthValue,
    entries,
    count: entries.length,
    truncated,
    hiddenSensitive,
  };
}

/** Return file/directory metadata only; never file contents. */
export async function statFile({ root, path: target } = {}) {
  if (!target || !String(target).trim()) {
    throw new AppError('PATH_REQUIRED', 'stat_file requires a path', { exitCode: 2 });
  }
  const resolved = await resolveWithinRoot(root, target, { allowMissing: true });
  if (!resolved.info) {
    return {
      path: resolved.relative,
      exists: false,
      type: null,
      size: null,
      mtime: null,
      isSymlink: false,
    };
  }
  let linkInfo = null;
  try {
    linkInfo = await lstat(resolved.absolute);
  } catch {
    // The realpath/stat pair above already succeeded; lstat is only for symlink detection.
  }
  const isSymlink = Boolean(linkInfo?.isSymbolicLink());
  const type = isSymlink
    ? 'symlink'
    : resolved.info.isDirectory()
      ? 'dir'
      : resolved.info.isFile()
        ? 'file'
        : 'other';
  const metadata = isSymlink ? linkInfo : resolved.info;
  return {
    path: resolved.relative,
    exists: true,
    type,
    size: type === 'file' || isSymlink ? metadata.size : null,
    mtime: metadata.mtime?.toISOString?.() ?? null,
    isSymlink,
  };
}
