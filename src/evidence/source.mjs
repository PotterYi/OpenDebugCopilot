import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { AppError } from '../core/errors.mjs';

const SOURCE_EXTS = new Set([
  '.java', '.kt', '.scala', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx',
  '.py', '.go', '.cs', '.rb', '.php', '.rs', '.vue', '.proto',
]);
const IGNORED_DIRS = new Set([
  'node_modules', '.git', '.tmp', 'runs', 'dist', 'build', 'target', 'out',
  'coverage', '.idea', '.vscode', '.next', '.nuxt', 'vendor',
]);
const MAX_FILE_BYTES = 2 * 1024 * 1024;

const isSourceFile = (file) => SOURCE_EXTS.has(path.extname(file).toLowerCase());

/**
 * Walk a source tree, skipping vendored/build directories.
 *
 * @param {string} root
 * @param {{ limit?: number }} [options]
 * @returns {Promise<string[]>} absolute file paths
 */
export async function walkSourceFiles(root, { limit = 20000 } = {}) {
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
    for (const entry of entries) {
      if (out.length >= limit) break;
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name) && !entry.name.startsWith('.')) queue.push(absolute);
      } else if (entry.isFile() && isSourceFile(entry.name)) {
        out.push(absolute);
      }
    }
  }
  return out;
}

function looksLikePath(target) {
  const ext = path.extname(target).toLowerCase();
  return target.includes('/') || target.includes('\\') || SOURCE_EXTS.has(ext);
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
  const text = await readFile(file, 'utf8');
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
 * Read source by path or class name.
 * Class names never guess: ambiguous same-name files are returned as candidates.
 *
 * @param {{
 *   sourceRoot: string,
 *   target: string,
 *   startLine?: number,
 *   endLine?: number,
 *   maxLines?: number,
 *   maxCandidates?: number
 * }} options
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
    const direct = path.resolve(root, target);
    try {
      const info = await stat(direct);
      if (info.isFile()) {
        return await readFileRange(direct, root, startLine, endLine, maxLines);
      }
    } catch {
      // fall through to basename search
    }
    const basename = path.basename(target);
    const simple = path.basename(basename, path.extname(basename));
    const files = (await walkSourceFiles(root)).filter(
      (file) => path.basename(file, path.extname(file)) === simple,
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
  const files = (await walkSourceFiles(root)).filter(
    (file) => path.basename(file, path.extname(file)) === simpleName,
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

/**
 * Keyword search across source files. Case-insensitive, line-based.
 *
 * @param {{ sourceRoot: string, keyword: string, limit?: number, caseSensitive?: boolean }} options
 */
export async function searchSource({ sourceRoot, keyword, limit = 50, caseSensitive = false }) {
  if (!sourceRoot) {
    throw new AppError('SOURCE_ROOT_REQUIRED', 'source.root is required for search_source', { exitCode: 3 });
  }
  if (!keyword || typeof keyword !== 'string') {
    throw new AppError('SOURCE_KEYWORD_REQUIRED', 'search_source requires a non-empty keyword', { exitCode: 2 });
  }
  const root = path.resolve(sourceRoot);
  const files = await walkSourceFiles(root);
  const matches = [];
  let scanned = 0;
  const needle = caseSensitive ? keyword : keyword.toLowerCase();

  for (const file of files) {
    if (matches.length >= limit) break;
    let text;
    try {
      const info = await stat(file);
      if (info.size > MAX_FILE_BYTES) continue;
      text = await readFile(file, 'utf8');
    } catch {
      continue;
    }
    scanned += 1;
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      const haystack = caseSensitive ? lines[i] : lines[i].toLowerCase();
      if (haystack.includes(needle)) {
        matches.push({
          path: path.relative(root, file).split(path.sep).join('/'),
          line: i + 1,
          text: lines[i].trim().slice(0, 300),
        });
        if (matches.length >= limit) break;
      }
    }
  }

  return { matches, scanned, truncated: matches.length >= limit };
}
