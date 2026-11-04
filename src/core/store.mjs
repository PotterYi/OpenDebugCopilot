import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { AppError } from './errors.mjs';

export const DEFAULT_WORKSPACE = Object.freeze({
  frontendUrl: 'http://localhost:5173',
  backendUrl: 'http://127.0.0.1:8080',
  logfiles: [],
  sourceRoot: '',
  frontendSourceRoot: '',
  frontendProjectRoot: '',
  frontendStartCommand: '',
  window: { beforeMs: 3000, afterMs: 2000 },
});

export const DEFAULT_ROUTING = Object.freeze({ rules: [] });

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function invalid(message) {
  throw new AppError('CONFIG_INVALID', message, { exitCode: 2 });
}

export function validateWorkspace(value) {
  if (!isObject(value)) invalid('workspace must be an object');
  const workspace = {
    frontendUrl: String(value.frontendUrl ?? ''),
    backendUrl: String(value.backendUrl ?? ''),
    logfiles: Array.isArray(value.logfiles) ? value.logfiles.map(String) : [],
    sourceRoot: String(value.sourceRoot ?? ''),
    frontendSourceRoot: String(value.frontendSourceRoot ?? ''),
    frontendProjectRoot: String(value.frontendProjectRoot ?? ''),
    frontendStartCommand: String(value.frontendStartCommand ?? ''),
    window: {
      beforeMs: Number(value.window?.beforeMs ?? DEFAULT_WORKSPACE.window.beforeMs),
      afterMs: Number(value.window?.afterMs ?? DEFAULT_WORKSPACE.window.afterMs),
    },
  };
  for (const key of ['beforeMs', 'afterMs']) {
    const n = workspace.window[key];
    if (!Number.isFinite(n) || n < 0) invalid(`workspace.window.${key} must be a non-negative number`);
  }
  return workspace;
}

export function validateRouting(value) {
  if (!isObject(value) || !Array.isArray(value.rules)) invalid('routing must contain a rules array');
  const ids = new Set();
  const warnings = [];
  const rules = value.rules.map((rule, index) => {
    if (!isObject(rule)) invalid(`routing.rules[${index}] must be an object`);
    const id = String(rule.id ?? '').trim();
    if (!id) invalid(`routing.rules[${index}].id is required`);
    if (ids.has(id)) invalid(`duplicate routing rule id: ${id}`);
    ids.add(id);
    const prefix = String(rule.match?.prefix ?? '').trim();
    if (!prefix.startsWith('/')) invalid(`routing rule ${id}: match.prefix must start with "/"`);
    const rawKind = rule.target?.kind;
    if (rawKind !== undefined && rawKind !== 'local' && rawKind !== 'sit') {
      warnings.push({
        ruleId: id,
        code: 'UNKNOWN_TARGET_KIND',
        message: `规则 ${id} 的路由方式「${rawKind}」无法识别，已按「改道」处理`,
      });
    }
    const kind = rawKind === 'sit' ? 'sit' : 'local';
    let baseUrl = String(rule.target?.baseUrl ?? '').trim();
    if (kind === 'local') {
      try {
        new URL(baseUrl);
      } catch {
        invalid(`routing rule ${id}: local target.baseUrl must be a valid URL`);
      }
    } else {
      // SIT means "do not intercept": the original request already goes to the gateway.
      // A non-empty baseUrl is contradictory; ignore it and tell the user.
      if (baseUrl) {
        warnings.push({
          ruleId: id,
          code: 'SIT_TARGET_IGNORED',
          baseUrl,
          message: `规则 ${id} 的路由方式是「原样透传」，目标地址 ${baseUrl} 会被忽略；若希望请求兜底到该地址，请把路由方式改为「改道」`,
        });
      }
      baseUrl = '';
    }
    return {
      id,
      enabled: rule.enabled !== false,
      match: {
        host: String(rule.match?.host ?? '').trim(),
        prefix,
      },
      target: { kind, baseUrl },
    };
  });
  return { rules, warnings };
}

/**
 * File-backed config store with atomic writes.
 *
 * @param {{ configDir?: string }} [options]
 */
export function createStore({ configDir = path.resolve('configs') } = {}) {
  const workspacePath = path.join(configDir, 'workspace.json');
  const routingPath = path.join(configDir, 'routing.json');

  async function readJson(file, fallback) {
    let text;
    try {
      text = await readFile(file, 'utf8');
    } catch (err) {
      if (err && err.code === 'ENOENT') return structuredClone(fallback);
      throw new AppError('CONFIG_READ_FAILED', `Cannot read ${file}`, { cause: err });
    }
    try {
      return JSON.parse(text);
    } catch (err) {
      throw new AppError('CONFIG_PARSE_FAILED', `Invalid JSON in ${file}`, { cause: err });
    }
  }

  async function writeJsonAtomic(file, value) {
    await mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await rename(tmp, file);
  }

  return {
    workspacePath,
    routingPath,
    async getWorkspace() {
      return validateWorkspace(await readJson(workspacePath, DEFAULT_WORKSPACE));
    },
    async saveWorkspace(value) {
      const workspace = validateWorkspace(value);
      await writeJsonAtomic(workspacePath, workspace);
      return workspace;
    },
    async getRouting() {
      return validateRouting(await readJson(routingPath, DEFAULT_ROUTING));
    },
    async saveRouting(value) {
      const routing = validateRouting(value);
      // Warnings are derived on every load; do not persist them.
      await writeJsonAtomic(routingPath, { rules: routing.rules });
      return routing;
    },
  };
}
