import { createHash } from 'node:crypto';
import { mkdir, open, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const LOCK_DIR = path.join(os.tmpdir(), 'debugcopilot-workspace-locks');
const STALE_MS = 2 * 60 * 60 * 1000;

function lockPath(repoRoot) {
  const key = createHash('sha256').update(path.resolve(repoRoot)).digest('hex').slice(0, 24);
  return path.join(LOCK_DIR, `${key}.lock`);
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

async function readLock(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

async function tryAcquire(repoRoot, runId) {
  const file = lockPath(repoRoot);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(file, 'wx');
      await handle.writeFile(JSON.stringify({
        repoRoot: path.resolve(repoRoot),
        runId,
        pid: process.pid,
        at: Date.now(),
      }), 'utf8');
      await handle.close();
      return { ok: true, file };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const existing = await readLock(file);
      const stale = !existing
        || !pidAlive(existing.pid)
        || (Date.now() - Number(existing.at ?? 0) > STALE_MS);
      if (!stale) {
        return { ok: false, busyRepo: repoRoot, owner: existing };
      }
      await rm(file, { force: true }).catch(() => {});
    }
  }
  return { ok: false, busyRepo: repoRoot };
}

/**
 * Acquire one lock per repository. On any conflict, release everything already
 * acquired and report the busy repository so the caller can degrade to read-only.
 */
export async function acquireWorkspaceLocks(repos, { runId } = {}) {
  const unique = [...new Set((repos ?? []).map((repo) => path.resolve(repo)))].sort();
  if (unique.length === 0) return { ok: true, files: [], release: async () => {} };
  await mkdir(LOCK_DIR, { recursive: true });
  const files = [];
  for (const repo of unique) {
    const result = await tryAcquire(repo, runId);
    if (!result.ok) {
      await Promise.all(files.map((file) => rm(file, { force: true }).catch(() => {})));
      return { ok: false, busyRepo: result.busyRepo, owner: result.owner, files: [] };
    }
    files.push(result.file);
  }
  return {
    ok: true,
    files,
    release: async () => {
      await Promise.all(files.map((file) => rm(file, { force: true }).catch(() => {})));
    },
  };
}
