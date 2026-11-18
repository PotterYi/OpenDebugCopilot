/**
 * Evidence reference indexing and validation.
 *
 * The model cites evidence with { type, ref } pairs. Until now gates only
 * checked that the pair was a non-empty string, so a hallucinated
 * logs.records[99] could pass as evidence. This module builds the set of paths
 * that actually exist in the evidence packet and validates citations against it.
 */

const TYPE_ROOTS = {
  request: ['request'],
  response: ['response'],
  log: ['logs'],
  source: ['source'],
  thread: ['threads'],
  element: ['element'],
};

const MAX_ARRAY_ITEMS = 100;
const MAX_OBJECT_KEYS = 60;
const MAX_DEPTH = 4;

function collectPaths(value, base, out, depth = 0) {
  out.add(base);
  if (value === null || value === undefined || depth >= MAX_DEPTH) return;
  if (Array.isArray(value)) {
    const limit = Math.min(value.length, MAX_ARRAY_ITEMS);
    for (let index = 0; index < limit; index += 1) {
      collectPaths(value[index], `${base}[${index}]`, out, depth + 1);
    }
    return;
  }
  if (typeof value === 'object') {
    for (const key of Object.keys(value).slice(0, MAX_OBJECT_KEYS)) {
      if (['__proto__', 'prototype', 'constructor'].includes(key)) continue;
      collectPaths(value[key], `${base}.${key}`, out, depth + 1);
    }
  }
}

/**
 * Build the set of evidence paths that a citation may point at.
 * Values are intentionally not retained: refutation quotes are a later phase.
 *
 * @param {Record<string, any>} evidence
 * @returns {Set<string>}
 */
export function buildEvidenceRefIndex(evidence = {}) {
  const paths = new Set();
  for (const root of ['request', 'response', 'element', 'logs', 'source', 'threads', 'frontend', 'marker', 'triage']) {
    if (evidence?.[root] !== undefined) collectPaths(evidence[root], root, paths);
  }
  return paths;
}

export function normalizeEvidenceRef(ref) {
  return String(ref ?? '').trim();
}

/**
 * Validate one citation against the index.
 * Returns { ok, reason?, skipped? }. skipped=true means no evidence context was
 * supplied (e.g. a unit-level call) and existence could not be checked.
 */
export function validateEvidenceRef(index, ref) {
  if (!index || index.size === 0) return { ok: true, skipped: true };
  if (!ref || typeof ref.type !== 'string' || typeof ref.ref !== 'string' || !ref.type || !ref.ref) {
    return { ok: false, reason: 'shape' };
  }
  const roots = TYPE_ROOTS[ref.type];
  if (!roots) return { ok: false, reason: 'type' };
  const normalized = normalizeEvidenceRef(ref.ref);
  const matchesType = roots.some(
    (root) => normalized === root || normalized.startsWith(`${root}.`) || normalized.startsWith(`${root}[`),
  );
  if (!matchesType) return { ok: false, reason: 'type-mismatch' };
  if (!index.has(normalized)) return { ok: false, reason: 'missing' };
  return { ok: true };
}

/**
 * Validate a list of citations. Returns invalid entries with a reason.
 *
 * @param {Set<string> | null} index
 * @param {Array<{ type?: string, ref?: string }>} refs
 */
export function validateEvidenceRefs(index, refs = []) {
  const invalid = [];
  for (const ref of Array.isArray(refs) ? refs : []) {
    const result = validateEvidenceRef(index, ref);
    if (!result.ok) invalid.push({ ref, reason: result.reason });
  }
  return { ok: invalid.length === 0, invalid };
}
