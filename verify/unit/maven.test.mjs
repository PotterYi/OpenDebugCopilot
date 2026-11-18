import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseMavenTree, filterMavenDependencies } from '../../src/evidence/maven.mjs';
import { createTools, toolSpecs } from '../../src/tools/index.mjs';
import { parseScenario } from '../../src/core/scenario.mjs';
import { tempDir } from './tmp.mjs';

const TREE = [
  'com.example:demo:jar:1.0',
  '+- org.foo:bar:jar:1.2.3:compile',
  '|  \- org.foo:baz:jar:2.0:runtime',
  '\- com.test:junit:jar:4.13:test (omitted for conflict with 5.0)',
].join('\n');

test('parses Maven tree and filters in-process', () => {
  const deps = parseMavenTree(TREE);
  assert.equal(deps.length, 3);
  assert.equal(deps[0].artifact, 'bar');
  assert.equal(deps[0].scope, 'compile');
  assert.equal(deps[2].omitted, true);
  assert.deepEqual(
    filterMavenDependencies(deps, { scope: 'runtime' }).map((entry) => entry.artifact),
    ['bar', 'baz'],
  );
  assert.deepEqual(
    filterMavenDependencies(deps, { includes: ['org.foo:baz'] }).map((entry) => entry.artifact),
    ['baz'],
  );
  assert.deepEqual(
    filterMavenDependencies(deps, { excludes: ['org.foo:*'] }).map((entry) => entry.artifact),
    ['junit'],
  );
});

test('maven_dependencies runs one full tree and reuses the cache', async (t) => {
  const root = tempDir('maven-tools-test');
  const runDir = path.join(root, 'run');
  await rm(root, { recursive: true, force: true });
  await mkdir(path.join(root, 'target'), { recursive: true });
  await mkdir(runDir, { recursive: true });
  await writeFile(path.join(root, 'pom.xml'), '<project/>\n');
  t.after(async () => { await rm(root, { recursive: true, force: true }); });

  const commands = [];
  const runCommand = async ({ command }) => {
    commands.push(command);
    if (command.includes('dependency:tree')) {
      await writeFile(path.join(root, 'target/dc-dependency-tree.txt'), TREE);
    }
    if (command.includes('dependency:build-classpath')) {
      await writeFile(path.join(root, 'target/dc-classpath.txt'), 'a.jar\n');
    }
    return { ok: true, exitCode: 0, command, cwd: root, output: '' };
  };
  const scenario = parseScenario({
    name: 'maven-tools',
    baseUrl: 'http://127.0.0.1:1',
    method: 'GET',
    path: '/',
    source: { root },
  });
  const { tools, resetCommandCache } = createTools({ scenario, anchor: Date.now(), runDir, runCommand, toolMode: 'sandbox' });

  assert.ok(toolSpecs({ runCommand }).some((spec) => spec.name === 'maven_dependencies'));
  assert.equal(toolSpecs({}).some((spec) => spec.name === 'maven_dependencies'), false);

  const first = await tools.maven_dependencies({
    scope: 'runtime',
    includes: ['org.foo:*'],
    includeClasspath: true,
  });
  assert.equal(first.count, 2);
  assert.equal(first.totalCount, 2);
  assert.equal(first.allCount, 3);
  assert.equal(first.declaredFile, 'target/dc-classpath.txt');
  assert.equal(first.cached, false);
  assert.equal(first.classpathCached, false);
  assert.equal(commands.length, 2);

  const second = await tools.maven_dependencies({
    scope: 'runtime',
    includes: ['org.foo:baz'],
    includeClasspath: true,
  });
  assert.equal(second.count, 1);
  assert.equal(second.cached, true);
  assert.equal(second.classpathCached, true);
  assert.equal(commands.length, 2);

  const compileOne = await tools.run_command({ command: 'mvn -q -DskipTests compile' });
  assert.equal(compileOne.cached, undefined);
  const compileTwo = await tools.run_command({ command: 'mvn -q -DskipTests compile' });
  assert.equal(compileTwo.cached, true);
  assert.equal(commands.length, 3);

  resetCommandCache();
  const compileThree = await tools.run_command({ command: 'mvn -q -DskipTests compile' });
  assert.equal(compileThree.cached, undefined);
  assert.equal(commands.length, 4);

  await tools.run_command({ command: 'mvn test' });
  await tools.run_command({ command: 'mvn test' });
  assert.equal(commands.length, 6);
});

test('spills the full maven dependency list and pages it via query_result', async (t) => {
  const root = tempDir('maven-pagination-test');
  const runDir = path.join(root, 'run');
  await rm(root, { recursive: true, force: true });
  await mkdir(path.join(root, 'target'), { recursive: true });
  await mkdir(runDir, { recursive: true });
  await writeFile(path.join(root, 'pom.xml'), '<project/>\n');
  t.after(async () => { await rm(root, { recursive: true, force: true }); });

  const tree = ['com.example:demo:jar:1.0'];
  for (let index = 0; index < 60; index += 1) {
    tree.push(`+- org.foo:dep${index}:jar:1.0:compile`);
  }
  const runCommand = async ({ command }) => {
    if (command.includes('dependency:tree')) {
      await writeFile(path.join(root, 'target/dc-dependency-tree.txt'), tree.join('\n'));
    }
    return { ok: true, exitCode: 0, command, cwd: root, output: '' };
  };
  const scenario = parseScenario({
    name: 'maven-pagination',
    baseUrl: 'http://127.0.0.1:1',
    method: 'GET',
    path: '/',
    source: { root },
  });
  const { tools } = createTools({ scenario, anchor: Date.now(), runDir, runCommand, toolMode: 'sandbox' });

  const first = await tools.maven_dependencies({ limit: 10 });
  assert.equal(first.totalCount, 60);
  assert.equal(first.dependencies.length, 10);
  assert.equal(first.nextOffset, 10);
  assert.ok(first.file);

  const second = await tools.query_result({
    file: first.file,
    field: 'dependencies',
    offset: 50,
    limit: 20,
  });
  assert.equal(second.total, 60);
  assert.equal(second.items.length, 10);
  assert.equal(second.items[0].artifact, 'dep50');
});
