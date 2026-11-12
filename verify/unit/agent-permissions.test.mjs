import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import {
  READ_ONLY_BUILTIN_TOOLS,
  createReadOnlyToolPermission,
  createToolPermission,
} from '../../src/agent/claude.mjs';
import { tempDir } from './tmp.mjs';

const TMP = tempDir('agent-permissions-test');

async function fixture(t) {
  await rm(TMP, { recursive: true, force: true });
  const root = path.join(TMP, 'project');
  const outside = path.join(TMP, 'outside');
  await mkdir(path.join(root, 'src'), { recursive: true });
  await mkdir(path.join(root, '.git'), { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(path.join(root, 'src', 'app.js'), 'export const value = 1;\n', 'utf8');
  await writeFile(path.join(root, '.env'), 'SECRET=1\n', 'utf8');
  await writeFile(path.join(root, '.git', 'config'), '[core]\n', 'utf8');
  await writeFile(path.join(outside, 'secret.txt'), 'nope\n', 'utf8');
  t.after(async () => { await rm(TMP, { recursive: true, force: true }); });
  return { root, outside };
}

test('exposes only the read-only built-in tools by default', () => {
  assert.deepEqual([...READ_ONLY_BUILTIN_TOOLS], ['Read', 'Grep', 'Glob']);
});

test('allows read-only tools inside authorized roots', async (t) => {
  const { root } = await fixture(t);
  const canUseTool = createReadOnlyToolPermission([root], { cwd: root });
  const allow = (toolName, input) => canUseTool(toolName, input).then((result) => result.behavior);

  assert.equal(await allow('Read', { file_path: path.join(root, 'src', 'app.js') }), 'allow');
  assert.equal(await allow('Grep', { pattern: 'value', path: path.join(root, 'src') }), 'allow');
  assert.equal(await allow('Glob', { pattern: 'src/**/*.js', path: root }), 'allow');
  assert.equal(await allow('mcp__debugcopilot__get_logs', {}), 'allow');
});

test('denies paths outside the roots and sensitive files', async (t) => {
  const { root, outside } = await fixture(t);
  const canUseTool = createReadOnlyToolPermission([root], { cwd: root });
  const deny = (toolName, input) => canUseTool(toolName, input).then((result) => result.behavior);

  assert.equal(await deny('Read', { file_path: path.join(outside, 'secret.txt') }), 'deny');
  assert.equal(await deny('Read', { file_path: path.join(root, '.env') }), 'deny');
  assert.equal(await deny('Read', { file_path: path.join(root, '.git', 'config') }), 'deny');
  assert.equal(await deny('Grep', { pattern: 'secret', path: outside }), 'deny');
  assert.equal(await deny('Glob', { pattern: '../**/*.js', path: root }), 'deny');
});

test('denies every non-read-only built-in tool', async (t) => {
  const { root } = await fixture(t);
  const canUseTool = createReadOnlyToolPermission([root], { cwd: root });
  for (const name of ['Bash', 'Edit', 'Write', 'NotebookEdit', 'WebFetch']) {
    assert.equal((await canUseTool(name, {})).behavior, 'deny', name);
  }
});

test('sandbox mode allows Edit/Write only inside authorized roots', async (t) => {
  const { root, outside } = await fixture(t);
  const canUseTool = createToolPermission([root], { cwd: root, allowWrite: true });
  const behavior = (toolName, input) => canUseTool(toolName, input).then((result) => result.behavior);

  assert.equal(await behavior('Write', { file_path: path.join(root, 'src', 'new.js'), content: 'x' }), 'allow');
  assert.equal(await behavior('Edit', { file_path: path.join(root, 'src', 'app.js') }), 'allow');
  assert.equal(await behavior('Write', { file_path: path.join(outside, 'new.js'), content: 'x' }), 'deny');
  assert.equal(await behavior('Edit', { file_path: path.join(root, '.env') }), 'deny');
  assert.equal(await behavior('Bash', { command: 'ls' }), 'deny');
});

test('full mode runs Edit/Write and safe Bash without per-action approval', async (t) => {
  const { root, outside } = await fixture(t);
  let approvalCalls = 0;
  const canUseTool = createToolPermission([root], {
    cwd: root,
    allowWrite: true,
    allowBash: true,
    // A callback may still be passed, but full mode does not require approval.
    approve: async () => { approvalCalls += 1; return true; },
  });
  const behavior = (toolName, input) => canUseTool(toolName, input).then((result) => result.behavior);

  assert.equal(await behavior('Bash', { command: 'mvn test' }), 'allow');
  assert.equal(await behavior('Edit', { file_path: path.join(root, 'src', 'app.js') }), 'allow');
  assert.equal(await behavior('Write', { file_path: path.join(root, 'src', 'new.js'), content: 'x' }), 'allow');
  assert.equal(approvalCalls, 0);
  // Risky Bash is denied when no dangerous-action approver is configured.
  assert.equal(await behavior('Bash', { command: 'cat /etc/passwd' }), 'deny');
  assert.equal(await behavior('Write', { file_path: path.join(outside, 'new.js') }), 'deny');
});

test('full mode asks the Bash approver for risky commands only', async (t) => {
  const { root } = await fixture(t);
  const calls = [];
  const canUseTool = createToolPermission([root], {
    cwd: root,
    allowWrite: true,
    allowBash: true,
    bashApproval: async ({ command, safe }) => {
      calls.push({ command, safe });
      return safe || command === './deploy.sh';
    },
  });
  assert.equal((await canUseTool('Bash', { command: 'npm run build' })).behavior, 'allow');
  assert.equal((await canUseTool('Bash', { command: 'rm -rf .' })).behavior, 'deny');
  assert.equal((await canUseTool('Bash', { command: './deploy.sh' })).behavior, 'allow');
  assert.deepEqual(calls, [
    { command: 'npm run build', safe: true },
    { command: 'rm -rf .', safe: false },
    { command: './deploy.sh', safe: false },
  ]);
});

test('requireApproval can still gate Edit/Write/Bash explicitly', async (t) => {
  const { root } = await fixture(t);
  const canUseTool = createToolPermission([root], {
    cwd: root,
    allowWrite: true,
    allowBash: true,
    approve: async () => false,
    requireApproval: true,
  });
  assert.equal((await canUseTool('Bash', { command: 'mvn test' })).behavior, 'deny');
  assert.equal((await canUseTool('Edit', { file_path: path.join(root, 'src', 'app.js') })).behavior, 'deny');
  assert.equal((await canUseTool('Write', { file_path: path.join(root, 'src', 'new.js'), content: 'x' })).behavior, 'deny');
});

test('in-place write roots exclude extra roots and build directories', async (t) => {
  const { root, outside } = await fixture(t);
  const extra = path.join(TMP, 'extra-backend');
  await mkdir(path.join(extra), { recursive: true });
  await mkdir(path.join(root, 'target'), { recursive: true });
  const snapshots = [];
  const canUseTool = createToolPermission([root, extra], {
    cwd: root,
    allowWrite: true,
    writeRoots: [root],
    onBeforeWrite: async (input) => { snapshots.push(input.filePath); },
  });
  const behavior = (toolName, input) => canUseTool(toolName, input).then((result) => result.behavior);

  assert.equal(await behavior('Write', { file_path: path.join(root, 'src', 'ok.js'), content: 'x' }), 'allow');
  assert.deepEqual(snapshots, [path.join(root, 'src', 'ok.js')]);
  assert.equal(await behavior('Write', { file_path: path.join(extra, 'x.js'), content: 'x' }), 'deny');
  assert.equal(await behavior('Edit', { file_path: path.join(root, 'target', 'x.js') }), 'deny');
});
