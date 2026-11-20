import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { AppError } from '../core/errors.mjs';
import { DEFAULT_IGNORED_DIRS, isSensitivePath, resolveWithinRoot } from '../core/path-policy.mjs';
import { MAX_TOTAL_ITEMS } from '../core/list-result.mjs';
import { MAX_FILE_BYTES, scanFiles } from './source-scan.mjs';
import { decodeTextBuffer } from '../core/text-decode.mjs';

const SOURCE_EXTS = new Set([
  '.java', '.kt', '.scala', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx',
  '.py', '.go', '.cs', '.rb', '.php', '.rs', '.vue', '.proto',
]);
const CONFIG_EXTS = new Set([
  '.xml', '.yml', '.yaml', '.properties', '.json', '.toml',
  '.gradle', '.kts', '.ini', '.conf', '.cfg',
]);
const CONFIG_NAMES = new Set(['dockerfile', 'makefile', '.editorconfig']);
// Direct read (stack mapping, incidental frontend files) additionally accepts
// view/template assets that are neither code nor config for search purposes.
const READABLE_EXTRA_EXTS = new Set([
  '.html', '.htm', '.css', '.scss', '.sass', '.less', '.svelte', '.astro', '.sql',
]);
const EXCLUDED_NAMES = new Set([
  'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml',
]);
const EXCLUDED_FILE = /(?:\.min\.(?:js|css)|\.map)$/i;
const MAX_REGEX_SOURCE = 200;
const DEFAULT_REGEX_TIMEOUT_MS = 5000;
const BACKSLASH = String.fromCharCode(92);
export const MAX_SEARCH_MATCHES = MAX_TOTAL_ITEMS;

const UNREADABLE_TYPES = 'supported types: source code, config (.xml/.yml/.yaml/.properties/.json/.toml/.gradle/.kts/.ini/.conf/.cfg, Dockerfile, Makefile, .editorconfig), or frontend assets (.html/.css/.scss/.less/.svelte/.astro)';

const isSourceFile = (file) => SOURCE_EXTS.has(path.extname(file).toLowerCase());
const isConfigFile = (file) => {
  const name = path.basename(file).toLowerCase();
  return CONFIG_NAMES.has(name) || CONFIG_EXTS.has(path.extname(name).toLowerCase());
};
const isExcludedFile = (file) => {
  const name = path.basename(file).toLowerCase();
  return EXCLUDED_NAMES.has(name) || EXCLUDED_FILE.test(name);
};
export const isReadableFileType = (file) => {
  if (isSourceFile(file) || isConfigFile(file)) return true;
  return READABLE_EXTRA_EXTS.has(path.extname(file).toLowerCase());
};
const isSearchableFile = (file, includeConfig) => {
  if (isExcludedFile(file) || isSensitivePath(file)) return false;
  return isSourceFile(file) || (includeConfig && isConfigFile(file));
};
const byPath = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Walk a source tree, skipping vendored/build directories and credential files.
 *
 * @param {string} root
 * @param {{ limit?: number, includeConfig?: boolean }} [options]
 * @returns {Promise<string[]>} absolute file paths, sorted for stable paging
 */
export async function walkSourceFiles(root, { limit = 20000, includeConfig = true } = {}) {
  const out = [];
  const queue = [path.resolve(root)];
  while (queue.length > 0 && out.length < limit) {
    const dir = queue.shift();
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => byPath(a.name, b.name));
    for (const entry of entries) {
      if (out.length >= limit) break;
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!DEFAULT_IGNORED_DIRS.has(entry.name) && !entry.name.startsWith('.')) queue.push(absolute);
      } else if (entry.isFile() && isSearchableFile(entry.name, includeConfig)) {
        out.push(absolute);
      }
    }
  }
  return out.sort(byPath);
}

function looksLikePath(target) {
  return target.includes('/') || target.includes(BACKSLASH) || isReadableFileType(target);
}

function scoreCandidate(file, packagePath, simpleName) {
  const normalized = file.split(path.sep).join('/');
  let score = 0;
  if (path.basename(file, path.extname(file)) === simpleName) score += 10;
  if (packagePath && normalized.includes(`/${packagePath}/`)) score += 20;
  return score;
}

async function readFileRange(file, root, startLine, endLine, maxLines) {
  const info = await stat(file);
  if (info.size > MAX_FILE_BYTES) {
    return { found: false, reason: 'file-too-large', path: path.relative(root, file), bytes: info.size };
  }
  const text = decodeTextBuffer(await readFile(file)).text;
  const lines = text.split(/\r?\n/);
  const from = Math.max(1, startLine ?? 1);
  const to = Math.min(lines.length, endLine ?? from + maxLines - 1);
  const slice = lines.slice(from - 1, to);
  return {
    found: true,
    path: file,
    relativePath: path.relative(root, file).split(path.sep).join('/'),
    startLine: from,
    endLine: to,
    totalLines: lines.length,
    content: slice.join('\n'),
    truncated: to < lines.length,
  };
}

/**
 * Read source or config by path, or source by class name.
 * Class names never guess: ambiguous same-name files are returned as candidates.
 */
export async function readSource({
  sourceRoot,
  target,
  startLine,
  endLine,
  maxLines = 200,
  maxCandidates = 20,
}) {
  if (!sourceRoot) {
    throw new AppError('SOURCE_ROOT_REQUIRED', 'source.root is required for read_source', { exitCode: 3 });
  }
  if (!target || typeof target !== 'string') {
    throw new AppError('SOURCE_TARGET_REQUIRED', 'read_source requires a target (path or class name)', { exitCode: 2 });
  }
  const root = path.resolve(sourceRoot);

  if (looksLikePath(target)) {
    const basename = path.basename(target);
    if (!isReadableFileType(basename)) {
      throw new AppError('SOURCE_FILE_TYPE_UNSUPPORTED', `read_source does not read this file type; ${UNREADABLE_TYPES}`, {
        exitCode: 2,
      });
    }
    let resolved = null;
    try {
      resolved = await resolveWithinRoot(root, target, { requireFile: true });
    } catch (error) {
      if (error?.code !== 'PATH_NOT_FOUND' && error?.code !== 'PATH_NOT_FILE') throw error;
    }
    if (resolved) return readFileRange(resolved.absolute, root, startLine, endLine, maxLines);

    const simple = path.basename(basename, path.extname(basename));
    const files = (await walkSourceFiles(root)).filter(
      (file) => path.basename(file) === basename || path.basename(file, path.extname(file)) === simple,
    );
    if (files.length === 1) return readFileRange(files[0], root, startLine, endLine, maxLines);
    return {
      found: false,
      reason: files.length === 0 ? 'not-found' : 'ambiguous',
      candidates: files.slice(0, maxCandidates).map((file) => ({
        path: path.relative(root, file).split(path.sep).join('/'),
      })),
    };
  }

  const segments = target.split('.').filter(Boolean);
  const simpleName = segments[segments.length - 1];
  const packagePath = segments.slice(0, -1).join('/');
  const files = (await walkSourceFiles(root, { includeConfig: false })).filter(
    (file) => isSourceFile(file) && path.basename(file, path.extname(file)) === simpleName,
  );
  const scored = files
    .map((file) => ({ file, score: scoreCandidate(file, packagePath, simpleName) }))
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) return { found: false, reason: 'not-found', candidates: [] };

  const best = scored[0].score;
  const top = scored.filter((entry) => entry.score === best);
  if (top.length > 1) {
    return {
      found: false,
      reason: 'ambiguous',
      candidates: top.slice(0, maxCandidates).map((entry) => ({
        path: path.relative(root, entry.file).split(path.sep).join('/'),
      })),
    };
  }
  return readFileRange(top[0].file, root, startLine, endLine, maxLines);
}

export function validateRegexPattern(source) {
  if (typeof source !== 'string' || !source) {
    throw new AppError('SOURCE_KEYWORD_REQUIRED', 'search_source requires a non-empty keyword', { exitCode: 2 });
  }
  if (source.length > MAX_REGEX_SOURCE) {
    throw new AppError('SOURCE_REGEX_TOO_LONG', `regex is limited to ${MAX_REGEX_SOURCE} characters`, { exitCode: 2 });
  }
  const unsafe = [
    [new RegExp(BACKSLASH + BACKSLASH + '[1-9]'), 'backreference'],
    [new RegExp(BACKSLASH + BACKSLASH + 'k<'), 'named-backreference'],
    [/[(][?]<[=!]/, 'lookbehind'],
    [new RegExp('[(][^()]*[+*][^()]*[)](?:[+*]|[{]' + BACKSLASH + 'd*,?' + BACKSLASH + 'd*[}])'), 'nested-quantifier'],
  ];
  for (const [pattern, reason] of unsafe) {
    if (pattern.test(source)) {
      throw new AppError('SOURCE_REGEX_UNSAFE', `regex rejected (${reason}); use a literal keyword or a simpler pattern`, {
        exitCode: 2,
        details: { reason },
      });
    }
  }
  try {
    new RegExp(source);
  } catch (error) {
    throw new AppError('SOURCE_REGEX_INVALID', `invalid regex: ${error.message}`, { exitCode: 2 });
  }
  return true;
}

function regexTimeoutResult(timeoutMs) {
  return {
    matches: [],
    scannedFiles: 0,
    scannedBytes: 0,
    capped: false,
    timedOut: true,
    error: `regex search timed out after ${timeoutMs}ms; narrow the pattern or use a literal keyword`,
  };
}

async function runRegexWorker(data, timeoutMs) {
  // Do not inherit CLI flags such as --input-type/--inspect: they can make the
  // worker reject the module entry point when the app is launched from a test
  // runner or a debug session.
  const worker = new Worker(new URL('./source-regex-worker.mjs', import.meta.url), {
    workerData: data,
    execArgv: [],
  });
  try {
    return await new Promise((resolve, reject) => {
      let settled = false;
      let timer = null;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        callback(value);
      };
      timer = setTimeout(() => {
        finish(resolve, regexTimeoutResult(timeoutMs));
        worker.terminate().catch(() => {});
      }, timeoutMs);
      worker.once('message', (message) => {
        if (message?.ok) finish(resolve, message.result);
        else finish(reject, new AppError('SOURCE_SEARCH_FAILED', `regex search failed: ${message?.error ?? 'unknown error'}`, { exitCode: 3 }));
      });
      worker.once('error', (error) => {
        finish(reject, new AppError('SOURCE_SEARCH_FAILED', `regex search failed: ${error?.message ?? String(error)}`, { exitCode: 3 }));
      });
      worker.once('exit', (code) => {
        if (!settled && code !== 0) {
          finish(reject, new AppError('SOURCE_SEARCH_FAILED', `regex worker exited with code ${code}`, { exitCode: 3 }));
        }
      });
    });
  } finally {
    worker.terminate().catch(() => {});
  }
}

export async function searchSource({
  sourceRoot,
  keyword,
  caseSensitive = false,
  regex = false,
  includeConfig = true,
  timeoutMs = DEFAULT_REGEX_TIMEOUT_MS,
}) {
  if (!sourceRoot) {
    throw new AppError('SOURCE_ROOT_REQUIRED', 'source.root is required for search_source', { exitCode: 3 });
  }
  if (!keyword || typeof keyword !== 'string') {
    throw new AppError('SOURCE_KEYWORD_REQUIRED', 'search_source requires a non-empty keyword', { exitCode: 2 });
  }
  if (regex) validateRegexPattern(keyword);
  const root = path.resolve(sourceRoot);
  const files = await walkSourceFiles(root, { includeConfig });
  const data = {
    files,
    root,
    keyword,
    regex,
    caseSensitive,
    maxMatches: MAX_SEARCH_MATCHES,
    maxFileBytes: MAX_FILE_BYTES,
  };
  if (!regex) return scanFiles(data);
  const limit = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_REGEX_TIMEOUT_MS;
  return runRegexWorker(data, limit);
}
