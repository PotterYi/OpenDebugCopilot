import { readFile } from 'node:fs/promises';
import { AppError } from './errors.mjs';

/** @type {Readonly<Record<string, unknown>>} */
export const DEFAULT_CONFIG = Object.freeze({
  window: { beforeMs: 3000, afterMs: 2000 },
  parser: { preset: 'auto' },
  marker: { header: 'X-DC-Probe' },
  runsDir: 'runs',
});

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * @param {unknown} base
 * @param {unknown} override
 * @returns {unknown}
 */
function mergeDeep(base, override) {
  if (!isObject(base) || !isObject(override)) return override === undefined ? base : override;
  const out = { ...base };
  for (const [key, value] of Object.entries(override)) {
    out[key] = key in base ? mergeDeep(base[key], value) : value;
  }
  return out;
}

/**
 * Load configs/*.json. A missing file yields defaults (config is optional).
 *
 * @param {string | undefined} filePath
 * @returns {Promise<Record<string, any>>}
 */
export async function loadConfig(filePath) {
  if (!filePath) return structuredClone(DEFAULT_CONFIG);
  let text;
  try {
    text = await readFile(filePath, 'utf8');
  } catch (err) {
    if (err && /** @type {any} */ (err).code === 'ENOENT') {
      return structuredClone(DEFAULT_CONFIG);
    }
    throw new AppError('CONFIG_READ_FAILED', `Cannot read config: ${filePath}`, { cause: err });
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new AppError('CONFIG_PARSE_FAILED', `Config is not valid JSON: ${filePath}`, { cause: err });
  }
  if (!isObject(parsed)) {
    throw new AppError('CONFIG_INVALID', `Config must be a JSON object: ${filePath}`);
  }
  return /** @type {Record<string, any>} */ (mergeDeep(structuredClone(DEFAULT_CONFIG), parsed));
}
