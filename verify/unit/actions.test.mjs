import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { actionTypeLabel, normalizeActionList } from '../../src/core/actions.mjs';
import { runCaptureDiagnosis } from '../../src/diagnose/run.mjs';
import { buildReport, renderMarkdown } from '../../src/report/report.mjs';
import { tempDir } from './tmp.mjs';

test('normalizes non-code actions, commands and verification', () => {
  const actions = normalizeActionList([{
    type: 'dependency',
    summary: '把 common-core.jar 加入部署 lib',
    reason: '运行实例 classpath 缺少依赖',
    requires: ['已停止旧实例'],
    steps: ['复制 jar 到 lib/', '重启应用'],
    commands: [
      'cp common-core.jar lib/',
      { label: '检查进程', command: 'jps -l', risk: 'low' },
    ],
    verification: { kind: 'symptom', description: '重新请求 /system/user/list', expected: 'code=200' },
    risk: 'medium',
    reversible: true,
    confirmationRequired: true,
    token: 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz',
  }]);
  assert.equal(actions.length, 1);
  assert.equal(actions[0].type, 'dependency');
  assert.equal(actions[0].commands.length, 2);
  assert.equal(actions[0].commands[1].label, '检查进程');
  assert.equal(actions[0].verification.kind, 'symptom');
  assert.equal(actionTypeLabel('dependency'), '依赖');
  assert.doesNotMatch(JSON.stringify(actions), /abcdefghijklmnopqrstuvwxyz/);
});

test('drops invalid/duplicate actions and caps the list', () => {
  const actions = normalizeActionList([
    { type: 'config', summary: 'same', steps: ['a'] },
    { type: 'config', summary: 'same', steps: ['b'] },
    { type: 'runtime', summary: 'no steps' },
    { type: 'build', summary: 'clean', steps: ['mvn clean'] },
    { type: 'data', summary: 'fix data', steps: ['update row'] },
    { type: 'deployment', summary: 'env', steps: ['set env'] },
    { type: 'environment', summary: 'path', steps: ['set path'] },
    { type: 'config', summary: 'sixth', steps: ['x'] },
  ]);
  assert.equal(actions.length, 5);
  assert.equal(actions[0].summary, 'same');
  assert.equal(actions.some((action) => action.summary === 'no steps'), false);
});

test('renderMarkdown shows non-code actions and the no-code note', () => {
  const markdown = renderMarkdown(buildReport({
    meta: { scenario: 's', question: 'q', durationMs: 1, runId: 'r', agent: 'claude', mode: 'live' },
    target: { driver: 'capture' },
    request: { url: 'http://localhost/api/x', method: 'GET' },
    response: { status: 500 },
    agent: {
      conclusion: '运行实例缺少依赖',
      actions: [{
        type: 'dependency',
        summary: '补 common-core.jar',
        reason: 'classpath 缺少依赖',
        requires: ['停止旧实例'],
        steps: ['复制 jar', '重启'],
        commands: [{ label: '检查', command: 'jps -l', risk: 'low' }],
        verification: { kind: 'symptom', description: '重新请求', expected: 'code=200' },
        risk: 'medium',
        reversible: true,
      }],
      fixes: [],
      needsMoreInfo: [],
    },
    gates: { checks: [], level: 'unverified' },
  }));
  assert.match(markdown, /## 非代码修复动作/);
  assert.match(markdown, /本次结论不需要修改代码/);
  assert.match(markdown, /补 common-core\.jar/);
  assert.match(markdown, /jps -l/);
  assert.match(markdown, /前置条件/);
});

test('carries actions through the diagnosis result and renders them', async (t) => {
  const dir = tempDir('actions-diagnosis-test');
  await mkdir(dir, { recursive: true });
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });
  const agent = {
    id: 'action-agent',
    async diagnose() {
      return {
        conclusion: '不是代码问题',
        evidenceRefs: [{ type: 'request', ref: 'request' }],
        confidence: 0.7,
        needsMoreInfo: [],
        fixes: [],
        actions: [{
          type: 'config',
          summary: '设置 SPRING_PROFILES_ACTIVE=prod',
          steps: ['在部署机设置环境变量', '重启应用'],
          verification: { kind: 'symptom', description: '重新请求' },
          risk: 'low',
        }],
      };
    },
  };
  const outcome = await runCaptureDiagnosis({
    request: { method: 'GET', url: 'http://localhost/api/x', headers: {}, startedAt: Date.now() },
    response: { status: 500, headers: {}, body: 'x', durationMs: 1 },
    firedAt: Date.now(),
  }, {
    workspace: { sourceRoot: dir, logfiles: [], window: { beforeMs: 1000, afterMs: 1000 } },
    root: dir,
    runsDir: path.join(dir, 'runs'),
    agent,
    preflight: { ok: true, checks: [], databases: [] },
  });
  assert.equal(outcome.result.agent.actions.length, 1);
  assert.equal(outcome.result.gates.remediation.actions, 1);
  assert.equal(outcome.result.meta.actionsCount, 1);
  assert.match(renderMarkdown(outcome.report), /非代码修复动作/);
});
