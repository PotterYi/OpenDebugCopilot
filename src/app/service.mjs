import { readdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { AppError } from '../core/errors.mjs';
import { createStore } from '../core/store.mjs';
import { getLogFile } from '../core/logger.mjs';

const RUN_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

/**
 * Shared service layer used by both the HTTP API and Electron IPC.
 *
 * @param {{ root?: string, configDir?: string, runsDir?: string }} [options]
 */
export function createService({ root = process.cwd(), configDir, runsDir } = {}) {
  const store = createStore({ configDir: configDir ?? path.join(root, 'configs') });
  const runsRoot = path.resolve(runsDir ?? path.join(root, 'runs'));

  async function getConfig() {
    return {
      workspace: await store.getWorkspace(),
      routing: await store.getRouting(),
      meta: {
        configDir: path.resolve(configDir ?? path.join(root, 'configs')),
        runsDir: runsRoot,
        logFile: getLogFile(),
      },
    };
  }

  async function saveConfig(patch) {
    if (!patch || typeof patch !== 'object') {
      throw new AppError('CONFIG_INVALID', 'Config patch must be an object', { exitCode: 2 });
    }
    if (patch.workspace !== undefined) await store.saveWorkspace(patch.workspace);
    if (patch.routing !== undefined) await store.saveRouting(patch.routing);
    return getConfig();
  }

  async function listRuns({ limit = 50 } = {}) {
    let names = [];
    try {
      names = await readdir(runsRoot);
    } catch (err) {
      if (err && err.code === 'ENOENT') return [];
      throw err;
    }
    const runs = [];
    for (const name of names) {
      if (!RUN_ID_PATTERN.test(name)) continue;
      try {
        const meta = JSON.parse(await readFile(path.join(runsRoot, name, 'meta.json'), 'utf8'));
        runs.push({
          runId: name,
          scenario: meta.scenario ?? null,
          driver: meta.driver ?? null,
          agent: meta.agent ?? null,
          mode: meta.mode ?? null,
          startedAt: meta.startedAt ?? null,
          endedAt: meta.endedAt ?? null,
          durationMs: meta.durationMs ?? null,
          question: meta.question ?? '',
        });
      } catch {
        // skip incomplete runs
      }
    }
    runs.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
    return runs.slice(0, limit);
  }

  async function getRun(runId) {
    if (!RUN_ID_PATTERN.test(String(runId))) {
      throw new AppError('RUN_ID_INVALID', `Invalid run id: ${runId}`, { exitCode: 2 });
    }
    const dir = path.join(runsRoot, runId);
    let result;
    try {
      result = JSON.parse(await readFile(path.join(dir, 'result.json'), 'utf8'));
    } catch (err) {
      throw new AppError('RUN_NOT_FOUND', `Run not found: ${runId}`, { exitCode: 3, cause: err });
    }
    let report = null;
    try {
      report = await readFile(path.join(dir, 'report.md'), 'utf8');
    } catch {
      // report is optional
    }
    return { runId, result, report };
  }

  async function deleteRun(runId) {
    if (!RUN_ID_PATTERN.test(String(runId))) {
      throw new AppError('RUN_ID_INVALID', `Invalid run id: ${runId}`, { exitCode: 2 });
    }
    const dir = path.join(runsRoot, runId);
    try {
      // Deletes result/report/meta/run log/backups and verification logs together.
      await rm(dir, { recursive: true });
    } catch (err) {
      if (err && err.code === 'ENOENT') {
        throw new AppError('RUN_NOT_FOUND', `Run not found: ${runId}`, { exitCode: 3, cause: err });
      }
      throw new AppError('RUN_DELETE_FAILED', `Cannot delete run ${runId}`, { cause: err });
    }
    return { runId, deleted: true };
  }

  async function listProfiles() {
    return store.listProfiles();
  }

  async function createProfile(name, snapshot = {}) {
    await store.createProfile(name, snapshot);
    return getConfig();
  }

  async function switchProfile(id) {
    await store.switchProfile(id);
    return getConfig();
  }

  async function renameProfile(id, name) {
    await store.renameProfile(id, name);
    return getConfig();
  }

  async function deleteProfile(id) {
    await store.deleteProfile(id);
    return getConfig();
  }

  return {
    root,
    runsRoot,
    configDir: path.resolve(configDir ?? path.join(root, 'configs')),
    store,
    getConfig,
    saveConfig,
    listRuns,
    getRun,
    deleteRun,
    listProfiles,
    createProfile,
    switchProfile,
    renameProfile,
    deleteProfile,
  };
}
