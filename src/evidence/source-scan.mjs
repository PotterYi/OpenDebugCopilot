import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { decodeTextBuffer } from '../core/text-decode.mjs';

export const MAX_FILE_BYTES = 2 * 1024 * 1024;
export const MAX_MATCH_TEXT = 300;

/**
 * Scan an already-filtered file list for a literal or regex match.
 * Shared by the in-process literal path and the regex worker so both produce
 * the same match shape, ordering and limits.
 *
 * @param {{
 *   files: string[],
 *   root: string,
 *   keyword: string,
 *   regex?: boolean,
 *   caseSensitive?: boolean,
 *   maxMatches?: number,
 *   maxFileBytes?: number
 * }} options
 */
export async function scanFiles({
  files,
  root,
  keyword,
  regex = false,
  caseSensitive = false,
  maxMatches = 10_200,
  maxFileBytes = MAX_FILE_BYTES,
}) {
  const flags = caseSensitive ? '' : 'i';
  const pattern = regex ? new RegExp(keyword, flags) : null;
  const needle = caseSensitive ? keyword : keyword.toLowerCase();
  const matches = [];
  let scannedFiles = 0;
  let scannedBytes = 0;
  let capped = false;

  for (const file of files) {
    if (matches.length > maxMatches) break;
    let info;
    try {
      info = await stat(file);
    } catch {
      continue;
    }
    if (!info.isFile() || info.size > maxFileBytes) continue;
    let text;
    try {
      text = decodeTextBuffer(await readFile(file)).text;
    } catch {
      continue;
    }
    scannedFiles += 1;
    scannedBytes += info.size;
    const relative = path.relative(root, file).split(path.sep).join('/');
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      const hit = pattern
        ? pattern.test(line)
        : (caseSensitive ? line : line.toLowerCase()).includes(needle);
      if (!hit) continue;
      matches.push({ path: relative, line: i + 1, text: line.trim().slice(0, MAX_MATCH_TEXT) });
      if (matches.length > maxMatches) {
        capped = true;
        break;
      }
    }
    if (capped) break;
  }

  const sorted = matches
    .slice(0, maxMatches)
    .sort((a, b) => (a.path === b.path ? a.line - b.line : (a.path < b.path ? -1 : 1)));

  return { matches: sorted, scannedFiles, scannedBytes, capped };
}
