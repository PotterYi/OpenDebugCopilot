import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { AppError } from './errors.mjs';

const BS = String.fromCharCode(92);

export const SENSITIVE_NAME = /^(?:\.env(?:\..*)?|.*\.(?:pem|key|p12|pfx)|id_(?:rsa|dsa|ecdsa|ed25519).*|\.npmrc|\.pypirc|credentials|secrets?)$/i;

export const DEFAULT_IGNORED_DIRS = new Set([
  '.git', '.tmp', 'runs', 'node_modules', 'dist', 'build', 'target', 'out',
  'coverage', '.idea', '.vscode', '.next', '.nuxt', 'vendor', 'logs',
  '.ssh', '.aws', '.kube', '.docker',
]);

export function normalizePath(value) {
  return String(value ?? '').split(BS).join('/');
}

export function inside(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export function isGitMetadataPath(target) {
  return normalizePath(target).split('/').filter(Boolean).includes('.git');
}

export function isSensitivePath(target) {
  const normalized = normalizePath(target);
  const segments = normalized.split('/').filter(Boolean);
  const base = segments[segments.length - 1] ?? '';
  if (SENSITIVE_NAME.test(base)) return true;
  if (segments.includes('.git') || segments.includes('.ssh') || segments.includes('.aws') || segments.includes('.kube')) {
    return true;
  }
  const dockerIndex = segments.indexOf('.docker');
  if (dockerIndex >= 0 && segments[dockerIndex + 1] === 'config.json') return true;
  return false;
}

export function isIgnoredDirectory(name) {
  return DEFAULT_IGNORED_DIRS.has(String(name ?? ''));
}

/**
 * Resolve a path inside an authorized root and enforce realpath containment.
 * Sensitive names and .git internals are rejected before any stat/read.
 *
 * @param {string} root
 * @param {string} [target]
 * @param {{ allowMissing?: boolean, requireDirectory?: boolean, requireFile?: boolean }} [options]
 */
export async function resolveWithinRoot(root, target = '', {
  allowMissing = false,
  requireDirectory = false,
  requireFile = false,
} = {}) {
  if (!root) {
    throw new AppError('SOURCE_ROOT_REQUIRED', 'source root is not configured', { exitCode: 3 });
  }
  const configuredRoot = path.resolve(root);
  let absoluteRoot = configuredRoot;
  try {
    absoluteRoot = await realpath(configuredRoot);
  } catch {
    // Keep the configured root for missing-root errors below.
  }
  const absolute = path.resolve(configuredRoot, String(target || '.'));
  if (!inside(configuredRoot, absolute)) {
    throw new AppError('PATH_OUT_OF_SCOPE', 'path is outside the authorized source root', { exitCode: 2 });
  }
  const relative = normalizePath(path.relative(configuredRoot, absolute)) || '.';
  if (isSensitivePath(relative) || isSensitivePath(absolute)) {
    throw new AppError('SENSITIVE_PATH', 'sensitive files and Git metadata are not accessible', { exitCode: 2 });
  }

  let info = null;
  let real = absolute;
  try {
    real = await realpath(absolute);
    info = await stat(absolute);
  } catch (error) {
    if (error?.code !== 'ENOENT' || !allowMissing) {
      throw new AppError('PATH_NOT_FOUND', `path does not exist or is not readable: ${relative}`, { exitCode: 2 });
    }
  }
  if (info) {
    if (!inside(absoluteRoot, real)) {
      throw new AppError('PATH_OUT_OF_SCOPE', 'path resolves outside the authorized source root', { exitCode: 2 });
    }
    const realRelative = normalizePath(path.relative(absoluteRoot, real)) || '.';
    if (isSensitivePath(realRelative)) {
      throw new AppError('SENSITIVE_PATH', 'sensitive files and Git metadata are not accessible', { exitCode: 2 });
    }
    if (requireDirectory && !info.isDirectory()) {
      throw new AppError('PATH_NOT_DIRECTORY', `path is not a directory: ${relative}`, { exitCode: 2 });
    }
    if (requireFile && !info.isFile()) {
      throw new AppError('PATH_NOT_FILE', `path is not a file: ${relative}`, { exitCode: 2 });
    }
  }
  return { root: absoluteRoot, absolute, real, relative, info };
}
