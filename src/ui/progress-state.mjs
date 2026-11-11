/**
 * Merge one progress event into an ordered step list.
 *
 * The same id is emitted on start and done. Done events may omit label/name
 * (for example built-in tool results), so an existing label must be preserved
 * instead of being overwritten with undefined.
 */
export function upsertProgressStep(steps, event) {
  if (!event) return;
  const id = event.id ?? event.label;
  if (!id) return;
  const existing = steps.find((step) => step.id === id);
  if (existing) {
    const previousLabel = existing.label;
    Object.assign(existing, event, { id });
    if ((existing.label === undefined || existing.label === null || existing.label === '')
      && previousLabel) {
      existing.label = previousLabel;
    }
  } else {
    steps.push({ ...event, id });
    if (steps.length > 40) steps.splice(0, steps.length - 40);
  }
}

export const MAX_VISIBLE_PROGRESS_STEPS = 10;

/**
 * Project the step list for the compact "AI is working" panel.
 *
 * The active (started) step is shown as a pinned footer so it survives the
 * 40-step storage cap and gives the user a continuous heartbeat. Older
 * completed steps are trimmed from the top.
 */
export function buildProgressView(steps = [], {
  running = false,
  startedAt = null,
  now = Date.now(),
  timeoutMs = 0,
  maxVisible = MAX_VISIBLE_PROGRESS_STEPS,
} = {}) {
  const active = running
    ? [...steps].reverse().find((step) => step.status === 'start') ?? null
    : null;
  const activeId = active?.id ?? null;
  const base = running && activeId != null
    ? steps.filter((step) => step.id !== activeId)
    : steps;
  const hiddenCount = Math.max(0, base.length - maxVisible);
  const visibleSteps = hiddenCount > 0 ? base.slice(-maxVisible) : base;
  const elapsedSec = running && startedAt != null
    ? Math.max(0, Math.floor((now - startedAt) / 1000))
    : null;
  const timeoutSec = timeoutMs > 0 ? Math.round(timeoutMs / 1000) : null;
  let footerLabel = active?.label ?? 'AI 正在思考';
  if (footerLabel && !String(footerLabel).endsWith('…')) footerLabel = `${footerLabel}…`;
  return {
    hiddenCount,
    visibleSteps,
    footer: running
      ? { label: footerLabel || 'AI 正在思考…', elapsedSec, timeoutSec }
      : null,
  };
}
