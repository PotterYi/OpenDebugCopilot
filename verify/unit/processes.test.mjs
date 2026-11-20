import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  isJavaProcess,
  listProcesses,
  parseEtime,
  parsePsOutput,
  parseWindowsProcessJson,
  parseWmicList,
} from '../../src/evidence/processes.mjs';
import { createTools, toolSpecs } from '../../src/tools/index.mjs';
import { parseScenario } from '../../src/core/scenario.mjs';
import { tempDir } from './tmp.mjs';

const exec = promisify(execFile);

async function commandWorks(command, args) {
  try {
    await exec(command, args, { timeout: 8000, windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

async function delay(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

test('parses elapsed times from ps', () => {
  assert.equal(parseEtime('05:06'), 5 * 60 + 6);
  assert.equal(parseEtime('01:02:03'), 3723);
  assert.equal(parseEtime('2-01:02:03'), 2 * 86400 + 3723);
  assert.equal(parseEtime('bad'), null);
});

test('parses posix ps rows', () => {
  const rows = parsePsOutput([
    '  501   123     1 01:02:03 /usr/bin/java -Ddb.password=hunter2 -jar app.jar',
    '  501   456   123       05:06 node server.mjs',
    '',
  ].join('\n'));
  assert.equal(rows.length, 2);
  assert.equal(rows[0].uid, 501);
  assert.equal(rows[0].pid, 123);
  assert.equal(rows[0].ppid, 1);
  assert.equal(rows[0].name, 'java');
  assert.match(rows[0].command, /hunter2/);
  assert.ok(Date.now() - Date.parse(rows[0].startedAt) >= 3723 * 1000);
  assert.equal(rows[1].name, 'node');
});

test('parses Windows CIM JSON in object and array forms', () => {
  const single = parseWindowsProcessJson(JSON.stringify({
    pid: 123,
    ppid: 1,
    name: 'java.exe',
    startedAt: '2026-11-14T01:30:12.1234567Z',
    command: 'java -jar app.jar',
  }));
  assert.equal(single.length, 1);
  assert.equal(single[0].pid, 123);
  assert.equal(single[0].name, 'java.exe');

  const list = parseWindowsProcessJson(JSON.stringify([
    { pid: 1, ppid: 0, name: 'a.exe', startedAt: null, command: null },
    { pid: 2, ppid: 1, name: 'b.exe', startedAt: '2026-11-14T01:30:12Z', command: 'b' },
    { pid: 0, ppid: 1, name: 'bad' },
  ]));
  assert.deepEqual(list.map((row) => row.pid), [1, 2]);
  assert.equal(list[0].command, null);
  assert.deepEqual(parseWindowsProcessJson('not json'), []);
});

test('parses wmic LIST output and DMTF dates', () => {
  const text = [
    'CommandLine=java -Ddb.password=hunter2 -jar app.jar',
    'CreationDate=20261114093012.123456+480',
    'Name=java.exe',
    'ParentProcessId=10',
    'ProcessId=20',
    '',
    'CommandLine=',
    'CreationDate=',
    'Name=svchost.exe',
    'ParentProcessId=1',
    'ProcessId=30',
    '',
  ].join('\r\n');
  const rows = parseWmicList(text);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].pid, 20);
  assert.equal(rows[0].ppid, 10);
  assert.equal(rows[0].startedAt, '2026-11-14T01:30:12.123Z');
  assert.match(rows[0].command, /hunter2/);
  assert.equal(rows[1].command, null);
});

test('recognizes Java processes by name or executable path', () => {
  assert.equal(isJavaProcess({ name: 'java.exe' }), true);
  assert.equal(isJavaProcess({ name: 'javaw.exe' }), true);
  assert.equal(isJavaProcess({ name: 'node.exe', command: 'node app.js' }), false);
  assert.equal(isJavaProcess({ name: null, command: '/usr/lib/jvm/bin/java -jar app.jar' }), true);
  assert.equal(isJavaProcess({ name: null, command: 'C:/Java/jdk/bin/javaw.exe -jar app.jar' }), true);
});

test('lists a real Java process, redacts its command and filters on the raw command', async (t) => {
  if (!(await commandWorks('java', ['-version'])) || !(await commandWorks('javac', ['-version']))) {
    t.skip('JDK java/javac is not available');
    return;
  }
  const dir = tempDir('processes-runtime-test');
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, 'App.java'),
    'public class App { public static void main(String[] args) throws Exception { Thread.sleep(60000); } }',
  );
  await exec('javac', ['-d', '.', 'App.java'], { cwd: dir, timeout: 30000, windowsHide: true });

  const child = spawn('java', [
    '-Ddb.password=hunter2secret',
    '-Daws.secretKey=AKIAABCDEFGHIJKLMNOP',
    '-cp',
    '.',
    'App',
    '--spring.datasource.password',
    'space-secret',
  ], {
    cwd: dir,
    stdio: 'ignore',
    windowsHide: true,
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await delay(300);
    }
    await rm(dir, { recursive: true, force: true });
  });

  let found = null;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const listed = await listProcesses({ pid: child.pid });
    if (listed.count === 1) {
      found = listed.processes[0];
      break;
    }
    await delay(400);
  }
  assert.ok(found, 'spawned Java process should be visible');
  assert.equal(found.pid, child.pid);
  assert.ok(Number.isInteger(found.ppid));
  assert.match(found.name, /java/i);
  assert.ok(found.startedAt);
  assert.ok(Date.now() - Date.parse(found.startedAt) < 5 * 60 * 1000);
  assert.match(found.command, /-Ddb\.password=<redacted>/);
  assert.match(found.command, /-Daws\.secretKey=<redacted>/);
  assert.match(found.command, /--spring\.datasource\.password <redacted>/);
  const serialized = JSON.stringify(found);
  assert.doesNotMatch(serialized, /hunter2secret|space-secret|AKIA/);

  const byRawCommand = await listProcesses({ commandContains: 'hunter2secret', limit: 20 });
  assert.ok(byRawCommand.processes.some((row) => row.pid === child.pid));
  assert.doesNotMatch(JSON.stringify(byRawCommand), /hunter2secret/);

  const javaOnly = await listProcesses({ javaOnly: true, limit: 20 });
  assert.ok(javaOnly.processes.some((row) => row.pid === child.pid));

  const missing = await listProcesses({ pid: 999999999 });
  assert.equal(missing.count, 0);

  const limited = await listProcesses({ limit: 1 });
  assert.equal(limited.count, 1);
  assert.ok(limited.totalCount >= 1);
});

test('exposes list_processes through the in-process tool registry', async (t) => {
  assert.ok(toolSpecs({}).some((spec) => spec.name === 'list_processes'));
  const dir = tempDir('processes-tool-registry');
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });
  const scenario = parseScenario({
    name: 'processes-tools',
    baseUrl: 'http://127.0.0.1:1',
    method: 'GET',
    path: '/',
  });
  const { tools, calls } = createTools({ scenario, anchor: Date.now(), runDir: dir });
  const invalid = await tools.list_processes({ limit: 0 });
  assert.equal(invalid.code, 'INVALID_PAGE');
  const missing = await tools.list_processes({ pid: 999999999 });
  assert.equal(missing.count, 0);
  assert.ok(calls.some((call) => call.name === 'list_processes'));
});
