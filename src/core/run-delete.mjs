/**
 * Delete a run with the desktop workspace policy:
 * - pending edits are never silently discarded
 * - the caller gets a confirmation request first
 * - after confirmation, keep the live session (release locks + clean baseline)
 *   or keep the journal, and only then delete the run directory
 */
export async function deleteRunWithWorkspacePolicy({
  service,
  runId,
  workspaceSessions = null,
  confirmedKeep = false,
} = {}) {
  const session = workspaceSessions?.get?.(runId) ?? null;
  let pending = null;
  if (session) {
    const files = (session.describeTouchedFiles?.() ?? [])
      .map((entry) => entry.file)
      .filter(Boolean)
      .slice(0, 20);
    pending = { kind: 'live', status: 'pending', files };
  } else {
    pending = await service.getRunWorkspacePending(runId);
  }

  if (pending && !confirmedKeep) {
    return { ok: false, requiresKeepConfirmation: true, pending };
  }

  if (session) {
    try {
      // Keep first: this releases the repo lock and cleans baseline/journal.
      await session.keep();
    } catch (error) {
      return {
        ok: false,
        error: `保留工作区修改失败：${error?.message ?? error}`,
        pending,
      };
    }
    workspaceSessions.delete(runId);
  } else if (pending) {
    const kept = await service.keepRunWorkspace(runId);
    if (!kept?.ok) {
      return {
        ok: false,
        error: kept?.error ?? '保留工作区修改失败',
        pending,
      };
    }
  }

  const deleted = await service.deleteRun(runId);
  return { ...deleted, ok: true, keptWorkspace: Boolean(pending) };
}
