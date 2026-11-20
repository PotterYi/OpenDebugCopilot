import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  inspectBuildModel,
  resolveBuildProbeRoot,
} from '../../src/evidence/build-model.mjs';
import { createTools } from '../../src/tools/index.mjs';
import { parseScenario } from '../../src/core/scenario.mjs';
import { tempDir } from './tmp.mjs';

async function fixture(t) {
  const root = tempDir('build-model-test');
  await rm(root, { recursive: true, force: true });
  const project = path.join(root, 'project');
  const moduleA = path.join(project, 'module-a');
  const moduleB = path.join(project, 'module-b');
  await mkdir(path.join(project, '.idea'), { recursive: true });
  await mkdir(path.join(moduleA, 'src'), { recursive: true });
  await mkdir(moduleB, { recursive: true });
  await writeFile(path.join(project, 'pom.xml'), [
    '<project>',
    '  <groupId>com.demo</groupId>',
    '  <artifactId>demo-parent</artifactId>',
    '  <version>1.0</version>',
    '  <modules><module>module-a</module><module>module-b</module></modules>',
    '</project>',
  ].join('\n'));
  await writeFile(path.join(moduleA, 'pom.xml'), '<project><parent><groupId>com.demo</groupId><artifactId>demo-parent</artifactId><version>1.0</version></parent><artifactId>module-a</artifactId></project>');
  await writeFile(path.join(moduleB, 'pom.xml'), '<project><artifactId>module-b</artifactId></project>');
  await writeFile(path.join(project, '.idea/modules.xml'), [
    '<project version="4">',
    '  <component name="ProjectModuleManager"><modules>',
    '    <module fileurl="file://$PROJECT_DIR$/module-a/module-a.iml" filepath="$PROJECT_DIR$/module-a/module-a.iml" />',
    '  </modules></component>',
    '</project>',
  ].join('\n'));
  await writeFile(path.join(moduleA, 'module-a.iml'), [
    '<module type="JAVA_MODULE" version="4">',
    '  <component name="NewModuleRootManager">',
    '    <content url="file://$MODULE_DIR$"><sourceFolder url="file://$MODULE_DIR$/src" isTestSource="false" /></content>',
    '  </component>',
    '</module>',
  ].join('\n'));
  await writeFile(path.join(project, '.idea/workspace.xml'), '<project><component password="hunter2secret" /></project>');
  const old = new Date('2026-01-01T00:00:00Z');
  const now = new Date('2026-06-01T00:00:00Z');
  await utimes(path.join(project, '.idea/modules.xml'), old, old);
  await utimes(path.join(project, 'pom.xml'), now, now);
  await utimes(path.join(moduleA, 'pom.xml'), now, now);
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  return { root, project, moduleA };
}

test('inspects Maven and IntelliJ model with stale hints', async (t) => {
  const { project, moduleA } = await fixture(t);
  const model = await inspectBuildModel({ sourceRoot: moduleA, probeRoot: project });
  assert.equal(model.sourceRoot, 'module-a');
  assert.equal(model.probeRoot, '.');
  assert.ok(model.poms.some((pom) => pom.path === 'pom.xml' && pom.modules.includes('module-b')));
  assert.equal(model.ide.type, 'intellij');
  assert.equal(model.ide.modules[0].name, 'module-a');
  assert.deepEqual(model.ide.modules[0].sourceFolders, ['module-a/src']);
  assert.ok(model.staleHints.some((hint) => hint.kind === 'pom-module-missing-in-ide' && hint.detail === 'module-b'));
  assert.ok(model.staleHints.some((hint) => hint.kind === 'ide-older-than-pom'));
  assert.doesNotMatch(JSON.stringify(model), /hunter2secret/);
  assert.doesNotMatch(JSON.stringify(model), /hunter2secret|password=/);
});

test('defaults the probe root to the source root parent', () => {
  const source = 'G:/work/project/module-a';
  assert.equal(resolveBuildProbeRoot({ sourceRoot: source }), path.dirname(path.resolve(source)));
  assert.equal(
    resolveBuildProbeRoot({ sourceRoot: source, configured: 'G:/work', root: 'G:/ignored' }),
    path.resolve('G:/work'),
  );
});

test('rejects a probe root that does not contain the source root', async (t) => {
  const { project, moduleA } = await fixture(t);
  await assert.rejects(
    inspectBuildModel({ sourceRoot: moduleA, probeRoot: path.join(project, 'module-b') }),
    (error) => error.code === 'BUILD_PROBE_ROOT_INVALID',
  );
});

test('exposes inspect_build_model through the tool registry', async (t) => {
  const { moduleA, project } = await fixture(t);
  const scenario = parseScenario({
    name: 'build-model',
    baseUrl: 'http://127.0.0.1:1',
    method: 'GET',
    path: '/',
    source: { root: moduleA },
  });
  const runDir = path.join(project, 'run');
  await mkdir(runDir, { recursive: true });
  const { tools } = createTools({ scenario, anchor: Date.now(), runDir });
  const model = await tools.inspect_build_model({});
  assert.equal(model.sourceRoot, 'module-a');
  assert.ok(model.poms.length >= 1);
  assert.equal(model.ide.modules[0].name, 'module-a');
});

test('parses Gradle modules and compares them with IDE modules', async (t) => {
  const root = tempDir('build-model-gradle');
  const project = path.join(root, 'gradle-project');
  await rm(root, { recursive: true, force: true });
  await mkdir(path.join(project, '.idea'), { recursive: true });
  await mkdir(path.join(project, 'app'), { recursive: true });
  await mkdir(path.join(project, 'lib'), { recursive: true });
  await writeFile(path.join(project, 'settings.gradle'), "include ':app', ':lib'\n");
  await writeFile(path.join(project, 'build.gradle'), 'plugins { id "java" }\n');
  await writeFile(path.join(project, '.idea/modules.xml'), [
    '<project version="4"><component name="ProjectModuleManager"><modules>',
    '  <module fileurl="file://$PROJECT_DIR$/app/app.iml" filepath="$PROJECT_DIR$/app/app.iml" />',
    '</modules></component></project>',
  ].join('\n'));
  const old = new Date('2026-01-01T00:00:00Z');
  const now = new Date('2026-06-01T00:00:00Z');
  await utimes(path.join(project, '.idea/modules.xml'), old, old);
  await utimes(path.join(project, 'settings.gradle'), now, now);
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const model = await inspectBuildModel({ sourceRoot: project, probeRoot: project, mode: 'backend' });
  assert.equal(model.buildSystem, 'gradle');
  assert.deepEqual(model.gradle.modules.sort(), ['app', 'lib']);
  assert.ok(model.staleHints.some((hint) => hint.kind === 'ide-older-than-gradle'));
  assert.ok(model.staleHints.some((hint) => hint.kind === 'gradle-module-missing-in-ide' && hint.detail === 'lib'));
});

test('detects frontend lock/node_modules staleness', async (t) => {
  const root = tempDir('build-model-frontend');
  const project = path.join(root, 'frontend');
  await rm(root, { recursive: true, force: true });
  await mkdir(path.join(project, 'node_modules'), { recursive: true });
  await writeFile(path.join(project, 'package.json'), JSON.stringify({ name: 'demo', dependencies: { vue: '^3' } }));
  await writeFile(path.join(project, 'package-lock.json'), '{}');
  await writeFile(path.join(project, 'node_modules/.package-lock.json'), '{}');
  const old = new Date('2026-01-01T00:00:00Z');
  const mid = new Date('2026-03-01T00:00:00Z');
  const now = new Date('2026-06-01T00:00:00Z');
  await utimes(path.join(project, 'node_modules/.package-lock.json'), old, old);
  await utimes(path.join(project, 'package-lock.json'), mid, mid);
  await utimes(path.join(project, 'package.json'), now, now);
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const model = await inspectBuildModel({ sourceRoot: project, probeRoot: project, mode: 'frontend' });
  assert.equal(model.buildSystem, 'frontend');
  assert.equal(model.frontend.dependencyCount, 1);
  assert.ok(model.frontend.staleHints.some((hint) => hint.kind === 'package-json-newer-than-lock'));
  assert.ok(model.frontend.staleHints.some((hint) => hint.kind === 'lockfile-newer-than-node-modules'));
});
