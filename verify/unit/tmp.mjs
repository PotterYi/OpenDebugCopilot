import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(HERE, '../..');
const BASE = path.join(PROJECT_ROOT, '.tmp');

/**
 * All test artifacts must live under the project's .tmp directory.
 * This helper prevents the off-by-one path that previously wrote to the parent folder.
 *
 * @param {string} name
 * @returns {string}
 */
export function tempDir(name) {
  const dir = path.join(BASE, `${name}-${process.pid}`);
  if (!dir.startsWith(`${BASE}${path.sep}`)) {
    throw new Error(`temp dir escaped project .tmp: ${dir}`);
  }
  return dir;
}
