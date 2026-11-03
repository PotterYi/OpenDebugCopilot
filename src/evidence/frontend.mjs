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

/**
 * Map frontend stack hints onto files under frontendSourceRoot.
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
    let result = await readSource({
      sourceRoot: frontendSourceRoot,
      target,
      startLine: Math.max(1, hint.line - 3),
      endLine: hint.line + 10,
      maxLines: 20,
    }).catch(() => null);
    if (!result?.found) {
      result = await readSource({
        sourceRoot: frontendSourceRoot,
        target: path.basename(target),
        startLine: Math.max(1, hint.line - 3),
        endLine: hint.line + 10,
        maxLines: 20,
      }).catch(() => null);
    }
    if (result?.found) {
      files.push({
        url: hint.url,
        line: hint.line,
        path: result.relativePath,
        content: result.content,
      });
    } else if (result?.candidates?.length) {
      files.push({ url: hint.url, line: hint.line, found: false, candidates: result.candidates.slice(0, 5) });
    }
  }
  return { available: true, files, hints };
}
