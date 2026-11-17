import { parseCoordinate } from './jvm.mjs';

const BS = String.fromCharCode(92);

function stripTreePrefix(text) {
  let out = String(text ?? '').trimStart();
  while (out.startsWith('|') || out.startsWith('+') || out.startsWith('-') || out.startsWith(BS)) {
    out = out.slice(1).trimStart();
  }
  return out;
}

function hasTreeBranch(text) {
  const trimmed = String(text ?? '').trimStart();
  return trimmed.startsWith('|') || trimmed.startsWith('+') || trimmed.startsWith('-') || trimmed.startsWith(BS);
}

/**
 * Parse a Maven dependency:tree file (with or without [INFO] prefixes).
 * Returns normalized coordinates; the project root line is skipped.
 */
export function parseMavenTree(text) {
  const seen = new Map();
  let rootSkipped = false;
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const withoutInfo = line.replace(/^\[INFO\]\s*/, '');
    if (!withoutInfo.trim()) continue;
    const branch = hasTreeBranch(withoutInfo);
    const cleaned = stripTreePrefix(withoutInfo);
    if (!cleaned || cleaned.startsWith('---')) continue;
    const omitted = /\(omitted/i.test(cleaned);
    const coordinateText = cleaned.replace(/\s+\(.*\)$/, '').trim();
    const parsed = parseCoordinate(coordinateText);
    if (!parsed) continue;
    if (!rootSkipped) {
      rootSkipped = true;
      if (!branch) continue;
    }
    const entry = {
      group: parsed.group ?? null,
      artifact: parsed.artifact,
      version: parsed.version ?? null,
      classifier: parsed.classifier ?? null,
      scope: parsed.scope ?? null,
      omitted,
    };
    const key = [
      entry.group ?? '',
      entry.artifact,
      entry.version ?? '',
      entry.classifier ?? '',
      entry.scope ?? '',
    ].join(' ');
    const previous = seen.get(key);
    if (!previous || (previous.omitted && !entry.omitted)) seen.set(key, entry);
  }
  return [...seen.values()];
}

function globMatch(pattern, text) {
  const p = String(pattern ?? '').toLowerCase();
  const t = String(text ?? '').toLowerCase();
  if (!p) return false;
  if (!p.includes('*')) return p === t;
  const parts = p.split('*');
  if (!t.startsWith(parts[0])) return false;
  let index = parts[0].length;
  for (let i = 1; i < parts.length; i += 1) {
    const part = parts[i];
    if (!part) continue;
    const found = t.indexOf(part, index);
    if (found < 0) return false;
    index = found + part.length;
  }
  return p.endsWith('*') || index === t.length;
}

function matchesPattern(entry, pattern) {
  const target = String(pattern ?? '').includes(':')
    ? `${entry.group ?? ''}:${entry.artifact}`
    : entry.artifact;
  return globMatch(pattern, target);
}

/** Filter parsed dependencies in-process; never build -Dincludes strings. */
export function filterMavenDependencies(entries, {
  scope = 'all',
  includes = [],
  excludes = [],
} = {}) {
  const scopeSets = {
    runtime: new Set([null, 'compile', 'runtime']),
    compile: new Set([null, 'compile']),
    test: new Set(['test']),
    provided: new Set(['provided']),
    all: null,
  };
  const allowedScopes = scopeSets[scope] ?? null;
  const includePatterns = (Array.isArray(includes) ? includes : []).filter(Boolean);
  const excludePatterns = (Array.isArray(excludes) ? excludes : []).filter(Boolean);
  return entries.filter((entry) => {
    if (allowedScopes && !allowedScopes.has(entry.scope)) return false;
    if (includePatterns.length > 0 && !includePatterns.some((pattern) => matchesPattern(entry, pattern))) {
      return false;
    }
    if (excludePatterns.some((pattern) => matchesPattern(entry, pattern))) return false;
    return true;
  });
}
