import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';
import { AppError } from '../core/errors.mjs';
import { resolveScenarioPaths } from '../core/scenario.mjs';
import { readLogs, listThreads, searchAll } from '../evidence/logs.mjs';
import { readSource, searchSource } from '../evidence/source.mjs';
import { queryDatabase, writeDatabase } from '../evidence/db.mjs';
import { listJavaProcesses, runtimeClasspath } from '../evidence/jvm.mjs';
import { listProcesses } from '../evidence/processes.mjs';
import { listDirectory, statFile } from '../evidence/fs.mjs';
import { gitDiff, gitLog, gitStatus } from '../evidence/git.mjs';
import { parseMavenTree, filterMavenDependencies } from '../evidence/maven.mjs';
import { inside } from '../core/path-policy.mjs';
import { boundaryGuidance, createDenialTracker } from './guidance.mjs';
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
      description: 'Read a slice of a spilled tool result written under the run evidence directory. This is NOT a general file reader: use read_source for source files, list_dir for directories, and stat_file for metadata.',
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
    {
      name: 'list_java_processes',
      description: 'Lightweight Java-only process view via jps (pid + main class). Use port to narrow the result to the Java process listening on a local TCP port. Use list_processes when you need ppid, start time, command line or non-Java processes.',
      input_schema: {
        type: 'object',
        properties: {
          port: { type: 'integer', minimum: 1, maximum: 65535 },
        },
        additionalProperties: false,
      },
    },
    {
      name: 'list_processes',
      description: 'List local OS processes with pid, ppid, name, start time and a redacted command line. Use it to identify which instance is actually running (IDE debug vs extracted jar vs stale process) before choosing a target. Defaults to the current user/session and 50 rows. Filters: pid, port, name, commandContains, javaOnly. command is redacted then truncated.',
      input_schema: {
        type: 'object',
        properties: {
          pid: { type: 'integer', minimum: 1 },
          port: { type: 'integer', minimum: 1, maximum: 65535 },
          name: { type: 'string' },
          commandContains: { type: 'string' },
          javaOnly: { type: 'boolean' },
          limit: { type: 'integer', minimum: 1, maximum: 200 },
        },
        additionalProperties: false,
      },
    },
    {
      name: 'list_dir',
      description: 'List a directory inside an authorized source root (root=backend/frontend/extra). Returns relative names, type, size and mtime only; never file contents. Sensitive files and .git internals are hidden. Defaults to depth 1 and 200 entries.',
      input_schema: {
        type: 'object',
        properties: {
          root: { enum: ['backend', 'frontend', 'extra'] },
          extraRoot: { type: 'string' },
          path: { type: 'string' },
          depth: { type: 'integer', minimum: 1, maximum: 2 },
          limit: { type: 'integer', minimum: 1, maximum: 500 },
        },
        additionalProperties: false,
      },
    },
    {
      name: 'stat_file',
      description: 'Return metadata (type, size, mtime, symlink flag) for one path inside an authorized source root. Does not read file contents. Use it to find stale files instead of running Python or shell.',
      input_schema: {
        type: 'object',
        properties: {
          root: { enum: ['backend', 'frontend', 'extra'] },
          extraRoot: { type: 'string' },
          path: { type: 'string' },
        },
        required: ['path'],
        additionalProperties: false,
      },
    },
    {
      name: 'git_status',
      description: 'Read-only git status for an authorized source root: branch, upstream, ahead/behind and changed paths. Paths are limited to the source root and sensitive paths are hidden.',
      input_schema: {
        type: 'object',
        properties: {
          root: { enum: ['backend', 'frontend', 'extra'] },
          extraRoot: { type: 'string' },
        },
        additionalProperties: false,
      },
    },
    {
      name: 'git_log',
      description: 'Read-only recent git commits touching an authorized source root. Returns hash, date, subject and changed file names; no author email, commit body or full diff. Use it to answer "what changed recently" instead of run_command.',
      input_schema: {
        type: 'object',
        properties: {
          root: { enum: ['backend', 'frontend', 'extra'] },
          extraRoot: { type: 'string' },
          limit: { type: 'integer', minimum: 1, maximum: 50 },
          since: { type: 'string' },
          path: { type: 'string' },
        },
        additionalProperties: false,
      },
    },
    {
      name: 'git_diff',
      description: 'Read-only git diff for an authorized source root. Defaults to statOnly and returns additions/deletions per file. A full patch requires statOnly=false and one explicit non-sensitive file path; it is redacted and capped. Never runs external diff or textconv drivers.',
      input_schema: {
        type: 'object',
        properties: {
          root: { enum: ['backend', 'frontend', 'extra'] },
          extraRoot: { type: 'string' },
          path: { type: 'string' },
          staged: { type: 'boolean' },
          statOnly: { type: 'boolean' },
        },
        additionalProperties: false,
      },
    },
    {
      name: 'runtime_classpath',
      description: 'Compare a local JVM runtime classpath against a declared classpath file, and return only missing jars, version mismatches and runtime-only jars. declaredFile accepts Maven dependency:build-classpath output (prefer -Dmdep.includeScope=runtime), a dependency:tree log, a JSON string array, or a directory of jars; it must live under the source root, run directory or current workspace. Use pid, or port when the pid is unknown.',
      input_schema: {
        type: 'object',
        properties: {
          pid: { type: 'integer', minimum: 1 },
          port: { type: 'integer', minimum: 1, maximum: 65535 },
          declaredFile: { type: 'string' },
        },
        required: ['declaredFile'],
        additionalProperties: false,
      },
    },
    ...(runCommand
      ? [{
          name: 'run_command',
          description: 'Run one allowed build/test command inside the isolated sandbox (Maven/Gradle/npm/tsc/Python/Go/etc.). Examples: mvn -q -DskipTests compile, mvn -q -Dtest=ClassName test, npm test, npm run build, pytest tests/unit, go test ./... . Do not probe capabilities with python -V/echo/print; use list_dir/stat_file/git_* instead. Shell chaining and environment-changing commands are rejected.',
          input_schema: {
            type: 'object',
            properties: {
              command: { type: 'string' },
              cwd: { type: 'string' },
            },
            required: ['command'],
            additionalProperties: false,
          },
        }, {
          name: 'maven_dependencies',
          description: 'Run one full Maven dependency:tree for the backend root, then filter in-process. Use includes/excludes arrays instead of composing -Dincludes. Optionally returns declaredFile for runtime_classpath. Only available when build/test commands are enabled (sandbox/full).',
          input_schema: {
            type: 'object',
            properties: {
              root: { enum: ['backend'] },
              scope: { enum: ['runtime', 'compile', 'test', 'provided', 'all'] },
              includes: { type: 'array', items: { type: 'string' } },
              excludes: { type: 'array', items: { type: 'string' } },
              includeClasspath: { type: 'boolean' },
              verbose: { type: 'boolean' },
            },
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
 *   toolMode?: 'readonly' | 'sandbox' | 'full',
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
  toolMode = null,
  window,
  limitBytes = DEFAULT_MAX_RESULT_BYTES,
  onCall = null,
}) {
  const paths = resolveScenarioPaths(scenario);
  const files = logfiles ?? paths.logfiles;
  const root = sourceRoot ?? paths.sourceRoot;
  const frontendRoot = frontendSourceRoot ?? scenario.frontendSourceRoot ?? null;
  const extraRoots = Array.isArray(extraSourceRoots) ? extraSourceRoots : [];
  // Declared classpath files are user/build artifacts. Only read them from
  // places the diagnosis already has access to; never from model-chosen paths.
  const declaredRoots = [...new Set([
    runDir,
    root,
    frontendRoot,
    ...extraRoots.map((entry) => entry?.root),
    process.cwd(),
  ].filter(Boolean))];
  const databaseConnections = Array.isArray(databases) ? databases : [];
  const effectiveToolMode = toolMode ?? (runCommand ? 'sandbox' : 'readonly');
  const denialTracker = createDenialTracker();
  const COMMAND_CACHE_TTL_MS = 5 * 60 * 1000;
  const COMMAND_CACHE_MAX = 50;
  const commandCache = new Map();

  function cacheableMavenCommand(command) {
    const text = String(command ?? '').trim();
    if (!/^(?:\.\/)?(?:mvn|mvnw)(?:\.cmd)?\b/i.test(text)) return false;
    if (/\b(?:test|verify|install|deploy|exec|clean|package)\b/i.test(text)) return false;
    return /\bcompile\b/i.test(text)
      || /\bdependency:(?:tree|build-classpath)\b/i.test(text)
      || /\bhelp:evaluate\b/i.test(text);
  }

  async function mavenFingerprint(rootPath) {
    const base = path.resolve(rootPath || process.cwd());
    const parts = [process.env.JAVA_HOME ?? '', process.env.MAVEN_OPTS ?? ''];
    const targets = [];
    let dir = base;
    for (let index = 0; index < 3; index += 1) {
      targets.push(path.join(dir, 'pom.xml'));
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    targets.push(path.join(homedir(), '.m2', 'settings.xml'));
    for (const target of targets) {
      try {
        const data = await readFile(target);
        parts.push(createHash('sha1').update(data).digest('hex'));
      } catch {
        // Missing pom/settings is normal for non-Maven roots.
      }
    }
    return createHash('sha1').update(parts.join('\n')).digest('hex');
  }

  async function commandCacheKey(command, args = {}) {
    const fingerprint = await mavenFingerprint(root);
    return `${command}\0${args.cwd ?? ''}\0${effectiveToolMode}\0${root ?? ''}\0${fingerprint}`;
  }

  async function runCommandCached(args = {}, { force = false } = {}) {
    const command = String(args.command ?? '').trim();
    const cacheable = cacheableMavenCommand(command);
    const key = cacheable ? await commandCacheKey(command, args) : null;
    if (!force && key) {
      const entry = commandCache.get(key);
      if (entry) {
        const age = Date.now() - entry.at;
        if (age <= COMMAND_CACHE_TTL_MS) {
          return { ...entry.value, cached: true, cacheAgeMs: age };
        }
        commandCache.delete(key);
      }
    }
    const result = await runCommand({ command: args.command, cwd: args.cwd });
    if (key && result?.ok) {
      if (commandCache.size >= COMMAND_CACHE_MAX) {
        const oldest = [...commandCache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
        if (oldest) commandCache.delete(oldest[0]);
      }
      commandCache.set(key, { value: redactValue(result), at: Date.now() });
    }
    return result;
  }

  function resetCommandCache() {
    commandCache.clear();
  }

  function relativeDeclaredPath(file) {
    const bases = [runDir, root, frontendRoot, ...extraRoots.map((entry) => entry?.root)].filter(Boolean);
    for (const base of bases) {
      if (inside(base, file)) return path.relative(base, file).split(path.sep).join('/');
    }
    return null;
  }

  function cleanPatterns(value, label) {
    if (value === undefined) return [];
    if (!Array.isArray(value)) {
      throw new AppError('INVALID_FILTER', `${label} must be an array of strings`, { exitCode: 2 });
    }
    return value.slice(0, 20)
      .map((item) => String(item ?? '').trim())
      .filter(Boolean)
      .map((item) => item.replace(/[\r\n]/g, ' ').slice(0, 200));
  }

  function mavenScope(value) {
    const scope = value ?? 'all';
    const allowed = new Set(['runtime', 'compile', 'test', 'provided', 'all']);
    if (!allowed.has(scope)) {
      throw new AppError('INVALID_SCOPE', 'scope must be runtime, compile, test, provided or all', { exitCode: 2 });
    }
    return scope;
  }

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
      denialTracker.recordSuccess(name);
      calls.push({ name, args: redactValue(args), result: summarizeCallResult(result), durationMs });
      onCall?.({ id, stage: 'done', name, durationMs });
      return result;
    } catch (err) {
      if (err instanceof AppError) {
        const guidance = boundaryGuidance({
          tool: name,
          code: err.code,
          details: err.details,
          mode: effectiveToolMode,
        });
        const repetition = denialTracker.recordFailure({ tool: name, code: err.code });
        const payload = {
          error: true,
          code: err.code,
          message: redactSecrets(err.message),
          ...(guidance?.details ? { details: redactValue(guidance.details) } : {}),
          ...(guidance?.hint ? { hint: redactSecrets(guidance.hint) } : {}),
          ...(guidance?.usage?.length ? { usage: guidance.usage.map((item) => redactSecrets(item)) } : {}),
        };
        if (repetition?.repeated >= 2) {
          payload.guardrail = {
            repeated: repetition.repeated,
            message: `你已连续 ${repetition.repeated} 次触发 ${name} 的同一工具边界。停止试探，按 usage 选择一种可用形式。`,
            usage: (guidance?.usage ?? []).map((item) => redactSecrets(item)),
            doNotRetry: true,
          };
        }
        const durationMs = Date.now() - started;
        calls.push({ name, args: redactValue(args), result: payload, durationMs, error: true });
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
        throw new AppError('READ_OUT_OF_SCOPE', 'read only accepts files under the run evidence directory; use list_dir for directories and read_source for source files', { exitCode: 2 });
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

    list_java_processes: (args = {}) => safe('list_java_processes', async () => {
      return listJavaProcesses({ port: args.port });
    }, args),

    list_processes: (args = {}) => safe('list_processes', async () => {
      const result = await listProcesses({
        pid: args.pid,
        port: args.port,
        name: args.name,
        commandContains: args.commandContains,
        javaOnly: args.javaOnly,
        limit: args.limit,
      });
      return spill('list_processes', result);
    }, args),

    list_dir: (args = {}) => safe('list_dir', async () => {
      const result = await listDirectory({
        root: pickRoot(args.root, args.extraRoot),
        path: args.path,
        depth: args.depth,
        limit: args.limit,
      });
      return spill('list_dir', result);
    }, args),

    stat_file: (args = {}) => safe('stat_file', async () => {
      return statFile({ root: pickRoot(args.root, args.extraRoot), path: args.path });
    }, args),

    git_status: (args = {}) => safe('git_status', async () => {
      return spill('git_status', await gitStatus({ root: pickRoot(args.root, args.extraRoot) }));
    }, args),

    git_log: (args = {}) => safe('git_log', async () => {
      const result = await gitLog({
        root: pickRoot(args.root, args.extraRoot),
        limit: args.limit,
        since: args.since,
        path: args.path,
      });
      return spill('git_log', result);
    }, args),

    git_diff: (args = {}) => safe('git_diff', async () => {
      const result = await gitDiff({
        root: pickRoot(args.root, args.extraRoot),
        path: args.path,
        staged: args.staged,
        statOnly: args.statOnly !== false,
      });
      return spill('git_diff', result);
    }, args),

    runtime_classpath: (args = {}) => safe('runtime_classpath', async () => {
      const result = await runtimeClasspath({
        pid: args.pid,
        port: args.port,
        declaredFile: args.declaredFile,
        allowRoots: declaredRoots,
      });
      return spill('runtime_classpath', result);
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
            return runCommandCached(args);
          }, args),
          maven_dependencies: (args = {}) => safe('maven_dependencies', async () => {
            if (args.root && args.root !== 'backend') {
              throw new AppError('MAVEN_ROOT_UNSUPPORTED', 'maven_dependencies currently supports root=backend only', {
                exitCode: 2,
                details: { reason: 'maven-root' },
              });
            }
            const targetRoot = pickRoot('backend', null);
            if (!targetRoot || (root && targetRoot !== root)) {
              throw new AppError('MAVEN_ROOT_UNSUPPORTED', 'maven_dependencies requires the backend source root', {
                exitCode: 2,
                details: { reason: 'maven-root' },
              });
            }
            const scope = mavenScope(args.scope);
            const includes = cleanPatterns(args.includes, 'includes');
            const excludes = cleanPatterns(args.excludes, 'excludes');
            const treeCommand = `mvn -q -DskipTests dependency:tree -DappendOutput=false -DoutputFile=target/dc-dependency-tree.txt${args.verbose === true ? ' -Dverbose' : ''}`;
            const treeFileFor = (run) => path.join(run?.cwd ?? targetRoot, 'target/dc-dependency-tree.txt');
            let treeRun = await runCommandCached({ command: treeCommand });
            let treeFile = treeFileFor(treeRun);
            if (treeRun.cached && !(await access(treeFile).then(() => true).catch(() => false))) {
              treeRun = await runCommandCached({ command: treeCommand }, { force: true });
              treeFile = treeFileFor(treeRun);
            }
            if (!treeRun.ok) {
              throw new AppError(
                'MAVEN_COMMAND_FAILED',
                `Maven dependency:tree 失败（exit ${treeRun.exitCode ?? 'unknown'}）`,
                { exitCode: 3, details: { reason: 'dependency-tree' } },
              );
            }
            let text;
            try {
              text = await readFile(treeFile, 'utf8');
            } catch {
              throw new AppError('MAVEN_OUTPUT_MISSING', 'Maven dependency:tree 输出文件不存在，请重试', {
                exitCode: 3,
                details: { reason: 'maven-output' },
              });
            }
            const all = parseMavenTree(text);
            const filtered = filterMavenDependencies(all, { scope, includes, excludes });
            let declaredFile = null;
            let classpathCached = false;
            if (args.includeClasspath === true) {
              const classpathCommand = 'mvn -q -DskipTests dependency:build-classpath -Dmdep.includeScope=runtime -Dmdep.outputFile=target/dc-classpath.txt';
              const classpathFileFor = (run) => path.join(run?.cwd ?? targetRoot, 'target/dc-classpath.txt');
              let classpathRun = await runCommandCached({ command: classpathCommand });
              let classpathFile = classpathFileFor(classpathRun);
              if (classpathRun.cached && !(await access(classpathFile).then(() => true).catch(() => false))) {
                classpathRun = await runCommandCached({ command: classpathCommand }, { force: true });
                classpathFile = classpathFileFor(classpathRun);
              }
              if (!classpathRun.ok) {
                throw new AppError(
                  'MAVEN_COMMAND_FAILED',
                  `Maven dependency:build-classpath 失败（exit ${classpathRun.exitCode ?? 'unknown'}）`,
                  { exitCode: 3, details: { reason: 'build-classpath' } },
                );
              }
              classpathCached = Boolean(classpathRun.cached);
              declaredFile = relativeDeclaredPath(classpathFile);
              if (!declaredFile) {
                throw new AppError('MAVEN_OUTPUT_OUT_OF_SCOPE', 'Maven classpath 输出不在允许的源码根或 run 目录内', {
                  exitCode: 3,
                  details: { reason: 'maven-output' },
                });
              }
            }
            const limited = filtered.slice(0, 200);
            return {
              root: 'backend',
              scope,
              count: filtered.length,
              totalCount: all.length,
              omittedCount: limited.filter((entry) => entry.omitted).length,
              dependencies: limited,
              truncated: filtered.length > 200 || all.length > 5000,
              declaredFile,
              cached: Boolean(treeRun.cached),
              classpathCached,
            };
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
    resetCommandCache,
  };
}
