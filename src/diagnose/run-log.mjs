import { appendFile } from 'node:fs/promises';
import path from 'node:path';
import { log } from '../core/logger.mjs';

/**
 * Per-run log file: runs/<runId>/run.log. Mirrors key milestones to the global log.
 *
 * @param {string} runDir
 */
export function createRunLog(runDir) {
  const file = path.join(runDir, 'run.log');
  async function write(level, message) {
    const line = `${new Date().toISOString()} [${level}] ${message}\n`;
    await appendFile(file, line, 'utf8').catch(() => {});
    log.info(`[diagnose] ${message}`);
  }
  return {
    file,
    info: (message) => write('INFO', message),
    warn: (message) => write('WARN', message),
    error: (message) => write('ERROR', message),
  };
}
