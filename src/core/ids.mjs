import { randomBytes } from 'node:crypto';

/**
 * Run ids are sortable and collision-resistant:
 *   20261102-193012-a1b2c3
 * Timestamp is UTC to keep ordering stable across machines.
 *
 * @param {Date} [date]
 * @returns {string}
 */
export function newRunId(date = new Date()) {
  const iso = date.toISOString(); // 2026-11-02T19:30:12.345Z
  const ts = iso.slice(0, 19).replace(/[-:]/g, '').replace('T', '-');
  return `${ts}-${randomBytes(3).toString('hex')}`;
}
