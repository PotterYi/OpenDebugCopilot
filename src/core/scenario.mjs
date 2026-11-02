import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { ScenarioError } from './errors.mjs';
import { DEFAULT_CONFIG } from './config.mjs';

const TOP_LEVEL_KEYS = new Set([
  'name', 'description', 'baseUrl',
  'browser', 'method', 'path', 'headers', 'body',
  'logfiles', 'source', 'parser', 'marker', 'window', 'logEncoding',
]);
const BROWSER_KEYS = new Set(['path', 'match', 'actions']);
const ACTION_KEYS = new Set(['click', 'fill']);
const FILL_KEYS = new Set(['selector', 'value']);
const SOURCE_KEYS = new Set(['root']);
const PARSER_KEYS = new Set(['preset', 'regex']);
const MARKER_KEYS = new Set(['mode', 'bodyField', 'header']);
const WINDOW_KEYS = new Set(['beforeMs', 'afterMs']);
const PARSER_PRESETS = new Set(['auto', 'json-lines', 'logback', 'node']);
const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
const MARKER_MODES = new Set(['body', 'header', 'both', 'none']);
const LOG_ENCODINGS = new Set(['auto', 'utf8', 'gbk']);

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** @param {string} code @param {string} message @param {unknown} [details] */
function fail(code, message, details) {
  throw new ScenarioError(code, message, details);
}

function assertKnownKeys(value, allowed, where) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      fail('SCENARIO_UNKNOWN_KEY', `Unknown key "${key}" in ${where}`, { key, where });
    }
  }
}

function requireNonEmptyString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    fail('SCENARIO_INVALID_FIELD', `"${field}" must be a non-empty string`);
  }
  return value.trim();
}

function optionalString(value, field) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    fail('SCENARIO_INVALID_FIELD', `"${field}" must be a string`);
  }
  return value;
}

function optionalNonNegativeNumber(value, field, fallback) {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    fail('SCENARIO_INVALID_FIELD', `"${field}" must be a non-negative number`);
  }
  return value;
}

function parseBaseUrl(value) {
  if (value === undefined) return undefined;
  const raw = requireNonEmptyString(value, 'baseUrl');
  let url;
  try {
    url = new URL(raw);
  } catch {
    fail('SCENARIO_INVALID_URL', `"baseUrl" is not a valid URL: ${raw}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    fail('SCENARIO_INVALID_URL', `"baseUrl" must use http or https: ${raw}`);
  }
  return raw.replace(/\/+$/, '');
}

function parseBrowser(browser) {
  if (!isObject(browser)) fail('SCENARIO_INVALID_FIELD', '"browser" must be an object');
  assertKnownKeys(browser, BROWSER_KEYS, 'browser');
  const pagePath = requireNonEmptyString(browser.path, 'browser.path');
  if (!pagePath.startsWith('/')) {
    fail('SCENARIO_INVALID_FIELD', '"browser.path" must start with "/"');
  }
  const match = requireNonEmptyString(browser.match, 'browser.match');

  const rawActions = browser.actions ?? [];
  if (!Array.isArray(rawActions)) {
    fail('SCENARIO_INVALID_FIELD', '"browser.actions" must be an array');
  }
  const actions = rawActions.map((action, index) => {
    const where = `browser.actions[${index}]`;
    if (!isObject(action)) fail('SCENARIO_INVALID_FIELD', `${where} must be an object`);
    assertKnownKeys(action, ACTION_KEYS, where);
    const hasClick = 'click' in action;
    const hasFill = 'fill' in action;
    if (hasClick === hasFill) {
      fail('SCENARIO_INVALID_ACTION', `${where} must contain exactly one of "click" or "fill"`);
    }
    if (hasClick) {
      return Object.freeze({ click: requireNonEmptyString(action.click, `${where}.click`) });
    }
    const fill = action.fill;
    if (!isObject(fill)) fail('SCENARIO_INVALID_ACTION', `${where}.fill must be an object`);
    assertKnownKeys(fill, FILL_KEYS, `${where}.fill`);
    return Object.freeze({
      fill: Object.freeze({
        selector: requireNonEmptyString(fill.selector, `${where}.fill.selector`),
        value: typeof fill.value === 'string' ? fill.value : String(fill.value ?? ''),
      }),
    });
  });

  return Object.freeze({ path: pagePath, match, actions: Object.freeze(actions) });
}

function parseHttp(raw) {
  const methodRaw = requireNonEmptyString(raw.method, 'method').toUpperCase();
  if (!HTTP_METHODS.has(methodRaw)) {
    fail('SCENARIO_INVALID_FIELD', `"method" must be one of ${[...HTTP_METHODS].join(', ')}`);
  }
  const requestPath = requireNonEmptyString(raw.path, 'path');

  let headers;
  if (raw.headers !== undefined) {
    if (!isObject(raw.headers)) fail('SCENARIO_INVALID_FIELD', '"headers" must be an object');
    headers = {};
    for (const [name, value] of Object.entries(raw.headers)) {
      if (typeof value !== 'string') {
        fail('SCENARIO_INVALID_FIELD', `"headers.${name}" must be a string`);
      }
      headers[name] = value;
    }
  }

  let body;
  if (raw.body !== undefined) {
    if (typeof raw.body !== 'string' && !isObject(raw.body)) {
      fail('SCENARIO_INVALID_FIELD', '"body" must be a string or an object');
    }
    body = typeof raw.body === 'string' ? raw.body : Object.freeze({ ...raw.body });
  }

  return Object.freeze({ method: methodRaw, path: requestPath, headers, body });
}

function parseLogfiles(value) {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value)) fail('SCENARIO_INVALID_FIELD', '"logfiles" must be an array of paths');
  return Object.freeze(value.map((entry, index) => requireNonEmptyString(entry, `logfiles[${index}]`)));
}

function parseSource(value) {
  if (value === undefined) return undefined;
  if (!isObject(value)) fail('SCENARIO_INVALID_FIELD', '"source" must be an object');
  assertKnownKeys(value, SOURCE_KEYS, 'source');
  return Object.freeze({ root: requireNonEmptyString(value.root, 'source.root') });
}

function parseParser(value, config) {
  const input = value ?? config.parser;
  if (!isObject(input)) fail('SCENARIO_INVALID_FIELD', '"parser" must be an object');
  assertKnownKeys(input, PARSER_KEYS, 'parser');
  const hasPreset = input.preset !== undefined;
  const hasRegex = input.regex !== undefined;
  if (!hasPreset && !hasRegex) {
    fail('SCENARIO_INVALID_FIELD', '"parser" requires either "preset" or "regex"');
  }
  if (hasPreset && hasRegex) {
    fail('SCENARIO_INVALID_FIELD', '"parser" cannot define both "preset" and "regex"');
  }
  if (hasPreset) {
    const preset = requireNonEmptyString(input.preset, 'parser.preset');
    if (!PARSER_PRESETS.has(preset)) {
      fail('SCENARIO_INVALID_FIELD', `"parser.preset" must be one of ${[...PARSER_PRESETS].join(', ')}`);
    }
    return Object.freeze({ preset });
  }
  const regex = requireNonEmptyString(input.regex, 'parser.regex');
  try {
    new RegExp(regex);
  } catch {
    fail('SCENARIO_INVALID_REGEX', `"parser.regex" is not a valid regular expression: ${regex}`);
  }
  return Object.freeze({ regex });
}

function parseMarker(value, config) {
  const input = value ?? { mode: 'none' };
  if (!isObject(input)) fail('SCENARIO_INVALID_FIELD', '"marker" must be an object');
  assertKnownKeys(input, MARKER_KEYS, 'marker');

  const mode = input.mode ?? 'none';
  if (!MARKER_MODES.has(mode)) {
    fail('SCENARIO_INVALID_FIELD', `"marker.mode" must be one of ${[...MARKER_MODES].join(', ')}`);
  }
  const header = input.header === undefined ? config.marker.header : requireNonEmptyString(input.header, 'marker.header');
  let bodyField;
  if (mode === 'body' || mode === 'both') {
    bodyField = requireNonEmptyString(input.bodyField, 'marker.bodyField');
  } else if (input.bodyField !== undefined) {
    fail('SCENARIO_INVALID_FIELD', '"marker.bodyField" is only valid when mode is "body" or "both"');
  }
  if (mode === 'none' && input.header !== undefined) {
    fail('SCENARIO_INVALID_FIELD', '"marker.header" is not used when mode is "none"');
  }
  return Object.freeze({ mode, bodyField, header });
}

function parseLogEncoding(value) {
  if (value === undefined) return 'auto';
  const normalized = String(value).trim().toLowerCase();
  const mapped = normalized === 'utf-8' ? 'utf8' : normalized === 'gb18030' ? 'gbk' : normalized;
  if (!LOG_ENCODINGS.has(mapped)) {
    fail('SCENARIO_INVALID_FIELD', `"logEncoding" must be one of ${[...LOG_ENCODINGS].join(', ')}`);
  }
  return mapped;
}

function parseWindow(value, config) {
  if (value === undefined) {
    return Object.freeze({ ...config.window });
  }
  if (!isObject(value)) fail('SCENARIO_INVALID_FIELD', '"window" must be an object');
  assertKnownKeys(value, WINDOW_KEYS, 'window');
  return Object.freeze({
    beforeMs: optionalNonNegativeNumber(value.beforeMs, 'window.beforeMs', config.window.beforeMs),
    afterMs: optionalNonNegativeNumber(value.afterMs, 'window.afterMs', config.window.afterMs),
  });
}

/**
 * Validate and normalize a scenario document.
 *
 * @param {unknown} raw
 * @param {{ filePath?: string, config?: Record<string, any> }} [options]
 * @returns {Readonly<Record<string, any>>}
 */
export function parseScenario(raw, { filePath, config = DEFAULT_CONFIG } = {}) {
  if (!isObject(raw)) {
    fail('SCENARIO_NOT_OBJECT', 'Scenario must be a JSON object');
  }
  assertKnownKeys(raw, TOP_LEVEL_KEYS, 'scenario');

  const name = requireNonEmptyString(raw.name, 'name');
  const description = optionalString(raw.description, 'description');
  const baseUrl = parseBaseUrl(raw.baseUrl);

  const hasBrowser = raw.browser !== undefined;
  const hasHttp = raw.method !== undefined || raw.path !== undefined;
  if (hasBrowser && hasHttp) {
    fail(
      'SCENARIO_AMBIGUOUS_DRIVER',
      'Scenario declares both "browser" and HTTP fields ("method"/"path"); declare exactly one driver',
    );
  }
  if (!hasBrowser && !hasHttp) {
    fail(
      'SCENARIO_MISSING_DRIVER',
      'Scenario must declare either a "browser" block or HTTP fields ("method" + "path")',
    );
  }

  const browser = hasBrowser ? parseBrowser(raw.browser) : undefined;
  const http = hasHttp ? parseHttp(raw) : undefined;

  return Object.freeze({
    name,
    description,
    baseUrl,
    driverKind: hasBrowser ? 'browser' : 'http',
    browser,
    http,
    logfiles: parseLogfiles(raw.logfiles),
    source: parseSource(raw.source),
    parser: parseParser(raw.parser, config),
    logEncoding: parseLogEncoding(raw.logEncoding),
    marker: parseMarker(raw.marker, config),
    window: parseWindow(raw.window, config),
    filePath: filePath ? path.resolve(filePath) : undefined,
    dir: filePath ? path.dirname(path.resolve(filePath)) : process.cwd(),
  });
}

/**
 * Read and validate a scenario file.
 *
 * @param {string} filePath
 * @param {{ config?: Record<string, any> }} [options]
 * @returns {Promise<Readonly<Record<string, any>>>}
 */
export async function loadScenario(filePath, options = {}) {
  const absolute = path.resolve(filePath);
  let text;
  try {
    text = await readFile(absolute, 'utf8');
  } catch (err) {
    throw new ScenarioError('SCENARIO_READ_FAILED', `Cannot read scenario: ${absolute}`, {
      cause: err,
    });
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new ScenarioError('SCENARIO_PARSE_FAILED', `Scenario is not valid JSON: ${absolute}`, {
      cause: err,
    });
  }
  return parseScenario(raw, { ...options, filePath: absolute });
}

/**
 * Resolve scenario-relative paths (logfiles, source root) against the scenario directory.
 *
 * @param {Readonly<Record<string, any>>} scenario
 * @returns {{ logfiles: string[], sourceRoot: string | null, scenarioPath: string | null }}
 */
export function resolveScenarioPaths(scenario) {
  const dir = scenario.dir ?? process.cwd();
  return {
    logfiles: (scenario.logfiles ?? []).map((entry) => path.resolve(dir, entry)),
    sourceRoot: scenario.source?.root ? path.resolve(dir, scenario.source.root) : null,
    scenarioPath: scenario.filePath ?? null,
  };
}
