import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  diffClasspaths,
  findPortPids,
  listJavaProcesses,
  normalizeArtifact,
  parseDeclaredText,
  parseJarFilename,
  parseJcmdCommandLine,
  parseJcmdSystemProperties,
  parseJpsOutput,
  parseManifestClassPath,
  readJarMetadata,
  runtimeClasspath,
  splitClasspath,
} from '../../src/evidence/jvm.mjs';
import { tempDir } from './tmp.mjs';
import { createTools, toolSpecs } from '../../src/tools/index.mjs';
import { parseScenario } from '../../src/core/scenario.mjs';

const exec = promisify(execFile);
const BS = String.fromCharCode(92);
const IS_WIN = process.platform === 'win32';
const CP_SEP = IS_WIN ? ';' : ':';

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

test('parses jps rows and filters the jps process itself', () => {
  const rows = parseJpsOutput('123 com.demo.App\n456 ruoyi-admin.jar\n789 jdk.jcmd/sun.tools.jps.Jps\n');
  assert.deepEqual(rows, [
    { pid: 123, mainClass: 'com.demo.App' },
    { pid: 456, mainClass: 'ruoyi-admin.jar' },
  ]);
});

test('splits Windows and Unix classpaths without breaking drive letters', () => {
  assert.deepEqual(
    splitClasspath(`C:${BS}work${BS}a.jar;C:${BS}work${BS}b.jar`),
    [`C:${BS}work${BS}a.jar`, `C:${BS}work${BS}b.jar`],
  );
  assert.deepEqual(splitClasspath('/opt/app/a.jar:/opt/app/b.jar'), ['/opt/app/a.jar', '/opt/app/b.jar']);
  assert.deepEqual(splitClasspath('"/opt/a b.jar"'), ['/opt/a b.jar']);
});

test('parses jar filenames, classifiers and timestamped snapshots', () => {
  assert.deepEqual(parseJarFilename('log4j-1.2-api-2.17.1.jar'), {
    artifact: 'log4j-1.2-api',
    version: '2.17.1',
    classifier: null,
  });
  assert.deepEqual(parseJarFilename('demo-1.0.0-SNAPSHOT.jar'), {
    artifact: 'demo',
    version: '1.0.0-SNAPSHOT',
    classifier: null,
  });
  assert.equal(normalizeArtifact('demo-1.0.0-sources.jar'), null);
  assert.deepEqual(parseJarFilename('demo-1.0.0-sources.jar'), {
    artifact: 'demo',
    version: '1.0.0',
    classifier: 'sources',
  });
  assert.deepEqual(parseJarFilename('demo-1.0-20231101.120000-1.jar'), {
    artifact: 'demo',
    version: '1.0-SNAPSHOT',
    classifier: null,
  });
});

test('derives Maven and Gradle coordinates from repository paths', () => {
  const maven = normalizeArtifact(
    'C:/Users/me/.m2/repository/org/apache/httpcomponents/httpclient/4.5.14/httpclient-4.5.14.jar',
  );
  assert.equal(maven.group, 'org.apache.httpcomponents');
  assert.equal(maven.artifact, 'httpclient');
  assert.equal(maven.version, '4.5.14');

  const gradle = normalizeArtifact(
    '/home/me/.gradle/caches/modules-2/files-2.1/com.fasterxml.jackson.core/jackson-databind/2.17.2/abcdef0123456789/jackson-databind-2.17.2.jar',
  );
  assert.equal(gradle.group, 'com.fasterxml.jackson.core');
  assert.equal(gradle.artifact, 'jackson-databind');
  assert.equal(gradle.version, '2.17.2');
});

test('diffs missing, version mismatch and runtime-only artifacts', () => {
  const declared = [
    normalizeArtifact('com.example:common-core:2.3.1'),
    normalizeArtifact('com.fasterxml.jackson.core:jackson-databind:2.17.2'),
    normalizeArtifact('com.example:present:1.0.0'),
  ];
  const runtime = [
    normalizeArtifact('jackson-databind-2.15.4.jar'),
    normalizeArtifact('present-1.0.0.jar'),
    normalizeArtifact('old.internal:legacy-sdk:1.0.3'),
  ];
  const diff = diffClasspaths(declared, runtime);
  assert.deepEqual(diff.missing, ['com.example:common-core:2.3.1']);
  assert.deepEqual(diff.versionMismatch, [{
    artifact: 'com.fasterxml.jackson.core:jackson-databind',
    declared: '2.17.2',
    runtime: '2.15.4',
  }]);
  assert.deepEqual(diff.runtimeOnly, ['old.internal:legacy-sdk:1.0.3']);
});

test('matches a group-qualified declared entry to a bare runtime jar', () => {
  const diff = diffClasspaths(
    [normalizeArtifact('org.foo:bar:1.0')],
    [normalizeArtifact('bar-1.0.jar')],
  );
  assert.deepEqual(diff.missing, []);
  assert.deepEqual(diff.versionMismatch, []);
  assert.deepEqual(diff.runtimeOnly, []);
});

test('reports multiple runtime versions of the same artifact', () => {
  const diff = diffClasspaths(
    [normalizeArtifact('com.foo:bar:2.0')],
    [normalizeArtifact('bar-1.0.jar'), normalizeArtifact('bar-2.0.jar')],
  );
  assert.deepEqual(diff.missing, []);
  assert.deepEqual(diff.versionMismatch, [{ artifact: 'com.foo:bar', declared: '2.0', runtime: '1.0, 2.0' }]);
});

test('truncates each diff category independently', () => {
  const declared = [];
  const runtime = [];
  for (let index = 0; index < 60; index += 1) {
    declared.push(normalizeArtifact(`com.example:declared-${index}:1.0`));
    runtime.push(normalizeArtifact(`runtime-only-${index}-1.0.jar`));
  }
  const diff = diffClasspaths(declared, runtime, { limit: 5 });
  assert.equal(diff.missing.length, 5);
  assert.equal(diff.runtimeOnly.length, 5);
  assert.equal(diff.truncated.missing, true);
  assert.equal(diff.truncated.runtimeOnly, true);
});

test('parses declared classpath formats', () => {
  assert.deepEqual(parseDeclaredText('a-1.0.jar;b-2.0.jar'), ['a-1.0.jar', 'b-2.0.jar']);
  assert.deepEqual(parseDeclaredText('["g:a:1.0", "g:b:2.0"]'), ['g:a:1.0', 'g:b:2.0']);
  assert.deepEqual(
    parseDeclaredText('[INFO] +- org.foo:bar:jar:1.2.3:compile\n[INFO] - org.foo:baz:jar:2.0.0:runtime'),
    ['org.foo:bar:jar:1.2.3:compile', 'org.foo:baz:jar:2.0.0:runtime'],
  );
  assert.deepEqual(
    parseDeclaredText('[INFO] com.example:demo:jar:1.0\n[INFO] +- org.foo:bar:jar:1.2.3:compile'),
    ['org.foo:bar:jar:1.2.3:compile'],
  );
  assert.deepEqual(
    parseDeclaredText('[INFO] +- g:a:jar:1.0:test\n[INFO] +- g:b:jar:2.0:compile'),
    ['g:b:jar:2.0:compile'],
  );
  assert.deepEqual(parseDeclaredText('[INFO] --- maven-dependency-plugin:3.6.0:tree ---'), []);
  assert.deepEqual(
    parseDeclaredText('/home/me/.m2/repository/a-1.0.jar:/home/me/.m2/repository/b-2.0.jar'),
    ['/home/me/.m2/repository/a-1.0.jar', '/home/me/.m2/repository/b-2.0.jar'],
  );
});

test('whitelists jcmd system properties and parses command line', () => {
  const props = parseJcmdSystemProperties([
    'java.class.path=C:/work/a.jar',
    'user.dir=C:/work',
    'db.password=secret',
    'sun.java.command=com.demo.App --flag',
  ].join('\n'));
  assert.deepEqual(props, {
    'java.class.path': 'C:/work/a.jar',
    'user.dir': 'C:/work',
    'sun.java.command': 'com.demo.App --flag',
  });

  const command = parseJcmdCommandLine(
    `java_command: com.demo.App --flag\njava_class_path (initial): C:${BS}a.jar;C:${BS}b.jar`,
  );
  assert.equal(command.command, 'com.demo.App --flag');
  assert.equal(command.classPath, `C:${BS}a.jar;C:${BS}b.jar`);
});

test('unfolds manifest Class-Path entries', () => {
  const text = 'Manifest-Version: 1.0\r\nClass-Path: lib/a.jar lib/b.jar lib/c.\r\n jar\r\n';
  assert.deepEqual(parseManifestClassPath(text), ['lib/a.jar', 'lib/b.jar', 'lib/c.jar']);
});

test('returns an empty list for unused local ports', async () => {
  const pids = await findPortPids(1);
  assert.ok(Array.isArray(pids));
  assert.equal(pids.length, 0);
});

test('reads Spring Boot nested libs and manifest without exposing paths', async (t) => {
  if (!(await commandWorks('jar', ['--version']))) {
    t.skip('jar tool is not available');
    return;
  }
  const dir = tempDir('jvm-jar-test');
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });
  await mkdir(path.join(dir, 'fake/BOOT-INF/lib'), { recursive: true });
  await mkdir(path.join(dir, 'fake/BOOT-INF/classes'), { recursive: true });
  await mkdir(path.join(dir, 'fake/META-INF'), { recursive: true });
  await writeFile(path.join(dir, 'fake/BOOT-INF/lib/dep-1.0.jar'), '');
  await writeFile(path.join(dir, 'fake/BOOT-INF/classes/App.class'), '');
  await writeFile(
    path.join(dir, 'fake/META-INF/MANIFEST.MF'),
    'Manifest-Version: 1.0\r\nClass-Path: lib/x-2.0.jar\r\n\r\n',
  );
  const jarFile = path.join(dir, 'app.jar');
  await exec('jar', ['--create', '--file', jarFile, '--manifest', path.join(dir, 'fake/META-INF/MANIFEST.MF'), '-C', path.join(dir, 'fake'), '.'], {
    timeout: 20000,
    windowsHide: true,
  });

  const metadata = await readJarMetadata(jarFile);
  assert.equal(metadata.error, null);
  assert.equal(metadata.format, 'spring-boot-jar');
  assert.deepEqual(metadata.libs, ['dep-1.0.jar']);
  assert.deepEqual(metadata.manifestClassPath, ['lib/x-2.0.jar']);
  assert.equal(JSON.stringify(metadata).includes(dir), false);
});

test('diffs a real running JVM against a declared classpath file', async (t) => {
  const hasJdk = (await commandWorks('java', ['-version'])) && (await commandWorks('javac', ['-version']));
  if (!hasJdk) {
    t.skip('JDK java/javac is not available');
    return;
  }
  const { spawn } = await import('node:child_process');
  const dir = tempDir('jvm-runtime-test');
  await mkdir(path.join(dir, 'classes'), { recursive: true });
  await mkdir(path.join(dir, 'empty'), { recursive: true });
  await writeFile(path.join(dir, 'empty/dummy.txt'), 'x');
  await writeFile(
    path.join(dir, 'App.java'),
    'public class App { public static void main(String[] args) throws Exception { Thread.sleep(60000); } }',
  );
  await exec('javac', ['-d', 'classes', 'App.java'], { cwd: dir, timeout: 30000, windowsHide: true });
  await exec('jar', ['--create', '--file', 'a-1.0.jar', '-C', 'empty', '.'], { cwd: dir, timeout: 20000, windowsHide: true });
  await exec('jar', ['--create', '--file', 'b-2.0.jar', '-C', 'empty', '.'], { cwd: dir, timeout: 20000, windowsHide: true });
  await writeFile(path.join(dir, 'declared.txt'), 'a-1.0.jar\nc-3.0.jar\n');
  await writeFile(path.join(dir, '..', `declared-outside-${process.pid}.txt`), 'a-1.0.jar\n');

  const classpath = ['classes', 'a-1.0.jar', 'b-2.0.jar'].join(CP_SEP);
  const child = spawn('java', ['-cp', classpath, 'App'], {
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
    await rm(path.join(dir, '..', `declared-outside-${process.pid}.txt`), { force: true });
  });

  let found = false;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (child.exitCode !== null) break;
    const listed = await listJavaProcesses();
    if (listed.processes.some((process) => process.pid === child.pid)) {
      found = true;
      break;
    }
    await delay(250);
  }
  assert.equal(found, true, 'java process should appear in jps');

  const result = await runtimeClasspath({
    pid: child.pid,
    declaredFile: 'declared.txt',
    allowRoots: [dir],
    cwd: dir,
  });
  assert.equal(result.pid, child.pid);
  assert.equal(result.mainClass, 'App');
  assert.ok(result.runtimeSources.includes('java.class.path'));
  assert.ok(result.classDirCount >= 1);
  assert.ok(result.missing.includes('c:3.0'), JSON.stringify(result));
  assert.ok(result.runtimeOnly.includes('b:2.0'), JSON.stringify(result));
  assert.equal(result.missing.includes('a:1.0'), false);
  assert.equal(JSON.stringify(result).includes(dir), false);

  const scenario = parseScenario({
    name: 'jvm-runtime',
    baseUrl: 'http://127.0.0.1:1',
    method: 'GET',
    path: '/',
    source: { root: dir },
  });
  const { tools, calls } = createTools({ scenario, anchor: Date.now(), runDir: dir });
  const viaTool = await tools.runtime_classpath({ pid: child.pid, declaredFile: 'declared.txt' });
  assert.equal(viaTool.missing.includes('c:3.0'), true);
  assert.ok(calls.some((call) => call.name === 'runtime_classpath'));

  await assert.rejects(
    runtimeClasspath({
      pid: child.pid,
      declaredFile: path.join(dir, '..', `declared-outside-${process.pid}.txt`),
      allowRoots: [dir],
      cwd: dir,
    }),
    (error) => error.code === 'DECLARED_CLASSPATH_OUT_OF_SCOPE',
  );
});

test('exposes JVM tools through the in-process tool registry', async (t) => {
  const names = toolSpecs({}).map((spec) => spec.name);
  assert.ok(names.includes('list_java_processes'));
  assert.ok(names.includes('runtime_classpath'));

  const dir = tempDir('jvm-tools-registry');
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });
  const scenario = parseScenario({
    name: 'jvm-tools',
    baseUrl: 'http://127.0.0.1:1',
    method: 'GET',
    path: '/',
  });
  const { tools } = createTools({ scenario, anchor: Date.now(), runDir: dir });
  const noPid = await tools.runtime_classpath({ declaredFile: 'classpath.txt' });
  assert.equal(noPid.code, 'JVM_PID_REQUIRED');
  const listed = await tools.list_java_processes({ port: 1 });
  assert.equal(listed.count, 0);
});
