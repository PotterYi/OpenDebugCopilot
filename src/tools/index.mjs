import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { AppError } from '../core/errors.mjs';
import { resolveScenarioPaths } from '../core/scenario.mjs';
import { readLogs, listThreads, searchAll } from '../evidence/logs.mjs';
import { readSource, searchSource } from '../evidence/source.mjs';

const DEFAULT_MAX_RESULT_BYTES = 32 * 1024;
const DEFAULT_READ_LINES = 200;

/** Tool definitions exposed to the agent (MCP-shaped). */
export function toolSpecs() {
  return [
    {
      name: 'get_logs',
      description: 'Query logs inside the scenario time window. Supports marker substring, thread, level, minLevel and keyword.',
      input_schema: {
        type: 'object',
        properties: {
          marker: { type: 'string' },
          keyword: { type: 'string' },
          thread: { type: 'string' },
          level: { type: 'string' },
          minLevel: { type: 'string' },
          limit: { type: 'integer', minimum: 1, maximum: 500 },
        },
        additionalProperties: false,
      },
    },
    {
      name: 'list_threads',
      description: 'Thread histogram inside the scenario time window. Use it to find which thread handled the request.',
      input_schema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      name: 'search_log',
      description: 'Search all declared log files by keyword, ignoring the time window. Useful for once-only degradation logs.',
      input_schema: {
        type: 'object',
        properties: {
          keyword: { type: 'string' },
          limit: { type: 'integer', minimum: 1, maximum: 500 },
        },
        required: ['keyword'],
        additionalProperties: false,
      },
    },
    {
      name: 'read_source',
      description: 'Read source by file path or fully-qualified class name. Ambiguous names return candidates instead of guessing.',
      input_schema: {
        type: 'object',
        properties: {
          target: { type: 'string' },
          startLine: { type: 'integer', minimum: 1 },
          endLine: { type: 'integer', minimum: 1 },
        },
        required: ['target'],
        additionalProperties: false,
      },
    },
    {
      name: 'search_source',
      description: 'Search source files by keyword (case-insensitive).',
      input_schema: {
        type: 'object',
        properties: {
          keyword: { type: 'string' },
          limit: { type: 'integer', minimum: 1, maximum: 200 },
        },
        required: ['keyword'],
        additionalProperties: false,
      },
    },
    {
      name: 'read',
      description: 'Read a slice of a spilled tool result written under the run evidence directory.',
      input_schema: {
        type: 'object',
        properties: {
          file: { type: 'string' },
          startLine: { type: 'integer', minimum: 1 },
          endLine: { type: 'integer', minimum: 1 },
        },
        required: ['file'],
        additionalProperties: false,
      },
    },
  ];
}

/**
 * Build in-process tools bound to one diagnosis run.
 *
 * @param {{
 *   scenario: Readonly<Record<string, any>>,
 *   anchor: number,
 *   runDir: string,
 *   logfiles?: string[],
 *   sourceRoot?: string | null,
 *   window?: { beforeMs: number, afterMs: number },
 *   limitBytes?: number
 * }} options
 */
export function createTools({
  scenario,
  anchor,
  runDir,
  logfiles,
  sourceRoot,
  window,
  limitBytes = DEFAULT_MAX_RESULT_BYTES,
}) {
  const paths = resolveScenarioPaths(scenario);
  const files = logfiles ?? paths.logfiles;
  const root = sourceRoot ?? paths.sourceRoot;
  const timeWindow = window ?? scenario.window;
  const spillDir = path.join(runDir, 'evidence');
  let seq = 0;

  async function spill(name, value) {
    const text = JSON.stringify(value, null, 2);
    const bytes = Buffer.byteLength(text);
    if (bytes <= limitBytes) return value;
    await mkdir(spillDir, { recursive: true });
    seq += 1;
    const file = path.join(spillDir, `tool-${String(seq).padStart(3, '0')}-${name}.json`);
    await writeFile(file, text, 'utf8');
    return {
      spilled: true,
      file: path.relative(runDir, file).split(path.sep).join('/'),
      bytes,
      preview: text.slice(0, 1000),
    };
  }

  /** @type {Array<{ name: string, args: any, result: any, durationMs: number, error?: boolean }>} */
  const calls = [];

  function summarizeCallResult(value) {
    const text = JSON.stringify(value);
    if (typeof text !== 'string') return String(value);
    return text.length > 4000 ? `${text.slice(0, 4000)}… (${text.length} chars)` : value;
  }

  async function safe(name, fn, args = {}) {
    const started = Date.now();
    try {
      const result = await fn(args);
      calls.push({ name, args, result: summarizeCallResult(result), durationMs: Date.now() - started });
      return result;
    } catch (err) {
      if (err instanceof AppError) {
        const payload = { error: true, code: err.code, message: err.message };
        calls.push({ name, args, result: payload, durationMs: Date.now() - started, error: true });
        return payload;
      }
      throw err;
    }
  }

  const tools = {
    get_logs: (args = {}) => safe('get_logs', async () => {
      const result = await readLogs({
        logfiles: files,
        parser: scenario.parser,
        encoding: scenario.logEncoding,
        anchor,
        window: timeWindow,
        marker: args.marker,
        keyword: args.keyword,
        thread: args.thread,
        level: args.level,
        minLevel: args.minLevel,
        limit: args.limit ?? 200,
      });
      return spill('get_logs', result);
    }, args),

    list_threads: (args = {}) => safe('list_threads', async () => {
      const result = await listThreads({
        logfiles: files,
        parser: scenario.parser,
        encoding: scenario.logEncoding,
        anchor,
        window: timeWindow,
      });
      return spill('list_threads', result);
    }, args),

    search_log: (args = {}) => safe('search_log', async () => {
      const result = await searchAll({
        logfiles: files,
        parser: scenario.parser,
        encoding: scenario.logEncoding,
        keyword: args.keyword,
        limit: args.limit ?? 100,
      });
      return spill('search_log', result);
    }, args),

    read_source: (args = {}) => safe('read_source', async () => {
      const result = await readSource({
        sourceRoot: root,
        target: args.target,
        startLine: args.startLine,
        endLine: args.endLine,
      });
      const { path: _absolutePath, ...safeResult } = result;
      return spill('read_source', safeResult);
    }, args),

    search_source: (args = {}) => safe('search_source', async () => {
      const result = await searchSource({
        sourceRoot: root,
        keyword: args.keyword,
        limit: args.limit ?? 50,
      });
      return spill('search_source', result);
    }, args),

    read: (args = {}) => safe('read', async () => {
      const relative = args.file;
      if (!relative || typeof relative !== 'string') {
        throw new AppError('READ_FILE_REQUIRED', 'read requires a file path from a spilled result', { exitCode: 2 });
      }
      const absolute = path.resolve(runDir, relative);
      const base = path.resolve(spillDir) + path.sep;
      if (!absolute.startsWith(base)) {
        throw new AppError('READ_OUT_OF_SCOPE', 'read only accepts files under the run evidence directory', { exitCode: 2 });
      }
      const text = await readFile(absolute, 'utf8');
      const lines = text.split(/\r?\n/);
      const from = Math.max(1, args.startLine ?? 1);
      const to = Math.min(lines.length, args.endLine ?? from + DEFAULT_READ_LINES - 1);
      return {
        file: relative,
        startLine: from,
        endLine: to,
        totalLines: lines.length,
        content: lines.slice(from - 1, to).join('\n'),
        truncated: to < lines.length,
      };
    }, args),
  };

  return { tools, specs: toolSpecs(), spillDir, calls };
}
