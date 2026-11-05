import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { AppError } from './errors.mjs';

export const DEFAULT_WORKSPACE = Object.freeze({
  frontendUrl: 'http://localhost:5173',
  backendUrl: 'http://127.0.0.1:8080',
  logfiles: [],
  sourceRoot: '',
  extraSourceRoots: [],
  logParser: 'auto',
  frontendSourceRoot: '',
  frontendProjectRoot: '',
  frontendStartCommand: '',
  verifyCommand: '',
  agent: {
    model: '',
    maxTurns: 24,
    maxBudgetUsd: null,
    timeoutMs: 180000,
  },
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
    extraSourceRoots: Array.isArray(value.extraSourceRoots)
      ? value.extraSourceRoots.map(String).map((item) => item.trim()).filter(Boolean)
      : [],
    logParser: String(value.logParser ?? 'auto'),
    agent: (() => {
      const raw = isObject(value.agent) ? value.agent : {};
      const maxTurns = Number(raw.maxTurns === undefined ? DEFAULT_WORKSPACE.agent.maxTurns : raw.maxTurns);
      const maxBudget = Number(raw.maxBudgetUsd === undefined ? null : raw.maxBudgetUsd);
      const timeout = Number(raw.timeoutMs === undefined ? DEFAULT_WORKSPACE.agent.timeoutMs : raw.timeoutMs);
      return {
        model: String(raw.model ?? ''),
        maxTurns: Number.isFinite(maxTurns) && maxTurns > 0 ? Math.floor(maxTurns) : null,
        maxBudgetUsd: Number.isFinite(maxBudget) && maxBudget > 0 ? maxBudget : null,
        timeoutMs: Number.isFinite(timeout) && timeout > 0 ? Math.floor(timeout) : 180000,
      };
    })(),
    frontendSourceRoot: String(value.frontendSourceRoot ?? ''),
    frontendProjectRoot: String(value.frontendProjectRoot ?? ''),
    frontendStartCommand: String(value.frontendStartCommand ?? ''),
    verifyCommand: String(value.verifyCommand ?? ''),
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
  const profilesPath = path.join(configDir, 'profiles.json');

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

  function normalizeProfiles(value) {
    const rawProfiles = Array.isArray(value?.profiles) ? value.profiles : [];
    const profiles = rawProfiles
      .filter(isObject)
      .map((profile) => ({
        id: String(profile.id ?? '').trim(),
        name: String(profile.name ?? '').trim() || '未命名配置',
        workspace: isObject(profile.workspace) ? profile.workspace : undefined,
        routing: isObject(profile.routing) ? profile.routing : undefined,
        createdAt: Number(profile.createdAt) || Date.now(),
        updatedAt: Number(profile.updatedAt) || Date.now(),
      }))
      .filter((profile) => profile.id);
    let activeId = value?.activeId ? String(value.activeId) : null;
    if (!profiles.some((profile) => profile.id === activeId)) activeId = null;
    return { activeId, profiles };
  }

  async function readProfiles() {
    return normalizeProfiles(await readJson(profilesPath, { activeId: null, profiles: [] }));
  }

  async function writeProfiles(state) {
    await writeJsonAtomic(profilesPath, state);
  }

  function summary(state) {
    return {
      activeId: state.activeId,
      profiles: state.profiles.map((profile) => ({
        id: profile.id,
        name: profile.name,
        frontendUrl: profile.workspace?.frontendUrl ?? '',
        backendUrl: profile.workspace?.backendUrl ?? '',
        createdAt: profile.createdAt,
        updatedAt: profile.updatedAt,
      })),
    };
  }

  async function getWorkspace() {
    return validateWorkspace(await readJson(workspacePath, DEFAULT_WORKSPACE));
  }

  async function getRouting() {
    return validateRouting(await readJson(routingPath, DEFAULT_ROUTING));
  }

  async function rememberActive(patch) {
    const state = await readProfiles();
    const active = state.profiles.find((profile) => profile.id === state.activeId);
    if (!active) return;
    if (patch.workspace) active.workspace = patch.workspace;
    if (patch.routing) active.routing = patch.routing;
    active.updatedAt = Date.now();
    await writeProfiles(state);
  }

  async function saveWorkspace(value) {
    const workspace = validateWorkspace(value);
    await writeJsonAtomic(workspacePath, workspace);
    await rememberActive({ workspace });
    return workspace;
  }

  async function saveRouting(value) {
    const routing = validateRouting(value);
    // Warnings are derived on every load; do not persist them.
    await writeJsonAtomic(routingPath, { rules: routing.rules });
    await rememberActive({ routing: { rules: routing.rules } });
    return routing;
  }

  async function listProfiles() {
    return summary(await readProfiles());
  }

  async function createProfile(name, snapshot = {}) {
    const profileName = String(name ?? '').trim();
    if (!profileName) throw new AppError('PROFILE_NAME_REQUIRED', 'Profile name is required', { exitCode: 2 });
    const workspace = snapshot.workspace !== undefined
      ? validateWorkspace(snapshot.workspace)
      : await getWorkspace();
    const routing = snapshot.routing !== undefined
      ? validateRouting(snapshot.routing)
      : { rules: (await getRouting()).rules };
    const state = await readProfiles();
    const now = Date.now();
    const existing = state.profiles.find((profile) => profile.name === profileName);
    if (existing) {
      // Saving under an existing name overwrites that profile instead of
      // accumulating duplicates such as "A", "A (2)", "A (3)".
      existing.workspace = workspace;
      existing.routing = { rules: routing.rules };
      existing.updatedAt = now;
      state.activeId = existing.id;
    } else {
      const id = `profile-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      state.profiles.push({
        id,
        name: profileName,
        workspace,
        routing: { rules: routing.rules },
        createdAt: now,
        updatedAt: now,
      });
      state.activeId = id;
    }
    await writeJsonAtomic(workspacePath, workspace);
    await writeJsonAtomic(routingPath, { rules: routing.rules });
    await writeProfiles(state);
    return summary(state);
  }

  async function switchProfile(id) {
    const state = await readProfiles();
    const profile = state.profiles.find((item) => item.id === id);
    if (!profile) throw new AppError('PROFILE_NOT_FOUND', `Profile not found: ${id}`, { exitCode: 3 });
    const workspace = validateWorkspace(profile.workspace ?? DEFAULT_WORKSPACE);
    const routing = validateRouting(profile.routing ?? DEFAULT_ROUTING);
    await writeJsonAtomic(workspacePath, workspace);
    await writeJsonAtomic(routingPath, { rules: routing.rules });
    state.activeId = id;
    await writeProfiles(state);
    return { workspace, routing };
  }

  async function renameProfile(id, name) {
    const profileName = String(name ?? '').trim();
    if (!profileName) throw new AppError('PROFILE_NAME_REQUIRED', 'Profile name is required', { exitCode: 2 });
    const state = await readProfiles();
    const profile = state.profiles.find((item) => item.id === id);
    if (!profile) throw new AppError('PROFILE_NOT_FOUND', `Profile not found: ${id}`, { exitCode: 3 });
    profile.name = profileName;
    profile.updatedAt = Date.now();
    await writeProfiles(state);
    return summary(state);
  }

  async function deleteProfile(id) {
    const state = await readProfiles();
    const index = state.profiles.findIndex((item) => item.id === id);
    if (index < 0) throw new AppError('PROFILE_NOT_FOUND', `Profile not found: ${id}`, { exitCode: 3 });
    const [removed] = state.profiles.splice(index, 1);
    if (state.activeId === id) {
      const fallback = state.profiles[0] ?? null;
      state.activeId = fallback?.id ?? null;
      if (fallback) {
        const workspace = validateWorkspace(fallback.workspace ?? DEFAULT_WORKSPACE);
        const routing = validateRouting(fallback.routing ?? DEFAULT_ROUTING);
        await writeJsonAtomic(workspacePath, workspace);
        await writeJsonAtomic(routingPath, { rules: routing.rules });
      }
    }
    await writeProfiles(state);
    return { ...summary(state), deleted: removed.id };
  }

  return {
    workspacePath,
    routingPath,
    profilesPath,
    getWorkspace,
    saveWorkspace,
    getRouting,
    saveRouting,
    listProfiles,
    createProfile,
    switchProfile,
    renameProfile,
    deleteProfile,
  };
}
