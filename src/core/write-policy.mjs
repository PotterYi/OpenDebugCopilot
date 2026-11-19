import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { inside, isSensitivePath, normalizePath } from './path-policy.mjs';

const execFileAsync = promisify(execFile);

export const WRITE_DENY_ANYWHERE = new Set(['.git', 'node_modules']);
export const WRITE_OUTPUT_SEGMENTS = new Set([
  'target', 'dist', 'build', 'out', 'bin', 'obj', 'logs', 'runs',
  'coverage', '__pycache__', '.gradle', '.cache',
  '.next', '.nuxt', '.idea', '.vscode', 'vendor',
]);

export const WRITE_DENIAL_MESSAGES = {
  WRITE_OUTSIDE_ROOT: '路径不在可写源码目录内',
  WRITE_SENSITIVE_PATH: '拒绝修改敏感文件',
  WRITE_VCS_DENIED: '禁止修改版本控制或依赖目录',
  WRITE_BUILD_OUTPUT: '禁止修改构建产物目录',
};

export function writeDenialMessage(result) {
  return WRITE_DENIAL_MESSAGES[result?.code] ?? '路径不可写';
}

async function resolveReal(target) {
  return realpath(target).catch(() => path.resolve(target));
}

function normalizedParts(relative) {
  return normalizePath(relative).split('/').filter(Boolean).map((part) => part.toLowerCase());
}

/**
 * git check-ignore only answers for paths inside a repository. Exit code 1
 * means "tracked/not ignored"; 128 (and other failures) mean "no repo".
 */
async function gitIgnoreStatus(root, relative) {
  try {
    await execFileAsync('git', ['-C', root, 'check-ignore', '-q', '--', relative], {
      windowsHide: true,
      timeout: 5000,
      maxBuffer: 1024 * 1024,
    });
    return 'ignored';
  } catch (error) {
    return error?.code === 1 ? 'tracked' : 'no-repo';
  }
}

/**
 * Find the longest authorized writable root that contains target.
 * Returns { root, relative } with the realpath-normalized root.
 */
export async function writableRootFor(target, roots = []) {
  const realTarget = await resolveReal(target);
  let best = null;
  for (const root of roots) {
    const realRoot = await resolveReal(root);
    if (!inside(realRoot, realTarget)) continue;
    if (!best || realRoot.length > best.root.length) {
      best = { root: realRoot, relative: normalizePath(path.relative(realRoot, realTarget)) };
    }
  }
  return best;
}

/**
 * Shared write-path policy for agent Edit/Write and model-generated fixes.
 * Checks root containment, sensitive names, .git/node_modules, and build
 * outputs. Git-tracked build folders stay writable; ignored ones do not.
 *
 * @param {{ target: string, roots?: string[], root?: string | null, relative?: string | null }} input
 */
export async function checkWritablePath({ target, roots = [], root = null, relative = null } = {}) {
  let match = null;
  let absolute = target;
  if (root && relative !== null && relative !== undefined) {
    const realRoot = await resolveReal(root);
    absolute = path.resolve(root, relative);
    const realTarget = await resolveReal(absolute);
    if (!inside(realRoot, realTarget)) {
      return { ok: false, code: 'WRITE_OUTSIDE_ROOT', root: realRoot, relative: normalizePath(relative) };
    }
    match = { root: realRoot, relative: normalizePath(relative) };
  } else {
    match = await writableRootFor(target, roots);
    if (!match) return { ok: false, code: 'WRITE_OUTSIDE_ROOT', target };
    absolute = target;
  }

  const realTarget = await resolveReal(absolute);
  const realRelative = normalizePath(path.relative(match.root, realTarget));
  const relatives = [match.relative];
  if (realRelative && !realRelative.startsWith('..')) relatives.push(realRelative);

  for (const rel of relatives) {
    if (isSensitivePath(rel)) {
      return { ok: false, code: 'WRITE_SENSITIVE_PATH', root: match.root, relative: rel };
    }
    const parts = normalizedParts(rel);
    if (parts.some((part) => WRITE_DENY_ANYWHERE.has(part))) {
      return { ok: false, code: 'WRITE_VCS_DENIED', root: match.root, relative: rel };
    }
    if (parts.length === 0 || !parts.some((part) => WRITE_OUTPUT_SEGMENTS.has(part))) continue;
    const status = await gitIgnoreStatus(match.root, parts.join('/'));
    if (status === 'ignored') {
      return { ok: false, code: 'WRITE_BUILD_OUTPUT', root: match.root, relative: rel };
    }
    if (status === 'no-repo' && WRITE_OUTPUT_SEGMENTS.has(parts[0])) {
      return { ok: false, code: 'WRITE_BUILD_OUTPUT', root: match.root, relative: rel };
    }
  }

  return { ok: true, root: match.root, relative: match.relative, target: realTarget };
}
