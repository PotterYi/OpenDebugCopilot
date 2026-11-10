import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import {
  cleanupAgentSandbox,
  createAgentSandbox,
  createSandboxCommandRunner,
  extractSandboxFixes,
} from '../../src/core/agent-sandbox.mjs';
import { runCaptureDiagnosis } from '../../src/diagnose/run.mjs';
import { tempDir } from './tmp.mjs';

const TMP = tempDir('agent-sandbox-test');

async function fixture(t) {
  await rm(TMP, { recursive: true, force: true });
  const root = path.join(TMP, 'project');
  const runDir = path.join(TMP, 'run');
  await mkdir(path.join(root, 'src'), { recursive: true });
  await mkdir(path.join(root, 'target'), { recursive: true });
  await mkdir(runDir, { recursive: true });
  await writeFile(path.join(root, 'src', 'app.js'), 'export const value = 1;\n', 'utf8');
  await writeFile(path.join(root, 'target', 'ignored.class'), 'ignored\n', 'utf8');
  t.after(async () => { await rm(TMP, { recursive: true, force: true }); });
  return { root, runDir };
}

test('copies source roots to a sandbox and extracts whole-file fixes', async (t) => {
  const { root, runDir } = await fixture(t);
  const sandbox = await createAgentSandbox({
    runDir,
    roots: [{ key: 'backend', name: 'backend', root }],
  });
  const sandboxFile = path.join(sandbox.roots[0].sandboxRoot, 'src', 'app.js');
  assert.equal(await readFile(sandboxFile, 'utf8'), 'export const value = 1;\n');
  await assert.rejects(access(path.join(sandbox.roots[0].sandboxRoot, 'target', 'ignored.class')));

  await writeFile(sandboxFile, 'export const value = 2;\n', 'utf8');
  const extracted = await extractSandboxFixes(sandbox);
  assert.equal(extracted.fixes.length, 1);
  assert.equal(extracted.fixes[0].root, 'backend');
  assert.equal(extracted.fixes[0].file, 'src/app.js');
  assert.equal(extracted.fixes[0].search, 'export const value = 1;\n');
  assert.equal(extracted.fixes[0].replace, 'export const value = 2;\n');
  assert.equal(await readFile(path.join(root, 'src', 'app.js'), 'utf8'), 'export const value = 1;\n');
  await cleanupAgentSandbox(sandbox);
  await assert.rejects(access(sandbox.dir));
});

test('run_command allows build/test tooling and rejects shell escapes', async (t) => {
  const { root, runDir } = await fixture(t);
  await writeFile(path.join(root, 'package.json'), JSON.stringify({
    scripts: { build: 'node build.mjs' },
  }), 'utf8');
  await writeFile(path.join(root, 'build.mjs'), 'console.log("build ok");\n', 'utf8');
  const sandbox = await createAgentSandbox({
    runDir,
    roots: [{ key: 'backend', name: 'backend', root }],
  });
  const runCommand = createSandboxCommandRunner({
    sandbox,
    verifyCommand: 'npm run build',
  });

  const ok = await runCommand({ command: 'npm run build' });
  assert.equal(ok.ok, true, ok.output);
  assert.match(ok.output, /build ok/);

  await assert.rejects(
    runCommand({ command: 'npm install' }),
    (error) => error?.code === 'COMMAND_DENIED',
  );
  await assert.rejects(
    runCommand({ command: 'npm run build && echo hacked' }),
    (error) => error?.code === 'COMMAND_DENIED',
  );
  await assert.rejects(
    runCommand({ command: 'echo hi' }),
    (error) => error?.code === 'COMMAND_DENIED',
  );
  await assert.rejects(
    runCommand({ command: 'npm run build', cwd: '../' }),
    (error) => error?.code === 'COMMAND_CWD_DENIED',
  );
  await cleanupAgentSandbox(sandbox);
});

test('diagnosis edits a sandbox, runs a tool command, and extracts fixes', async (t) => {
  await rm(TMP, { recursive: true, force: true });
  const root = path.join(TMP, 'backend');
  const file = path.join(root, 'com/demo/OrderService.java');
  const original = [
    'package com.demo;',
    '',
    'public class OrderService {',
    '    public void create(Order order) {',
    '        if (order.getQty() <= 0) {',
    '            throw new IllegalArgumentException("qty must be positive");',
    '        }',
    '    }',
    '}',
    '',
  ].join('\n');
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, original, 'utf8');
  t.after(async () => { await rm(TMP, { recursive: true, force: true }); });

  const verifyCommand = 'node -e "process.exit(0)"';
  const agent = {
    id: 'sandbox-agent',
    scope: null,
    configureScope(next) { this.scope = next; },
    async diagnose({ tools }) {
      assert.equal(tools.specs.some((spec) => spec.name === 'run_command'), true);
      const ran = await tools.tools.run_command({ command: verifyCommand });
      assert.equal(ran.ok, true, JSON.stringify(ran));
      const target = path.join(this.scope.allowedRoots[0], 'com/demo/OrderService.java');
      const text = await readFile(target, 'utf8');
      await this.scope.onBeforeWrite({ filePath: target });
      await writeFile(target, text.replace(
        '            throw new IllegalArgumentException',
        '            // sandbox fix\n            throw new IllegalArgumentException',
      ), 'utf8');
      await this.scope.onAfterWrite({ filePath: target });
      return {
        conclusion: '沙箱中已修复并验证',
        evidenceRefs: [{ type: 'request', ref: 'request' }],
        confidence: 0.9,
        needsMoreInfo: [],
        fixes: [],
      };
    },
  };

  const outcome = await runCaptureDiagnosis({
    request: { method: 'POST', url: 'http://localhost/api/order', headers: {}, body: '{}', startedAt: Date.now() },
    response: { status: 500, statusText: 'Error', ok: false, headers: {}, body: '{}', durationMs: 1 },
    firedAt: Date.now(),
  }, {
    workspace: { sourceRoot: root, logfiles: [], window: { beforeMs: 1000, afterMs: 1000 }, agent: { sandbox: true } },
    root: TMP,
    runsDir: path.join(TMP, 'runs'),
    agent,
    verifyCommand,
    sandbox: true,
  });
  const { result, runDir } = outcome;

  assert.equal(result.agent.fixes.length, 1);
  assert.equal(result.agent.fixes[0].preview.status, 'ready');
  assert.match(result.agent.fixes[0].replace, /sandbox fix/);
  assert.ok(outcome.workspaceSession, 'expected an in-place workspace session');
  assert.equal(result.agent.workspaceSession.status, 'pending');
  await outcome.workspaceSession.discard();
  assert.equal(await readFile(file, 'utf8'), original);
  await assert.rejects(access(path.join(runDir, 'sandbox')));
});

test('extracts newly created and deleted files with base hashes', async (t) => {
  const { root, runDir } = await fixture(t);
  const sandbox = await createAgentSandbox({
    runDir,
    roots: [{ key: 'backend', name: 'backend', root }],
  });
  const sandboxRoot = sandbox.roots[0].sandboxRoot;
  await writeFile(path.join(sandboxRoot, 'src', 'created.js'), 'export const created = true;\n', 'utf8');
  await rm(path.join(sandboxRoot, 'src', 'app.js'));

  const extracted = await extractSandboxFixes(sandbox);
  const create = extracted.fixes.find((fix) => fix.kind === 'create');
  const remove = extracted.fixes.find((fix) => fix.kind === 'delete');
  assert.equal(create.file, 'src/created.js');
  assert.equal(create.content, 'export const created = true;\n');
  assert.equal(remove.file, 'src/app.js');
  assert.match(remove.baseHash, /^[a-f0-9]{64}$/);
  assert.equal(await readFile(path.join(root, 'src', 'app.js'), 'utf8'), 'export const value = 1;\n');
  await cleanupAgentSandbox(sandbox);
});
