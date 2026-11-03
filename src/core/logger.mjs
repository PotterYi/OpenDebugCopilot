import { appendFileSync } from 'node:fs';

let filePath = process.env.DC_LOG_FILE || null;

/** @param {string | null} file */
export function setLogFile(file) {
  filePath = file || null;
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
