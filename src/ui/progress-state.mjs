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
