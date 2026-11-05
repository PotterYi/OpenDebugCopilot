import { access, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { resolveScenarioPaths } from '../core/scenario.mjs';
import { checkDatabases } from '../evidence/db.mjs';

async function isReadable(target) {
  try {
    await access(target, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

async function isDirectory(target) {
  try {
    return (await stat(target)).isDirectory();
  } catch {
    return false;
  }
}

async function addDatabaseChecks(add, databases = []) {
  const enabled = (databases ?? []).filter((connection) => connection.enabled !== false);
  if (enabled.length === 0) {
    add('database', 'warn', true, '未配置或未启用数据库连接');
    return [];
  }
  const results = await checkDatabases(enabled);
  const byId = new Map(results.map((result) => [result.id, result]));
  for (const connection of enabled) {
    const result = byId.get(connection.id);
    add(
      `database:${connection.name || connection.id}`,
      'warn',
      Boolean(result?.ok),
      result?.ok
        ? `${connection.host}/${connection.database || '(no db)'} (${result.latencyMs}ms)`
        : (result?.error ?? 'unreachable'),
    );
  }
  const reachable = enabled.filter((connection) => byId.get(connection.id)?.ok);
  add(
    'database',
    'warn',
    reachable.length > 0,
    reachable.length > 0 ? `${reachable.length} 个可用` : '没有可达数据库，本次不提供数据库工具',
  );
  return reachable;
}

/**
 * Preflight checks that do not touch the target process.
 * Missing declared paths are errors; missing optional sections are warnings.
 *
 * @param {Readonly<Record<string, any>>} scenario
 * @returns {Promise<{ ok: boolean, checks: Array<{ name: string, severity: 'error' | 'warn', ok: boolean, detail?: string }> }>}
 */
export async function runPreflight(scenario, { databases = [] } = {}) {
  const checks = [];
  const add = (name, severity, ok, detail) => checks.push({ name, severity, ok, detail });

  add(
    'driver',
    'error',
    scenario.driverKind === 'browser' || scenario.driverKind === 'http',
    `driver=${scenario.driverKind}`,
  );

  add('base-url', 'error', Boolean(scenario.baseUrl), scenario.baseUrl ?? 'missing "baseUrl"');

  if (scenario.driverKind === 'browser') {
    const actions = scenario.browser?.actions ?? [];
    const supported = actions.every((action) => 'click' in action || 'fill' in action);
    add('browser-actions', 'error', supported, `${actions.length} action(s)`);
  }

  const paths = resolveScenarioPaths(scenario);
  if (paths.logfiles.length === 0) {
    add('logfiles', 'warn', true, 'no logfiles declared; diagnosis will run without log evidence');
  } else {
    for (const file of paths.logfiles) {
      const readable = await isReadable(file);
      add('logfile', 'error', readable, file);
    }
  }

  if (!paths.sourceRoot) {
    add('source-root', 'warn', true, 'no source.root declared; source tools will be unavailable');
  } else {
    add('source-root', 'error', await isDirectory(paths.sourceRoot), paths.sourceRoot);
  }

  const reachableDatabases = await addDatabaseChecks(add, databases);
  const ok = checks.every((check) => check.ok || check.severity === 'warn');
  return { ok, checks, databases: reachableDatabases };
}

/**
 * Preflight for captured-request diagnosis: no driver/baseUrl to fire.
 *
 * @param {{ logfiles?: string[], sourceRoot?: string | null }} [input]
 * @returns {Promise<{ ok: boolean, checks: Array<{ name: string, severity: 'error' | 'warn', ok: boolean, detail?: string }> }>}
 */
export async function runCapturePreflight({ logfiles = [], sourceRoot = null, databases = [] } = {}) {
  const checks = [];
  const add = (name, severity, ok, detail) => checks.push({ name, severity, ok, detail });

  if (logfiles.length === 0) {
    add('logfiles', 'warn', true, 'no logfiles declared; diagnosis will run without log evidence');
  } else {
    for (const file of logfiles) {
      add('logfile', 'error', await isReadable(file), file);
    }
  }

  if (!sourceRoot) {
    add('source-root', 'warn', true, 'no source.root declared; source tools will be unavailable');
  } else {
    add('source-root', 'error', await isDirectory(path.resolve(sourceRoot)), sourceRoot);
  }

  const reachableDatabases = await addDatabaseChecks(add, databases);
  const ok = checks.every((check) => check.ok || check.severity === 'warn');
  return { ok, checks, databases: reachableDatabases };
}
