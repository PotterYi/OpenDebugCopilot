import { createConnection } from 'mysql2/promise';
import { AppError } from '../core/errors.mjs';

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;
const DEFAULT_QUERY_TIMEOUT_MS = 5000;
const DEFAULT_CONNECT_TIMEOUT_MS = 3000;

function dbError(message, code = 'DB_ERROR', details) {
  return new AppError(code, message, { exitCode: 1, details });
}

function sanitizeError(error) {
  const message = String(error?.message ?? error ?? 'database error');
  return message.slice(0, 400);
}

function connectionOptions(connection, connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT_MS) {
  if (connection?.secretError) throw dbError(connection.secretError, 'DB_SECRET_UNAVAILABLE');
  return {
    host: connection.host,
    port: connection.port,
    user: connection.user,
    password: connection.password ?? undefined,
    database: connection.database || undefined,
    ssl: connection.ssl || undefined,
    connectTimeout: connection.connectTimeoutMs ?? connectTimeoutMs,
    multipleStatements: false,
  };
}

async function closeClient(client) {
  try {
    await client?.end?.();
  } catch {
    // already closed/destroyed
  }
}

function connectionLabel(connection) {
  return {
    id: connection.id,
    name: connection.name,
    host: connection.host,
    database: connection.database ?? '',
  };
}

function stripTrailingSemicolon(sql) {
  return String(sql ?? '').trim().replace(/;\s*$/, '');
}

function assertSingleStatement(text) {
  if (/;\s*\S/.test(text)) {
    throw dbError('Only one SQL statement is allowed', 'DB_MULTIPLE_STATEMENTS');
  }
}

function assertSafeSql(text) {
  if (/\b(?:into\s+(?:outfile|dumpfile)|load_file|for\s+update|lock\s+in\s+share\s+mode)\b/i.test(text)) {
    throw dbError('This SQL form is not allowed', 'DB_SQL_FORBIDDEN');
  }
}

function clampLimit(value) {
  const number = Number(value ?? DEFAULT_LIMIT);
  if (!Number.isFinite(number) || number <= 0) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.floor(number));
}

export function validateReadSql(sql) {
  const text = stripTrailingSemicolon(sql);
  if (!text) throw dbError('SQL is required', 'DB_SQL_REQUIRED');
  assertSingleStatement(text);
  const keyword = text.match(/^([a-z]+)/i)?.[1]?.toLowerCase();
  if (!['select', 'show', 'describe', 'desc', 'explain'].includes(keyword)) {
    throw dbError('Only SELECT / SHOW / DESCRIBE / EXPLAIN are allowed', 'DB_SQL_NOT_READONLY');
  }
  assertSafeSql(text);
  return text;
}

export function validateWriteSql(sql) {
  const text = stripTrailingSemicolon(sql);
  if (!text) throw dbError('SQL is required', 'DB_SQL_REQUIRED');
  assertSingleStatement(text);
  const keyword = text.match(/^([a-z]+)/i)?.[1]?.toLowerCase();
  if (!['insert', 'update', 'delete'].includes(keyword)) {
    throw dbError('Only INSERT / UPDATE / DELETE are allowed', 'DB_SQL_NOT_WRITABLE');
  }
  assertSafeSql(text);
  return text;
}

function withLimit(sql, limit) {
  const text = sql.trim();
  if (!/^select\b/i.test(text)) return text;
  if (/\blimit\b/i.test(text)) return text;
  return `${text} LIMIT ${limit}`;
}

async function runWithTimeout(connection, sql, timeoutMs) {
  let timer;
  try {
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        try {
          connection.destroy();
        } catch {
          // ignore
        }
        reject(dbError(`Query timed out after ${timeoutMs}ms`, 'DB_QUERY_TIMEOUT'));
      }, timeoutMs);
    });
    return await Promise.race([connection.query(sql), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Probe enabled database connections in parallel (SELECT 1).
 *
 * @param {Array<any>} connections
 * @param {{ connect?: Function, timeoutMs?: number }} [options]
 */
export async function checkDatabases(connections = [], {
  connect = createConnection,
  timeoutMs = DEFAULT_CONNECT_TIMEOUT_MS,
} = {}) {
  const results = await Promise.all((connections ?? []).map(async (connection) => {
    const started = Date.now();
    let client;
    try {
      client = await connect(connectionOptions(connection, timeoutMs));
      await runWithTimeout(client, 'SELECT 1', timeoutMs);
      return {
        ...connectionLabel(connection),
        ok: true,
        latencyMs: Date.now() - started,
        error: null,
      };
    } catch (error) {
      return {
        ...connectionLabel(connection),
        ok: false,
        latencyMs: Date.now() - started,
        error: sanitizeError(error),
      };
    } finally {
      await closeClient(client);
    }
  }));
  return results;
}

/**
 * Execute a read-only query (including schema queries such as SHOW TABLES / DESCRIBE).
 *
 * @param {{
 *   connection: any,
 *   sql: string,
 *   limit?: number,
 *   timeoutMs?: number,
 *   connect?: Function
 * }} options
 */
export async function queryDatabase({
  connection,
  sql,
  limit = DEFAULT_LIMIT,
  timeoutMs = DEFAULT_QUERY_TIMEOUT_MS,
  connect = createConnection,
} = {}) {
  if (!connection) throw dbError('No database connection selected', 'DB_CONNECTION_REQUIRED');
  const readSql = validateReadSql(sql);
  const boundedLimit = clampLimit(limit);
  const finalSql = withLimit(readSql, boundedLimit);
  const started = Date.now();
  let client;
  try {
    client = await connect(connectionOptions(connection));
    const [rows, fields] = await runWithTimeout(client, finalSql, timeoutMs);
    const allRows = Array.isArray(rows) ? rows : [];
    return {
      connection: connectionLabel(connection),
      sql: readSql,
      columns: Array.isArray(fields) ? fields.map((field) => field.name) : [],
      rows: allRows.slice(0, boundedLimit),
      rowCount: allRows.length,
      truncated: allRows.length > boundedLimit,
      durationMs: Date.now() - started,
    };
  } finally {
    await closeClient(client);
  }
}

/**
 * Execute one approved DML statement in a transaction.
 *
 * @param {{
 *   connection: any,
 *   sql: string,
 *   approve?: (input: { connection: any, sql: string }) => Promise<boolean>,
 *   timeoutMs?: number,
 *   connect?: Function
 * }} options
 */
export async function writeDatabase({
  connection,
  sql,
  approve,
  timeoutMs = DEFAULT_QUERY_TIMEOUT_MS,
  connect = createConnection,
} = {}) {
  if (!connection) throw dbError('No database connection selected', 'DB_CONNECTION_REQUIRED');
  if (typeof approve !== 'function') {
    throw dbError('Writing requires explicit user approval', 'DB_WRITE_APPROVAL_REQUIRED');
  }
  const writeSql = validateWriteSql(sql);
  const allowed = await approve({ connection: connectionLabel(connection), sql: writeSql });
  if (!allowed) {
    return { ok: false, code: 'USER_DENIED', connection: connectionLabel(connection) };
  }

  let client;
  try {
    client = await connect(connectionOptions(connection));
    await client.beginTransaction();
    const [result] = await runWithTimeout(client, writeSql, timeoutMs);
    await client.commit();
    return {
      ok: true,
      connection: connectionLabel(connection),
      sql: writeSql,
      affectedRows: result?.affectedRows ?? 0,
      changedRows: result?.changedRows ?? 0,
      insertId: result?.insertId ?? null,
    };
  } catch (error) {
    await client?.rollback?.().catch?.(() => {});
    throw error;
  } finally {
    await closeClient(client);
  }
}
