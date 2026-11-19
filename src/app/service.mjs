import { readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { AppError } from '../core/errors.mjs';
import { createStore } from '../core/store.mjs';
import { createDatabaseStore } from '../core/database-store.mjs';
import { createAgentAuthStore } from '../core/agent-auth-store.mjs';
import { createDiagnosisMemoryStore, projectIdentityForWorkspace } from '../core/diagnosis-memory.mjs';
import { finalizeWorkspaceJournal } from '../core/inplace-session.mjs';
import { checkDatabases } from '../evidence/db.mjs';
import { getLogFile } from '../core/logger.mjs';
import { buildReport, renderMarkdown } from '../report/report.mjs';
import { normalizeSymptomCheck, verificationLevel } from '../core/symptom.mjs';

const RUN_ID_PATTERN = /^[A-Za-z0-9._-]+$/;
const DB_QUERY_DIR = 'db-queries';

/**
 * Shared service layer used by both the HTTP API and Electron IPC.
 *
 * @param {{
 *   root?: string,
 *   configDir?: string,
 *   runsDir?: string,
 *   secretCodec?: { scheme?: string, encrypt?: (value: string) => string | null, decrypt?: (data: string) => string } | null
 * }} [options]
 */
export function createService({ root = process.cwd(), configDir, runsDir, secretCodec = null } = {}) {
  const effectiveConfigDir = configDir ?? path.join(root, 'configs');
  const store = createStore({ configDir: effectiveConfigDir });
  const databaseStore = createDatabaseStore({ configDir: effectiveConfigDir, secretCodec });
  const agentAuthStore = createAgentAuthStore({ configDir: effectiveConfigDir, secretCodec });
  const memoryStore = createDiagnosisMemoryStore({ configDir: effectiveConfigDir });
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
          workspaceSessionStatus: meta.workspaceSessionStatus ?? null,
          verificationStatus: meta.verificationStatus ?? null,
          testStatus: meta.testStatus ?? null,
          testRequired: Boolean(meta.testRequired),
          testBlocking: Boolean(meta.testBlocking),
          symptomStatus: meta.symptomStatus ?? null,
          verificationLevel: meta.verificationLevel ?? null,
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

  async function updateRunSymptom(runId, { status, note = null } = {}) {
    if (!RUN_ID_PATTERN.test(String(runId))) {
      throw new AppError('RUN_ID_INVALID', `Invalid run id: ${runId}`, { exitCode: 2 });
    }
    if (!['pending', 'passed', 'failed', 'skipped'].includes(status)) {
      throw new AppError('SYMPTOM_STATUS_INVALID', `Invalid symptom status: ${status}`, { exitCode: 2 });
    }
    const dir = path.join(runsRoot, runId);
    let result;
    try {
      result = JSON.parse(await readFile(path.join(dir, 'result.json'), 'utf8'));
    } catch (err) {
      throw new AppError('RUN_NOT_FOUND', `Run not found: ${runId}`, { exitCode: 3, cause: err });
    }
    const symptomCheck = normalizeSymptomCheck({
      ...(result.symptomCheck ?? {}),
      status,
      method: 'manual',
      note,
      markedAt: status === 'pending' ? null : new Date().toISOString(),
    });
    result.symptomCheck = symptomCheck;
    result.meta = result.meta ?? {};
    result.meta.symptomStatus = symptomCheck.status;
    result.meta.verificationLevel = verificationLevel({
      verification: result.agent?.verification,
      symptomCheck,
    });
    if (result.gates) {
      result.gates.symptom = { status: symptomCheck.status, method: 'manual' };
      result.gates.level = result.meta.verificationLevel;
    }
    const tmp = path.join(dir, 'result.json.tmp');
    await writeFile(tmp, JSON.stringify(result, null, 2), 'utf8');
    await rename(tmp, path.join(dir, 'result.json'));
    try {
      const metaPath = path.join(dir, 'meta.json');
      const meta = JSON.parse(await readFile(metaPath, 'utf8'));
      meta.symptomStatus = symptomCheck.status;
      meta.verificationLevel = result.meta.verificationLevel;
      const metaTmp = `${metaPath}.tmp`;
      await writeFile(metaTmp, JSON.stringify(meta, null, 2), 'utf8');
      await rename(metaTmp, metaPath);
    } catch {
      // meta.json is optional for older runs; list badges can fall back to result.json.
    }
    const report = renderMarkdown(buildReport(result));
    await writeFile(path.join(dir, 'report.md'), report, 'utf8');
    return { runId, result, report };
  }

  async function deleteRun(runId) {
    if (!RUN_ID_PATTERN.test(String(runId))) {
      throw new AppError('RUN_ID_INVALID', `Invalid run id: ${runId}`, { exitCode: 2 });
    }
    const dir = path.join(runsRoot, runId);
    // Database query results live under <run>/db-queries. Count them first so
    // the response proves the cascade happened; rm -r then removes the
    // diagnosis record and every query result in one operation.
    let databaseQueries = 0;
    try {
      databaseQueries = (await readdir(path.join(dir, DB_QUERY_DIR))).length;
    } catch {
      // No query results (or the run is already gone).
    }
    try {
      // Deletes result/report/meta/run log/backups/verification logs/db-queries together.
      await rm(dir, { recursive: true });
    } catch (err) {
      if (err && err.code === 'ENOENT') {
        throw new AppError('RUN_NOT_FOUND', `Run not found: ${runId}`, { exitCode: 3, cause: err });
      }
      throw new AppError('RUN_DELETE_FAILED', `Cannot delete run ${runId}`, { cause: err });
    }
    return { runId, deleted: true, databaseQueries };
  }

  function journalPathFor(runId) {
    if (!RUN_ID_PATTERN.test(String(runId))) {
      throw new AppError('RUN_ID_INVALID', `Invalid run id: ${runId}`, { exitCode: 2 });
    }
    return path.join(runsRoot, String(runId), 'workspace-journal.json');
  }

  async function getRunWorkspacePending(runId) {
    try {
      const journal = JSON.parse(await readFile(journalPathFor(runId), 'utf8'));
      if (!['editing', 'pending'].includes(journal.status)) return null;
      const files = (journal.touched ?? [])
        .map((entry) => entry.displayFile
          ?? `${entry.key ?? 'backend'}/${entry.relative ?? ''}`)
        .filter(Boolean)
        .slice(0, 20);
      return { kind: 'journal', status: journal.status, files };
    } catch {
      return null;
    }
  }

  async function keepRunWorkspace(runId) {
    return finalizeWorkspaceJournal(journalPathFor(runId), 'keep');
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

  async function getDatabaseConfig() {
    return databaseStore.getPublicConfig();
  }

  async function saveDatabaseConfig(input) {
    return databaseStore.save(input);
  }

  /** Enabled connections with decrypted credentials; never exposed through HTTP/IPC. */
  async function getRuntimeDatabases() {
    return databaseStore.getRuntimeConfig();
  }

  /**
   * Resolve one connection for diagnosis. Credentials stay in this function's
   * return value and are only handed to the in-process mysql client.
   */
  async function getDiagnosisDatabases() {
    const config = await databaseStore.getRuntimeConfig();
    return { activeId: config.activeId, connections: config.connections };
  }

  async function testDatabase(input) {
    const connection = await databaseStore.resolveForTest(input);
    const [result] = await checkDatabases([connection]);
    return result;
  }

  async function getAgentAuth() {
    return agentAuthStore.getPublic();
  }

  async function saveAgentAuth(auth) {
    return agentAuthStore.save(auth);
  }

  async function getAgentAuthRuntime() {
    return agentAuthStore.getRuntime();
  }

  async function currentMemoryIdentity() {
    const workspace = await store.getWorkspace();
    return projectIdentityForWorkspace(workspace, { root });
  }

  async function getProjectMemory() {
    try {
      return await memoryStore.getProject(await currentMemoryIdentity());
    } catch (error) {
      return {
        enabled: false,
        reason: error?.message ?? 'project-memory-unavailable',
        project: null,
        notes: [],
        promptNotes: [],
      };
    }
  }

  async function addProjectMemoryNote(note) {
    const identity = await currentMemoryIdentity();
    if (!identity) throw new AppError('PROJECT_MEMORY_UNAVAILABLE', '请先配置后端源码目录或前端项目目录', { exitCode: 2 });
    return memoryStore.addNote(identity, note);
  }

  async function updateProjectMemoryNote(id, patch) {
    const identity = await currentMemoryIdentity();
    if (!identity) throw new AppError('PROJECT_MEMORY_UNAVAILABLE', '请先配置后端源码目录或前端项目目录', { exitCode: 2 });
    try {
      return await memoryStore.updateNote(identity, id, patch);
    } catch (error) {
      throw new AppError('PROJECT_MEMORY_NOTE_NOT_FOUND', error?.message ?? 'note not found', { exitCode: 3 });
    }
  }

  async function deleteProjectMemoryNote(id) {
    const identity = await currentMemoryIdentity();
    if (!identity) throw new AppError('PROJECT_MEMORY_UNAVAILABLE', '请先配置后端源码目录或前端项目目录', { exitCode: 2 });
    try {
      return await memoryStore.deleteNote(identity, id);
    } catch (error) {
      throw new AppError('PROJECT_MEMORY_NOTE_NOT_FOUND', error?.message ?? 'note not found', { exitCode: 3 });
    }
  }

  async function mergeProjectMemory(candidates) {
    const identity = await currentMemoryIdentity();
    if (!identity) return { saved: 0, updated: 0, total: 0 };
    return memoryStore.mergeCandidates(identity, candidates);
  }

  return {
    root,
    runsRoot,
    configDir: path.resolve(effectiveConfigDir),
    store,
    databaseStore,
    getConfig,
    saveConfig,
    listRuns,
    getRun,
    updateRunSymptom,
    deleteRun,
    getRunWorkspacePending,
    keepRunWorkspace,
    listProfiles,
    createProfile,
    switchProfile,
    renameProfile,
    deleteProfile,
    getDatabaseConfig,
    saveDatabaseConfig,
    getRuntimeDatabases,
    getDiagnosisDatabases,
    testDatabase,
    agentAuthStore,
    memoryStore,
    getAgentAuth,
    saveAgentAuth,
    getAgentAuthRuntime,
    getProjectMemory,
    addProjectMemoryNote,
    updateProjectMemoryNote,
    deleteProjectMemoryNote,
    mergeProjectMemory,
  };
}
