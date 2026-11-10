import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { AppError } from '../core/errors.mjs';
import { resolveScenarioPaths } from '../core/scenario.mjs';
import { readLogs, listThreads, searchAll } from '../evidence/logs.mjs';
import { readSource, searchSource } from '../evidence/source.mjs';
import { queryDatabase, writeDatabase } from '../evidence/db.mjs';
import { redactSecrets, redactValue } from '../core/redact.mjs';

const DEFAULT_MAX_RESULT_BYTES = 32 * 1024;
const DEFAULT_READ_LINES = 200;

/** Tool definitions exposed to the agent (MCP-shaped). */
export function toolSpecs({ databases = [], runCommand = null } = {}) {
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
      description: 'Read source by file path or fully-qualified class name. Use root=frontend for frontend source, or root=extra with extraRoot=<id> for an authorized additional backend root. Ambiguous names return candidates instead of guessing.',
      input_schema: {
        type: 'object',
        properties: {
          target: { type: 'string' },
          root: { enum: ['backend', 'frontend', 'extra'] },
          extraRoot: { type: 'string' },
          startLine: { type: 'integer', minimum: 1 },
          endLine: { type: 'integer', minimum: 1 },
        },
        required: ['target'],
        additionalProperties: false,
      },
    },
    {
      name: 'search_source',
      description: 'Search source files by keyword (case-insensitive). Use root=frontend for frontend source, or root=extra with extraRoot=<id> for an authorized additional backend root.',
      input_schema: {
        type: 'object',
        properties: {
          keyword: { type: 'string' },
          root: { enum: ['backend', 'frontend', 'extra'] },
          extraRoot: { type: 'string' },
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
    ...(runCommand
      ? [{
          name: 'run_command',
          description: 'Run an allowed build/test command inside the isolated sandbox (Maven/Gradle/npm/tsc/Python/Go/etc.). Use it to compile and run tests after editing sandbox files. Shell chaining and environment-changing commands are rejected.',
          input_schema: {
            type: 'object',
            properties: {
              command: { type: 'string' },
              cwd: { type: 'string' },
            },
            required: ['command'],
            additionalProperties: false,
          },
        }]
      : []),
    ...(databases.length > 0
      ? [{
          name: 'query_db',
          description: 'Run a read-only SQL query against a configured test database. Supports SELECT, SHOW (schema), DESCRIBE and EXPLAIN. Omit connection to use the active one.',
          input_schema: {
            type: 'object',
            properties: {
              connection: { type: 'string' },
              sql: { type: 'string' },
              limit: { type: 'integer', minimum: 1, maximum: 1000 },
            },
            required: ['sql'],
            additionalProperties: false,
          },
        }]
      : []),
    ...(databases.some((connection) => connection.allowWrite)
      ? [{
          name: 'write_db',
          description: 'Execute one approved INSERT/UPDATE/DELETE statement against a configured test database. The user must confirm every write.',
          input_schema: {
            type: 'object',
            properties: {
              connection: { type: 'string' },
              sql: { type: 'string' },
            },
            required: ['sql'],
            additionalProperties: false,
          },
        }]
      : []),
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
 *   frontendSourceRoot?: string | null,
 *   extraSourceRoots?: Array<{ id: string, root: string }>,
 *   databases?: Array<any>,
 *   activeDatabaseId?: string | null,
 *   approveWrite?: (input: { connection: any, sql: string }) => Promise<boolean>,
 *   databaseConnect?: Function,
 *   runCommand?: ((input: { command: string, cwd?: string }) => Promise<any>) | null,
 *   window?: { beforeMs: number, afterMs: number },
 *   limitBytes?: number,
 *   onCall?: (event: { id: number, stage: 'start'|'done', name: string, error?: boolean, durationMs?: number }) => void
 * }} options
 */
export function createTools({
  scenario,
  anchor,
  runDir,
  logfiles,
  sourceRoot,
  frontendSourceRoot,
  extraSourceRoots = [],
  databases = [],
  activeDatabaseId = null,
  approveWrite = null,
  databaseConnect = undefined,
  runCommand = null,
  window,
  limitBytes = DEFAULT_MAX_RESULT_BYTES,
  onCall = null,
}) {
  const paths = resolveScenarioPaths(scenario);
  const files = logfiles ?? paths.logfiles;
  const root = sourceRoot ?? paths.sourceRoot;
  const frontendRoot = frontendSourceRoot ?? scenario.frontendSourceRoot ?? null;
  const extraRoots = Array.isArray(extraSourceRoots) ? extraSourceRoots : [];
  const databaseConnections = Array.isArray(databases) ? databases : [];
  const pickDatabase = (selector) => {
    if (databaseConnections.length === 0) {
      throw new AppError('DB_NOT_CONFIGURED', 'no reachable database connection is configured', { exitCode: 3 });
    }
    if (!selector) {
      return databaseConnections.find((connection) => connection.id === activeDatabaseId)
        ?? databaseConnections[0];
    }
    const text = String(selector);
    const match = databaseConnections.find((connection) => connection.id === text)
      ?? databaseConnections.find((connection) => connection.name === text);
    if (!match) throw new AppError('DB_CONNECTION_NOT_FOUND', `database connection not found: ${selector}`, { exitCode: 2 });
    return match;
  };
  const pickRoot = (kind, extraRootId) => {
    if (kind === 'frontend') {
      if (!frontendRoot) throw new AppError('FRONTEND_SOURCE_ROOT_REQUIRED', 'frontend source root is not configured', { exitCode: 3 });
      return frontendRoot;
    }
    if (kind === 'extra') {
      const matched = extraRoots.find((item) => item.id === extraRootId);
      if (!matched) {
        throw new AppError('EXTRA_SOURCE_ROOT_REQUIRED', 'extra source root is not authorized or does not exist', { exitCode: 3 });
      }
      return matched.root;
    }
    if (kind === 'backend') {
      if (!root) throw new AppError('SOURCE_ROOT_REQUIRED', 'source.root is required for read_source', { exitCode: 3 });
      return root;
    }
    return root ?? frontendRoot;
  };
  const timeWindow = window ?? scenario.window;
  const spillDir = path.join(runDir, 'evidence');
  // Database query results are a first-class run artifact, not an in-memory
  // cache: every result lands under <run>/db-queries so deleting the run
  // removes the queries atomically with the diagnosis record.
  const dbQueryDir = path.join(runDir, 'db-queries');
  const dbQueries = [];
  let seq = 0;
  let dbSeq = 0;

  async function spill(name, rawValue) {
    const value = redactValue(rawValue);
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

  /**
   * Persist one database query/write result under the run directory.
   * Returns the metadata recorded in result.json; the full payload stays on disk.
   */
  async function persistDatabaseResult(name, args, result, { error = false } = {}) {
    dbSeq += 1;
    const at = Date.now();
    const id = `dbq-${String(dbSeq).padStart(3, '0')}`;
    const safeResult = redactValue(result ?? null);
    const entry = {
      id,
      name,
      at,
      connection: safeResult?.connection ?? null,
      sql: redactSecrets(safeResult?.sql ?? String(args?.sql ?? '')),
      error: Boolean(error),
      code: safeResult?.code ?? null,
      message: safeResult?.message ?? null,
      durationMs: safeResult?.durationMs ?? null,
      rowCount: safeResult?.rowCount ?? null,
      affectedRows: safeResult?.affectedRows ?? null,
      truncated: Boolean(safeResult?.truncated),
      columns: Array.isArray(safeResult?.columns) ? safeResult.columns : [],
      file: null,
    };
    try {
      await mkdir(dbQueryDir, { recursive: true });
      const file = path.join(dbQueryDir, `${id}-${at.toString(36)}.json`);
      await writeFile(file, JSON.stringify(redactValue({ ...entry, result: safeResult }), null, 2), 'utf8');
      entry.file = path.relative(runDir, file).split(path.sep).join('/');
    } catch {
      // Persisting evidence must never fail the tool call itself.
    }
    dbQueries.push(entry);
    return entry;
  }

  /** @type {Array<{ name: string, args: any, result: any, durationMs: number, error?: boolean }>} */
  const calls = [];

  function summarizeCallResult(value) {
    const safe = redactValue(value);
    const text = JSON.stringify(safe);
    if (typeof text !== 'string') return String(safe);
    return text.length > 4000 ? `${redactSecrets(text.slice(0, 4000))}… (${text.length} chars)` : safe;
  }

  async function safe(name, fn, args = {}) {
    const started = Date.now();
    const id = calls.length + 1;
    try {
      onCall?.({ id, stage: 'start', name });
      // Central choke point: every tool result is sanitized before it can reach
      // the agent, result.json, the report or a spilled evidence file.
      const result = redactValue(await fn(args));
      const durationMs = Date.now() - started;
      calls.push({ name, args: redactValue(args), result: summarizeCallResult(result), durationMs });
      onCall?.({ id, stage: 'done', name, durationMs });
      return result;
    } catch (err) {
      if (err instanceof AppError) {
        const payload = { error: true, code: err.code, message: redactSecrets(err.message) };
        const durationMs = Date.now() - started;
        calls.push({ name, args, result: payload, durationMs, error: true });
        onCall?.({ id, stage: 'done', name, durationMs, error: true });
        return payload;
      }
      onCall?.({ id, stage: 'done', name, durationMs: Date.now() - started, error: true });
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
        sourceRoot: pickRoot(args.root, args.extraRoot),
        target: args.target,
        startLine: args.startLine,
        endLine: args.endLine,
      });
      const { path: _absolutePath, ...safeResult } = result;
      return spill('read_source', safeResult);
    }, args),

    search_source: (args = {}) => safe('search_source', async () => {
      const result = await searchSource({
        sourceRoot: pickRoot(args.root, args.extraRoot),
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

    query_db: (args = {}) => safe('query_db', async () => {
      const connection = pickDatabase(args.connection);
      try {
        const result = await queryDatabase({
          connection,
          sql: args.sql,
          limit: args.limit,
          connect: databaseConnect,
        });
        await persistDatabaseResult('query_db', args, result);
        return spill('query_db', result);
      } catch (error) {
        await persistDatabaseResult('query_db', args, {
          error: true,
          code: error?.code ?? null,
          message: String(error?.message ?? error),
        }, { error: true });
        throw error;
      }
    }, args),

    write_db: (args = {}) => safe('write_db', async () => {
      const connection = pickDatabase(args.connection);
      if (!connection.allowWrite) {
        throw new AppError('DB_WRITE_DISABLED', 'write is disabled for this database connection', { exitCode: 3 });
      }
      if (typeof approveWrite !== 'function') {
        throw new AppError('DB_WRITE_APPROVAL_REQUIRED', 'write requires explicit user approval', { exitCode: 3 });
      }
      try {
        const result = await writeDatabase({
          connection,
          sql: args.sql,
          approve: approveWrite,
          connect: databaseConnect,
        });
        await persistDatabaseResult('write_db', args, result);
        return spill('write_db', result);
      } catch (error) {
        await persistDatabaseResult('write_db', args, {
          error: true,
          code: error?.code ?? null,
          message: String(error?.message ?? error),
        }, { error: true });
        throw error;
      }
    }, args),

    ...(runCommand
      ? {
          run_command: (args = {}) => safe('run_command', async () => {
            const result = await runCommand({ command: args.command, cwd: args.cwd });
            return result;
          }, args),
        }
      : {}),
  };

  return {
    tools,
    specs: toolSpecs({ databases: databaseConnections, runCommand }),
    spillDir,
    dbQueryDir,
    dbQueries,
    calls,
  };
}
