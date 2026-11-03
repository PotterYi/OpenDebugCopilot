/**
 * Structured recheck comparison (replaces exact-string comparison).
 * Checks:
 *   1. status-code: every run that cites a status cites the observed one
 *   2. conclusion-similarity: token Jaccard vs the first run >= 0.5
 *   3. evidence-refs: ref Jaccard vs the first run >= 0.5
 */

const SIMILARITY_THRESHOLD = 0.5;

function tokenize(text) {
  return new Set(
    String(text)
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .split(/\s+/)
      .filter((token) => token.length >= 2),
  );
}

function extractStatuses(text) {
  return new Set(String(text).match(/\b[1-5]\d{2}\b/g) ?? []);
}

function extractRefs(run) {
  return new Set((run?.evidenceRefs ?? []).map((ref) => `${ref.type}:${ref.ref}`));
}

function jaccard(a, b) {
  if (a.size === 0 && b.size === 0) return 1;
  let intersection = 0;
  for (const item of a) if (b.has(item)) intersection += 1;
  const union = a.size + b.size - intersection;
  return union === 0 ? 1 : intersection / union;
}

/**
 * @param {Array<{ conclusion?: string, evidenceRefs?: Array<{ type: string, ref: string }> }>} runs
 * @param {{ responseStatus?: number | null }} [context]
 */
export function evaluateRecheck(runs, { responseStatus = null } = {}) {
  const conclusions = runs.map((run) => (run?.conclusion ?? '').trim());
  if (runs.length === 0) {
    return { verdict: 'undetermined', checks: [], detail: 'no runs' };
  }
  if (conclusions.some((text) => !text)) {
    return { verdict: 'undetermined', checks: [], detail: 'at least one run has an empty conclusion' };
  }

  const fingerprints = runs.map((run) => ({
    tokens: tokenize(run.conclusion),
    statuses: extractStatuses(run.conclusion),
    refs: extractRefs(run),
  }));

  const statusOk = fingerprints.every(
    (fingerprint) =>
      responseStatus === null ||
      fingerprint.statuses.size === 0 ||
      fingerprint.statuses.has(String(responseStatus)),
  );
  const statusDetail = fingerprints.map((f) => [...f.statuses].join('/') || '-').join(' | ');

  const similarities = fingerprints.slice(1).map((f) => jaccard(fingerprints[0].tokens, f.tokens));
  const similarityOk = similarities.every((value) => value >= SIMILARITY_THRESHOLD);

  const refSimilarities = fingerprints.slice(1).map((f) => jaccard(fingerprints[0].refs, f.refs));
  const refsOk = refSimilarities.every((value) => value >= SIMILARITY_THRESHOLD);

  const checks = [
    { name: 'status-code', ok: statusOk, detail: statusDetail },
    { name: 'conclusion-similarity', ok: similarityOk, detail: similarities.map((v) => v.toFixed(2)).join(', ') || '-' },
    { name: 'evidence-refs', ok: refsOk, detail: refSimilarities.map((v) => v.toFixed(2)).join(', ') || '-' },
  ];
  const verdict = checks.every((check) => check.ok) ? 'consistent' : 'inconsistent';
  return {
    verdict,
    checks,
    detail: verdict === 'consistent'
      ? '三份结论在状态码/结论/证据引用上一致'
      : '存在不一致项，请人工复核',
  };
}
