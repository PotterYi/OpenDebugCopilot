import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { parseScenario } from '../../src/core/scenario.mjs';
import {
  checkDatabases,
  queryDatabase,
  validateReadSql,
  validateWriteSql,
  writeDatabase,
} from '../../src/evidence/db.mjs';
import { createDatabaseStore } from '../../src/core/database-store.mjs';
import { createTools } from '../../src/tools/index.mjs';
import { createService } from '../../src/app/service.mjs';
import { createMockAgent } from '../../src/agent/mock.mjs';
import { tempDir } from './tmp.mjs';

const TMP = tempDir('db-test');

function fakeRows(rows = [{ id: 1 }, { id: 2 }]) {
  return [rows, [{ name: 'id' }]];
}

function fakeConnect({ rows, fail = null, calls = [] } = {}) {
  return async (options) => {
    calls.push({ type: 'connect', options });
    if (fail) throw fail;
    const client = {
      async query(sql) {
        calls.push({ type: 'query', sql });
        return fakeRows(rows);
      },
      async beginTransaction() { calls.push({ type: 'begin' }); },
      async commit() { calls.push({ type: 'commit' }); },
      async rollback() { calls.push({ type: 'rollback' }); },
      async end() { calls.push({ type: 'end' }); },
      destroy() { calls.push({ type: 'destroy' }); },
    };
    return client;
  };
}

const connection = {
  id: 'db-1',
  name: 'local',
  enabled: true,
  allowWrite: false,
  host: '127.0.0.1',
  port: 3306,
  user: 'root',
  database: 'demo',
  connectTimeoutMs: 1000,
};

test.beforeEach(async () => {
  await rm(TMP, { recursive: true, force: true });
  await mkdir(TMP, { recursive: true });
});
test.afterEach(async () => {
  await rm(TMP, { recursive: true, force: true });
});

test('read SQL allows only single read statements', () => {
  assert.equal(validateReadSql('  select * from t; '), 'select * from t');
  assert.equal(validateReadSql('SHOW TABLES'), 'SHOW TABLES');
  assert.throws(() => validateReadSql('delete from t'), /Only SELECT/);
  assert.throws(() => validateReadSql('select * from t; select * from u'), /one SQL statement/);
  assert.throws(() => validateReadSql('select * from t into outfile "x"'), /not allowed/);
});

test('write SQL allows only single DML statements', () => {
  assert.equal(validateWriteSql('update t set a=1'), 'update t set a=1');
  assert.throws(() => validateWriteSql('select * from t'), /Only INSERT/);
  assert.throws(() => validateWriteSql('drop table t'), /Only INSERT/);
});

test('queryDatabase bounds select results and reports truncation', async () => {
  const calls = [];
  const result = await queryDatabase({
    connection,
    sql: 'select * from t',
    limit: 1,
    connect: fakeConnect({ calls }),
  });
  assert.equal(calls[1].sql, 'select * from t LIMIT 1');
  assert.deepEqual(result.columns, ['id']);
  assert.equal(result.rowCount, 2);
  assert.equal(result.rows.length, 1);
  assert.equal(result.truncated, true);
  assert.equal(result.connection.name, 'local');
});

test('checkDatabases reports reachable connections', async () => {
  const results = await checkDatabases([connection], { connect: fakeConnect() });
  assert.equal(results.length, 1);
  assert.equal(results[0].ok, true);
  assert.equal(results[0].id, 'db-1');
});

test('writeDatabase requires approval and commits approved writes', async () => {
  const denied = await writeDatabase({
    connection,
    sql: 'update t set a=1',
    approve: async () => false,
    connect: fakeConnect(),
  });
  assert.equal(denied.ok, false);
  assert.equal(denied.code, 'USER_DENIED');

  const calls = [];
  const done = await writeDatabase({
    connection,
    sql: 'update t set a=1',
    approve: async () => true,
    connect: fakeConnect({ calls }),
  });
  assert.equal(done.ok, true);
  assert.ok(calls.some((call) => call.type === 'begin'));
  assert.ok(calls.some((call) => call.type === 'commit'));
});

test('database store masks passwords and decrypts only at runtime', async () => {
  const codec = {
    scheme: 'test',
    encrypt: (value) => Buffer.from(`enc:${value}`).toString('base64'),
    decrypt: (data) => Buffer.from(data, 'base64').toString('utf8').replace(/^enc:/, ''),
  };
  const store = createDatabaseStore({ configDir: TMP, secretCodec: codec });
  const saved = await store.save({
    activeId: 'db-1',
    connections: [{ id: 'db-1', name: 'local', host: '127.0.0.1', user: 'root', password: 'p@ss' }],
  });
  assert.equal(saved.activeId, 'db-1');
  assert.equal(saved.connections[0].hasPassword, true);
  assert.equal(saved.connections[0].password, undefined);

  const raw = JSON.parse(await readFile(path.join(TMP, 'databases.json'), 'utf8'));
  assert.notEqual(raw.connections[0].password, 'p@ss');
  assert.equal(raw.connections[0].password.scheme, 'test');

  const runtime = await store.getRuntimeConfig();
  assert.equal(runtime.connections[0].password, 'p@ss');
});

test('query_db stores every result under the run db-queries directory', async (t) => {
  t.after(async () => { await rm(TMP, { recursive: true, force: true }); });
  const scenario = parseScenario({
    name: 'db-tools',
    baseUrl: 'http://127.0.0.1:1',
    method: 'GET',
    path: '/',
    logfiles: [],
  });
  const runDir = path.join(TMP, 'runs', 'run-1');
  const { tools, dbQueries } = createTools({
    scenario,
    anchor: Date.now(),
    runDir,
    databases: [{ ...connection, allowWrite: true }],
    activeDatabaseId: 'db-1',
    approveWrite: async () => true,
    databaseConnect: fakeConnect({ rows: [{ id: 7 }] }),
  });

  const result = await tools.query_db({ sql: 'select id from orders' });
  assert.equal(result.rowCount, 1);
  assert.equal(dbQueries.length, 1);
  assert.match(dbQueries[0].file, /^db-queries\//);
  const persisted = JSON.parse(await readFile(path.join(runDir, dbQueries[0].file), 'utf8'));
  assert.equal(persisted.result.rows[0].id, 7);

  const written = await tools.write_db({ sql: 'update orders set status=1' });
  assert.equal(written.ok, true);
  assert.equal(dbQueries.length, 2);
  assert.equal(dbQueries[1].name, 'write_db');
});

test('database artifacts redact credentials in rows and SQL', async (t) => {
  t.after(async () => { await rm(TMP, { recursive: true, force: true }); });
  const scenario = parseScenario({
    name: 'db-redact',
    baseUrl: 'http://127.0.0.1:1',
    method: 'GET',
    path: '/',
    logfiles: [],
  });
  const runDir = path.join(TMP, 'runs', 'run-redact');
  const { tools, dbQueries } = createTools({
    scenario,
    anchor: Date.now(),
    runDir,
    databases: [{ ...connection }],
    activeDatabaseId: 'db-1',
    databaseConnect: fakeConnect({
      rows: [{ id: 7, password: 'hunter2secret', token: 'opaque-token', note: 'keep me' }],
    }),
  });

  const result = await tools.query_db({ sql: "select * from users where password='letmein123'" });
  assert.equal(result.rows[0].id, 7);
  assert.equal(result.rows[0].password, '<redacted>');
  assert.equal(result.rows[0].token, '<redacted>');
  assert.equal(result.rows[0].note, 'keep me');

  const persisted = JSON.parse(await readFile(path.join(runDir, dbQueries[0].file), 'utf8'));
  assert.equal(persisted.result.rows[0].password, '<redacted>');
  assert.equal(persisted.result.rows[0].note, 'keep me');
  assert.match(persisted.sql, /password='<redacted>'/);
  assert.doesNotMatch(JSON.stringify(persisted), /hunter2secret|opaque-token|letmein123/);
});

test('deleting a diagnosis removes its database query results', async (t) => {
  t.after(async () => { await rm(TMP, { recursive: true, force: true }); });
  const runsDir = path.join(TMP, 'runs');
  const service = createService({ root: TMP, configDir: path.join(TMP, 'configs'), runsDir });
  const runDir = path.join(runsDir, 'run-delete');
  await mkdir(path.join(runDir, 'db-queries'), { recursive: true });
  await writeFile(path.join(runDir, 'result.json'), '{}', 'utf8');
  await writeFile(path.join(runDir, 'db-queries', 'dbq-001.json'), '{"rows":[1]}', 'utf8');

  const response = await service.deleteRun('run-delete');
  assert.equal(response.deleted, true);
  assert.equal(response.databaseQueries, 1);
  await assert.rejects(access(runDir), /ENOENT/);
  await assert.rejects(access(path.join(runDir, 'db-queries', 'dbq-001.json')), /ENOENT/);
});

test('capture diagnosis threads databases into tools and persists query metadata', async (t) => {
  t.after(async () => { await rm(TMP, { recursive: true, force: true }); });
  const { runCaptureDiagnosis } = await import('../../src/diagnose/run.mjs');
  const runtimeConnection = { ...connection, allowWrite: false, password: 'secret' };
  const agent = {
    id: 'db-test-agent',
    async diagnose({ tools }) {
      const result = await tools.tools.query_db({ sql: 'select id from orders' });
      assert.equal(result.rowCount, 1);
      return {
        conclusion: '查询到订单',
        evidenceRefs: [{ type: 'request', ref: 'request' }],
        confidence: 0.9,
        needsMoreInfo: [],
        fixes: [],
      };
    },
  };
  const runsDir = path.join(TMP, 'runs');
  const { result, runDir } = await runCaptureDiagnosis({
    request: { method: 'GET', url: 'http://localhost/api/orders', headers: {}, body: null, startedAt: Date.now() },
    response: { status: 200, statusText: 'OK', ok: true, headers: {}, body: '{}', durationMs: 1 },
    firedAt: Date.now(),
  }, {
    workspace: { logfiles: [], window: { beforeMs: 1000, afterMs: 1000 } },
    root: TMP,
    runsDir,
    agent,
    databases: [runtimeConnection],
    activeDatabaseId: 'db-1',
    preflight: { ok: true, checks: [], databases: [runtimeConnection] },
    databaseConnect: fakeConnect({ rows: [{ id: 42 }] }),
  });

  assert.equal(result.databaseQueries.length, 1);
  assert.equal(result.databaseQueries[0].rowCount, 1);
  assert.equal(result.databases.activeId, 'db-1');
  assert.equal(result.databases.connections[0].id, 'db-1');
  assert.equal(result.meta.logContext.databases[0].id, 'db-1');
  assert.equal(JSON.stringify(result).includes('secret'), false);
  const meta = JSON.parse(await readFile(path.join(runDir, 'meta.json'), 'utf8'));
  assert.equal(JSON.stringify(meta).includes('secret'), false);
  assert.equal(meta.preflight.databases[0].id, 'db-1');
  assert.equal(meta.preflight.databases[0].password, undefined);

  const queryFile = path.join(runDir, result.databaseQueries[0].file);
  const stored = JSON.parse(await readFile(queryFile, 'utf8'));
  assert.equal(stored.result.rows[0].id, 42);

  const service = createService({ root: TMP, configDir: path.join(TMP, 'configs'), runsDir });
  const deleted = await service.deleteRun(result.meta.runId);
  assert.equal(deleted.databaseQueries, 1);
  await assert.rejects(access(queryFile), /ENOENT/);
});

test('queryDatabase wraps connection failures as DB_QUERY_FAILED', async () => {
  await assert.rejects(
    queryDatabase({
      connection,
      sql: 'select 1',
      connect: async () => { throw new Error('connection lost'); },
    }),
    (error) => error?.code === 'DB_QUERY_FAILED' && /connection lost/.test(error.message),
  );
});

test('unreachable database degrades to source/log diagnosis instead of failing', async (t) => {
  t.after(async () => { await rm(TMP, { recursive: true, force: true }); });
  const { runCaptureDiagnosis } = await import('../../src/diagnose/run.mjs');
  const { result } = await runCaptureDiagnosis({
    request: { method: 'GET', url: 'http://localhost/api/orders', headers: {}, body: null, startedAt: Date.now() },
    response: { status: 500, statusText: 'Error', ok: false, headers: {}, body: '{}', durationMs: 1 },
    firedAt: Date.now(),
  }, {
    workspace: { logfiles: [], window: { beforeMs: 1000, afterMs: 1000 } },
    root: TMP,
    runsDir: path.join(TMP, 'runs'),
    agent: createMockAgent(),
    databases: [{ ...connection, password: 'secret' }],
    activeDatabaseId: 'db-1',
    // Simulates preflight: the connection is configured but SELECT 1 failed.
    preflight: { ok: true, checks: [], databases: [] },
  });

  assert.match(result.databases.notice, /数据库查询不可用/);
  assert.equal(result.databases.connections.length, 0);
  assert.ok(result.agent.conclusion.length > 0);
  assert.equal(result.agent.incomplete, undefined);
});

test('a failed query mid-run keeps the diagnosis alive and records a notice', async (t) => {
  t.after(async () => { await rm(TMP, { recursive: true, force: true }); });
  const { runCaptureDiagnosis } = await import('../../src/diagnose/run.mjs');
  const runtimeConnection = { ...connection, password: 'secret' };
  const agent = {
    id: 'db-failure-agent',
    async diagnose({ tools }) {
      const failed = await tools.tools.query_db({ sql: 'select id from orders' });
      assert.equal(failed.error, true);
      assert.equal(failed.code, 'DB_QUERY_FAILED');
      return {
        conclusion: '数据库不可用，已改为根据源码与日志判断',
        evidenceRefs: [{ type: 'request', ref: 'request' }],
        confidence: 0.6,
        needsMoreInfo: [],
        fixes: [],
      };
    },
  };
  const { result } = await runCaptureDiagnosis({
    request: { method: 'GET', url: 'http://localhost/api/orders', headers: {}, body: null, startedAt: Date.now() },
    response: { status: 500, statusText: 'Error', ok: false, headers: {}, body: '{}', durationMs: 1 },
    firedAt: Date.now(),
  }, {
    workspace: { logfiles: [], window: { beforeMs: 1000, afterMs: 1000 } },
    root: TMP,
    runsDir: path.join(TMP, 'runs'),
    agent,
    databases: [runtimeConnection],
    activeDatabaseId: 'db-1',
    preflight: { ok: true, checks: [], databases: [runtimeConnection] },
    databaseConnect: async () => { throw new Error('database offline'); },
  });

  assert.match(result.databases.notice, /数据库查询不可用/);
  assert.equal(result.databaseQueries.length, 1);
  assert.equal(result.databaseQueries[0].error, true);
  assert.match(result.agent.conclusion, /源码与日志/);
});
