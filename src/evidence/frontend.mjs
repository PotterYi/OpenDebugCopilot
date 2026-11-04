import path from 'node:path';
import { readSource } from './source.mjs';

function parseFrameLine(line) {
  const match = String(line).match(/(https?:\/\/[^\s)]+):(\d+):(\d+)/);
  if (!match) return null;
  return { url: match[1], line: Number(match[2]), column: Number(match[3]) };
}

/**
 * Extract frontend stack hints from captured console errors / exceptions.
 *
 * @param {Array<{ url?: string, line?: number, column?: number, stack?: string[] }>} errors
 */
export function extractFrameHints(errors = []) {
  const hints = new Map();
  for (const error of errors) {
    if (error?.url) {
      hints.set(`${error.url}:${error.line ?? 0}`, {
        url: error.url,
        line: error.line ?? 1,
        column: error.column ?? 1,
      });
    }
    for (const line of error?.stack ?? []) {
      const parsed = parseFrameLine(line);
      if (parsed) hints.set(`${parsed.url}:${parsed.line}`, parsed);
    }
  }
  return [...hints.values()].slice(0, 6);
}

function targetFromUrl(url) {
  try {
    return new URL(url).pathname.replace(/^\/+/, '');
  } catch {
    return null;
  }
}

/** Try the URL path as-is, without a leading src/, with a src/ prefix, and by basename. */
function candidateTargets(target) {
  const clean = String(target).replace(/^\/+/, '');
  const candidates = [];
  const add = (value) => {
    if (value && !candidates.includes(value)) candidates.push(value);
  };
  add(clean);
  if (clean.startsWith('src/')) add(clean.slice(4));
  const srcIndex = clean.lastIndexOf('/src/');
  if (srcIndex >= 0) {
    add(clean.slice(srcIndex + 1));
    add(clean.slice(srcIndex + 5));
  } else {
    add(`src/${clean}`);
  }
  add(path.basename(clean));
  return candidates;
}

/**
 * Map frontend stack hints onto files under frontendSourceRoot.
 * When the configured source root is the project root, both /src/... and
 * src-less stack paths are resolved without extra configuration.
 *
 * @param {{
 *   frontendSourceRoot: string | null,
 *   errors?: Array<any>,
 *   maxFiles?: number
 * }} options
 */
export async function resolveFrontendSources({ frontendSourceRoot, errors = [], maxFiles = 3 }) {
  if (!frontendSourceRoot) {
    return { available: false, reason: 'frontendSourceRoot not declared', files: [] };
  }
  const hints = extractFrameHints(errors);
  const files = [];
  for (const hint of hints) {
    if (files.length >= maxFiles) break;
    const target = targetFromUrl(hint.url);
    if (!target) continue;
    let candidateResult = null;
    let result = null;
    for (const candidate of candidateTargets(target)) {
      const attempt = await readSource({
        sourceRoot: frontendSourceRoot,
        target: candidate,
        startLine: Math.max(1, hint.line - 3),
        endLine: hint.line + 10,
        maxLines: 20,
      }).catch(() => null);
      if (attempt?.candidates?.length && !candidateResult) candidateResult = attempt;
      if (attempt?.found) {
        result = attempt;
        break;
      }
    }
    if (result?.found) {
      files.push({
        url: hint.url,
        line: hint.line,
        path: result.relativePath,
        content: result.content,
      });
    } else if (candidateResult?.candidates?.length) {
      files.push({ url: hint.url, line: hint.line, found: false, candidates: candidateResult.candidates.slice(0, 5) });
    }
  }
  return { available: true, files, hints };
}
