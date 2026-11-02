import { createReadStream } from 'node:fs';
import { open, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import iconv from 'iconv-lite';

const LOG_FILE_PATTERN = /\.(log|out|txt)(\..+)?$/i;

async function statSafe(target) {
  try {
    return await stat(target);
  } catch {
    return null;
  }
}

/**
 * Expand declared log paths into concrete files, including rotated siblings.
 * Sorted oldest -> newest so scanning follows write order.
 *
 * Order of operations:
 * 1. file entry -> itself + siblings named "<basename>.<suffix>"
 * 2. directory entry -> files matching *.log / *.out / *.txt (incl. rotated)
 *
 * @param {string[]} entries
 * @returns {Promise<Array<{ path: string, size: number, mtimeMs: number }>>}
 */
export async function discoverLogFiles(entries = []) {
  const found = new Map();

  const add = async (filePath) => {
    const info = await statSafe(filePath);
    if (!info || !info.isFile()) return;
    const key = path.resolve(filePath);
    if (!found.has(key)) {
      found.set(key, { path: key, size: info.size, mtimeMs: info.mtimeMs });
    }
  };

  for (const entry of entries) {
    const info = await statSafe(entry);
    if (!info) continue;
    const absolute = path.resolve(entry);

    if (info.isDirectory()) {
      const names = await readdir(absolute);
      for (const name of names) {
        if (LOG_FILE_PATTERN.test(name)) await add(path.join(absolute, name));
      }
      continue;
    }

    await add(absolute);
    const dir = path.dirname(absolute);
    const base = path.basename(absolute);
    const names = await readdir(dir).catch(() => []);
    for (const name of names) {
      if (name !== base && name.startsWith(`${base}.`)) {
        await add(path.join(dir, name));
      }
    }
  }

  return [...found.values()].sort(
    (a, b) => a.mtimeMs - b.mtimeMs || a.path.localeCompare(b.path),
  );
}

/**
 * Detect text encoding from a sample. Explicit setting always wins.
 *
 * @param {string} filePath
 * @param {'auto' | 'utf8' | 'gbk'} [explicit]
 * @returns {Promise<'utf8' | 'gbk'>}
 */
export async function detectEncoding(filePath, explicit = 'auto') {
  if (explicit && explicit !== 'auto') return explicit === 'gbk' ? 'gbk' : 'utf8';
  const handle = await open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(65536);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead === 0) return 'utf8';
    const sample = buffer.subarray(0, bytesRead);
    if (sample.length >= 3 && sample[0] === 0xef && sample[1] === 0xbb && sample[2] === 0xbf) {
      return 'utf8';
    }
    const tail = sample.subarray(0, Math.max(0, sample.length - 4));
    const text = tail.toString('utf8');
    return text.includes('�') ? 'gbk' : 'utf8';
  } finally {
    await handle.close();
  }
}

/**
 * Stream lines from one file. Decoding is streaming (never loads the whole file).
 *
 * @param {string} filePath
 * @param {{ encoding?: 'auto' | 'utf8' | 'gbk', maxBytes?: number }} [options]
 * @returns {AsyncGenerator<{ line: string, lineNo: number }>}
 */
export async function* readLines(filePath, { encoding = 'auto', maxBytes = 32 * 1024 * 1024 } = {}) {
  const resolvedEncoding = await detectEncoding(filePath, encoding);
  const raw = createReadStream(filePath, maxBytes > 0 ? { end: maxBytes - 1 } : undefined);
  const input = resolvedEncoding === 'utf8' ? raw : raw.pipe(iconv.decodeStream(resolvedEncoding));
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  let lineNo = 0;
  try {
    for await (const line of rl) {
      lineNo += 1;
      yield { line, lineNo };
    }
  } finally {
    rl.close();
    raw.destroy();
  }
}

/**
 * Read up to `limit` lines from the head of a file (used by parser auto-detection).
 *
 * @param {string} filePath
 * @param {number} [limit]
 * @param {{ encoding?: 'auto' | 'utf8' | 'gbk', maxBytes?: number }} [options]
 * @returns {Promise<string[]>}
 */
export async function sampleLines(filePath, limit = 2000, options = {}) {
  const lines = [];
  for await (const { line } of readLines(filePath, options)) {
    lines.push(line);
    if (lines.length >= limit) break;
  }
  return lines;
}
