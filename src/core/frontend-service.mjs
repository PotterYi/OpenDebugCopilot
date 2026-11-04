import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const LOCKFILES = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['bun.lockb', 'bun'],
  ['bun.lock', 'bun'],
];
const SCRIPT_ORDER = ['dev', 'serve', 'start'];

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

function resolveFrom(rootDir, value) {
  return path.isAbsolute(value) ? path.resolve(value) : path.resolve(rootDir, value);
}

/**
 * Walk up from a source directory until a package.json is found.
 *
 * @param {string} startPath
 * @param {{ rootDir?: string }} [options]
 * @returns {Promise<string | null>}
 */
export async function findProjectRoot(startPath, { rootDir = process.cwd() } = {}) {
  if (!startPath) return null;
  let current = resolveFrom(rootDir, String(startPath).trim());
  if (await pathKind(current) === 'file') current = path.dirname(current);
  while (current) {
    if (await pathKind(path.join(current, 'package.json')) === 'file') return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return null;
}

/**
 * Detect the package manager and the most likely dev script.
 *
 * @param {string} projectRoot
 * @returns {Promise<{ ok: true, command: string, packageManager: string, script: string } | { ok: false, reason: string }>}
 */
export async function detectStartCommand(projectRoot) {
  let pkg;
  try {
    pkg = JSON.parse(await readFile(path.join(projectRoot, 'package.json'), 'utf8'));
  } catch (error) {
    return { ok: false, reason: `无法读取 package.json：${error?.message ?? error}` };
  }
  const scripts = pkg?.scripts ?? {};
  const script = SCRIPT_ORDER.find((name) => typeof scripts[name] === 'string' && scripts[name].trim());
  if (!script) {
    return { ok: false, reason: 'package.json 中没有 dev / serve / start 脚本' };
  }
  let packageManager = 'npm';
  for (const [file, manager] of LOCKFILES) {
    if (await pathKind(path.join(projectRoot, file)) === 'file') {
      packageManager = manager;
      break;
    }
  }
  return { ok: true, command: `${packageManager} run ${script}`, packageManager, script };
}

/**
 * Resolve the frontend launch command from workspace settings.
 * Explicit `frontendStartCommand` wins; otherwise infer the project root and dev script.
 *
 * @param {Record<string, any>} workspace
 * @param {{ rootDir?: string }} [options]
 * @returns {Promise<{ ok: true, cwd: string, command: string, source: string, packageManager: string | null, script: string | null } | { ok: false, reason: string, cwd?: string }>}
 */
export async function resolveFrontendLaunch(workspace = {}, { rootDir = process.cwd() } = {}) {
  const explicitRoot = String(workspace.frontendProjectRoot ?? '').trim();
  const sourceRoot = String(workspace.frontendSourceRoot ?? '').trim();

  if (!explicitRoot && sourceRoot) {
    const sourcePath = resolveFrom(rootDir, sourceRoot);
    if (await pathKind(sourcePath) === null) {
      return { ok: false, reason: `前端源码目录不存在：${sourcePath}` };
    }
  }

  const projectRoot = explicitRoot
    ? resolveFrom(rootDir, explicitRoot)
    : await findProjectRoot(sourceRoot, { rootDir });

  if (!projectRoot) {
    return { ok: false, reason: '未配置前端项目目录，且无法从前端源码目录找到 package.json' };
  }
  if (await pathKind(projectRoot) !== 'dir') {
    return { ok: false, reason: `前端项目目录不存在：${projectRoot}`, cwd: projectRoot };
  }

  const command = String(workspace.frontendStartCommand ?? '').trim();
  if (command) {
    return { ok: true, cwd: projectRoot, command, source: 'config', packageManager: null, script: null };
  }

  const detected = await detectStartCommand(projectRoot);
  if (!detected.ok) return { ok: false, reason: detected.reason, cwd: projectRoot };
  return {
    ok: true,
    cwd: projectRoot,
    command: detected.command,
    source: 'auto',
    packageManager: detected.packageManager,
    script: detected.script,
  };
}
