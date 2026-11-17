import { execFile } from 'node:child_process';
import { lstat, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { AppError } from '../core/errors.mjs';
import { redactSecrets } from '../core/redact.mjs';
import { inside, isSensitivePath, normalizePath, resolveWithinRoot } from '../core/path-policy.mjs';

const exec = promisify(execFile);
const TIMEOUT_MS = 8000;
const MAX_BUFFER = 8 * 1024 * 1024;
const MAX_STATUS_ENTRIES = 200;
const MAX_LOG_COMMITS = 50;
const MAX_LOG_FILES = 50;
const MAX_DIFF_FILES = 200;
const MAX_PATCH_BYTES = 32 * 1024;
const MAX_PATCH_LINES = 200;

function gitEnv() {
  return {
    ...process.env,
    GIT_PAGER: 'cat',
    PAGER: 'cat',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0',
  };
}

const GIT_GLOBAL_ARGS = [
  '--no-pager',
  '--no-optional-locks',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'diff.external=',
  '-c',
  'core.quotepath=false',
];

function decodeOutput(buffer) {
  return Buffer.isBuffer(buffer) ? buffer.toString('utf8') : String(buffer ?? '');
}

async function runGit(root, args) {
  try {
    const result = await exec('git', [...GIT_GLOBAL_ARGS, '-C', root, ...args], {
      timeout: TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: MAX_BUFFER,
      encoding: 'buffer',
      env: gitEnv(),
    });
    return decodeOutput(result.stdout);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new AppError('GIT_UNAVAILABLE', 'git 不可用；请安装 Git 并加入 PATH', { exitCode: 3 });
    }
    throw new AppError('GIT_COMMAND_FAILED', 'Git 只读命令执行失败（可能不是 Git 仓库或仓库不可读）', {
      exitCode: 3,
      cause: error,
    });
  }
}

async function resolveRepo(root) {
  if (!root) throw new AppError('SOURCE_ROOT_REQUIRED', 'source root is not configured', { exitCode: 3 });
  const absoluteRoot = path.resolve(root);
  let info;
  try {
    info = await stat(absoluteRoot);
  } catch {
    throw new AppError('PATH_NOT_FOUND', `source root does not exist: ${absoluteRoot}`, { exitCode: 2 });
  }
  if (!info.isDirectory()) {
    throw new AppError('PATH_NOT_DIRECTORY', 'source root is not a directory', { exitCode: 2 });
  }
  let top;
  try {
    top = (await runGit(absoluteRoot, ['rev-parse', '--show-toplevel'])).trim();
  } catch (error) {
    if (error?.code === 'GIT_UNAVAILABLE') throw error;
    throw new AppError('NOT_A_GIT_REPO', '源码根不是 Git 仓库，或 Git 无法读取仓库信息', { exitCode: 2 });
  }
  if (!top) throw new AppError('NOT_A_GIT_REPO', '源码根不是 Git 仓库', { exitCode: 2 });
  const repoRoot = path.resolve(top);
  if (!inside(repoRoot, absoluteRoot)) {
    throw new AppError('PATH_OUT_OF_SCOPE', 'source root is outside the resolved Git repository', { exitCode: 2 });
  }
  return { root: absoluteRoot, repoRoot };
}

function validatePathspec(root, target) {
  if (!target || String(target).trim() === '') return '.';
  const absolute = path.resolve(root, String(target));
  if (!inside(root, absolute)) {
    throw new AppError('PATH_OUT_OF_SCOPE', 'path is outside the authorized source root', { exitCode: 2 });
  }
  const relative = normalizePath(path.relative(root, absolute)) || '.';
  if (isSensitivePath(relative)) {
    throw new AppError('SENSITIVE_PATH', 'sensitive files and Git metadata are not accessible', { exitCode: 2 });
  }
  return relative;
}

function optionalLimit(value, fallback, { min, max, code, label }) {
  const number = Number(value ?? fallback);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new AppError(code, `${label} must be an integer between ${min} and ${max}`, { exitCode: 2 });
  }
  return number;
}

function truncateText(text, { maxBytes = MAX_PATCH_BYTES, maxLines = MAX_PATCH_LINES } = {}) {
  const lines = text.split(/\r?\n/);
  const byLines = lines.slice(0, maxLines).join('\n');
  const output = Buffer.byteLength(byLines) > maxBytes
    ? Buffer.from(byLines, 'utf8').subarray(0, maxBytes).toString('utf8')
    : byLines;
  return { text: output, truncated: output.length < text.length };
}

/** Parse `git status --porcelain=v2 --branch` output. */
export function parseStatusV2(text) {
  const result = { branch: null, upstream: null, ahead: 0, behind: 0, entries: [] };
  for (const line of String(text ?? '').split(/\r?\n/)) {
    if (!line) continue;
    if (line.startsWith('# branch.head ')) {
      result.branch = line.slice('# branch.head '.length).trim();
      continue;
    }
    if (line.startsWith('# branch.upstream ')) {
      result.upstream = line.slice('# branch.upstream '.length).trim();
      continue;
    }
    const ab = line.match(/^# branch\.ab \+(\d+) -(\d+)$/);
    if (ab) {
      result.ahead = Number(ab[1]);
      result.behind = Number(ab[2]);
      continue;
    }
    if (line.startsWith('? ')) {
      result.entries.push({ index: '?', worktree: '?', path: line.slice(2) });
      continue;
    }
    if (line.startsWith('1 ')) {
      const parts = line.split(' ');
      result.entries.push({
        index: parts[1]?.[0] ?? '.',
        worktree: parts[1]?.[1] ?? '.',
        path: parts.slice(8).join(' '),
      });
      continue;
    }
    if (line.startsWith('2 ')) {
      const parts = line.split(' ');
      const rest = parts.slice(9).join(' ');
      const tab = rest.indexOf('\t');
      result.entries.push({
        index: parts[1]?.[0] ?? '.',
        worktree: parts[1]?.[1] ?? '.',
        path: tab >= 0 ? rest.slice(0, tab) : rest,
        from: tab >= 0 ? rest.slice(tab + 1) : null,
      });
      continue;
    }
    if (line.startsWith('u ')) {
      const parts = line.split(' ');
      result.entries.push({
        index: parts[1]?.[0] ?? 'U',
        worktree: parts[1]?.[1] ?? 'U',
        path: parts.slice(10).join(' '),
      });
    }
  }
  return result;
}

export async function gitStatus({ root } = {}) {
  const repo = await resolveRepo(root);
  const stdout = await runGit(repo.root, [
    'status',
    '--porcelain=v2',
    '--branch',
    '--no-renames',
    '--',
    '.',
  ]);
  const parsed = parseStatusV2(stdout);
  let hiddenSensitive = 0;
  let truncated = false;
  const entries = [];
  for (const entry of parsed.entries) {
    const relative = normalizePath(entry.path);
    if (isSensitivePath(relative)) {
      hiddenSensitive += 1;
      continue;
    }
    entries.push({
      index: entry.index,
      worktree: entry.worktree,
      path: relative,
      ...(entry.from ? { from: normalizePath(entry.from) } : {}),
    });
    if (entries.length >= MAX_STATUS_ENTRIES) {
      truncated = true;
      break;
    }
  }
  return {
    repo: path.basename(repo.repoRoot),
    branch: parsed.branch === '(detached)' ? null : parsed.branch,
    upstream: parsed.upstream === '(gone)' ? null : parsed.upstream,
    ahead: parsed.ahead,
    behind: parsed.behind,
    clean: parsed.entries.length === 0,
    entries,
    count: entries.length,
    truncated,
    hiddenSensitive,
  };
}

/** Parse a `--format=%h%x1f%ad%x1f%s --name-only` log. */
export function parseLogOutput(text) {
  const commits = [];
  let current = null;
  for (const line of String(text ?? '').split(/\r?\n/)) {
    if (line.includes('\x1f')) {
      if (current) commits.push(current);
      const [hash, date, subject] = line.split('\x1f');
      current = hash ? { hash, date: date || null, subject: subject ?? '', files: [] } : null;
      continue;
    }
    if (!line.trim()) continue;
    if (current) current.files.push(line.trim());
  }
  if (current) commits.push(current);
  return commits;
}

export async function gitLog({ root, limit = 20, since = null, path: target = null } = {}) {
  const commitLimit = optionalLimit(limit, 20, {
    min: 1,
    max: MAX_LOG_COMMITS,
    code: 'INVALID_LIMIT',
    label: 'limit',
  });
  const sinceText = since === null || since === undefined || since === ''
    ? null
    : String(since).trim().slice(0, 80);
  if (sinceText && /[\r\n\0]/.test(sinceText)) {
    throw new AppError('INVALID_SINCE', 'since must not contain control characters', { exitCode: 2 });
  }
  const repo = await resolveRepo(root);
  const pathspec = validatePathspec(repo.root, target);
  const stdout = await runGit(repo.root, [
    'log',
    '--no-color',
    '--no-decorate',
    '--date=short',
    '--format=%h%x1f%ad%x1f%s',
    '--name-only',
    '--relative',
    '-n',
    String(commitLimit + 1),
    ...(sinceText ? [`--since=${sinceText}`] : []),
    '--',
    pathspec,
  ]);
  const parsed = parseLogOutput(stdout);
  const truncated = parsed.length > commitLimit;
  let hiddenSensitive = 0;
  const commits = parsed.slice(0, commitLimit).map((commit) => {
    const files = [];
    for (const file of commit.files) {
      const relative = normalizePath(file);
      if (isSensitivePath(relative)) {
        hiddenSensitive += 1;
        continue;
      }
      if (files.length < MAX_LOG_FILES) files.push(relative);
    }
    return {
      hash: commit.hash,
      date: commit.date,
      subject: redactSecrets(commit.subject ?? ''),
      files,
      ...(commit.files.length > MAX_LOG_FILES ? { filesTruncated: true } : {}),
    };
  });
  return {
    repo: path.basename(repo.repoRoot),
    commits,
    count: commits.length,
    truncated,
    hiddenSensitive,
  };
}

export async function gitDiff({ root, path: target = null, staged = false, statOnly = true } = {}) {
  const repo = await resolveRepo(root);
  const stagedArgs = staged ? ['--cached'] : [];
  if (statOnly) {
    const pathspec = validatePathspec(repo.root, target);
    const stdout = await runGit(repo.root, [
      'diff',
      '--no-ext-diff',
      '--no-textconv',
      '--no-color',
      '--no-renames',
      '--numstat',
      '--relative',
      ...stagedArgs,
      '--',
      pathspec,
    ]);
    let hiddenSensitive = 0;
    let truncated = false;
    const files = [];
    for (const line of stdout.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const parts = line.split('\t');
      if (parts.length < 3) continue;
      const relative = normalizePath(parts.slice(2).join('\t'));
      if (isSensitivePath(relative)) {
        hiddenSensitive += 1;
        continue;
      }
      const binary = parts[0] === '-' || parts[1] === '-';
      files.push({
        path: relative,
        additions: binary ? null : Number(parts[0]) || 0,
        deletions: binary ? null : Number(parts[1]) || 0,
        binary,
      });
      if (files.length >= MAX_DIFF_FILES) {
        truncated = true;
        break;
      }
    }
    return {
      repo: path.basename(repo.repoRoot),
      staged: Boolean(staged),
      statOnly: true,
      files,
      count: files.length,
      truncated,
      hiddenSensitive,
    };
  }

  if (!target || !String(target).trim()) {
    throw new AppError('DIFF_PATH_REQUIRED', 'full git_diff requires a single file path', { exitCode: 2 });
  }
  const resolved = await resolveWithinRoot(repo.root, target, { allowMissing: true });
  if (resolved.info?.isDirectory()) {
    throw new AppError('PATH_NOT_FILE', 'full git_diff only accepts a file path', { exitCode: 2 });
  }
  const pathspec = resolved.relative;
  const stdout = await runGit(repo.root, [
    'diff',
    '--no-ext-diff',
    '--no-textconv',
    '--no-color',
    '--no-renames',
    '--unified=3',
    '--relative',
    ...stagedArgs,
    '--',
    pathspec,
  ]);
  const redacted = redactSecrets(stdout);
  const clipped = truncateText(redacted);
  return {
    repo: path.basename(repo.repoRoot),
    staged: Boolean(staged),
    statOnly: false,
    path: pathspec,
    patch: clipped.text,
    lines: clipped.text.split(/\r?\n/).length,
    truncated: clipped.truncated,
  };
}
