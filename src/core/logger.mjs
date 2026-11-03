import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import path from 'node:path';

let filePath = process.env.DC_LOG_FILE || null;
const maxBytes = Number(process.env.DC_LOG_MAX_BYTES ?? 5 * 1024 * 1024);
const keep = Number(process.env.DC_LOG_KEEP ?? 3);
let writes = 0;

export function getLogFile() {
  return filePath;
}

/** @param {string | null} file */
export function setLogFile(file) {
  filePath = file || null;
  if (filePath) {
    try {
      mkdirSync(path.dirname(filePath), { recursive: true });
    } catch {
      // logging must never break the caller
    }
  }
}

function rotateIfNeeded() {
  if (!filePath) return;
  writes += 1;
  if (writes % 100 !== 0) return;
  try {
    if (statSync(filePath).size < maxBytes) return;
    for (let index = keep; index >= 1; index -= 1) {
      const from = index === 1 ? filePath : `${filePath}.${index - 1}`;
      const to = `${filePath}.${index}`;
      if (existsSync(to)) unlinkSync(to);
      if (existsSync(from)) renameSync(from, to);
    }
  } catch {
    // ignore rotation errors
  }
}

function format(level, args) {
  const message = args
    .map((value) => {
      if (typeof value === 'string') return value;
      if (value instanceof Error) return value.stack ?? value.message;
      try {
        return JSON.stringify(value);
      } catch {
        return String(value);
      }
    })
    .join(' ');
  return `${new Date().toISOString()} [${level}] ${message}`;
}

function emit(level, args) {
  const line = format(level, args);
  process.stderr.write(`${line}\n`);
  if (filePath) {
    try {
      appendFileSync(filePath, `${line}\n`);
      rotateIfNeeded();
    } catch {
      // logging must never break the caller
    }
  }
}

/**
 * Product logging goes to stderr (and optionally a file).
 * stdout is reserved for the primary result payload.
 */
export const log = {
  info: (...args) => emit('INFO', args),
  warn: (...args) => emit('WARN', args),
  error: (...args) => emit('ERROR', args),
  debug: (...args) => {
    if (process.env.DC_DEBUG) emit('DEBUG', args);
  },
};
