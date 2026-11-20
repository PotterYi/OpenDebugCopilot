import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  applySymptomToGates,
  buildSymptomCheck,
  verificationLevel,
} from '../../src/core/symptom.mjs';
import { createService } from '../../src/app/service.mjs';
import { tempDir } from './tmp.mjs';

test('builds manual symptom steps for requests and elements', () => {
  const request = buildSymptomCheck({
    fired: {
      request: { method: 'GET', url: 'http://127.0.0.1:8080/system/user/list?pageNum=1' },
      response: { status: 500 },
    },
  });
  assert.equal(request.status, 'pending');
  assert.match(request.steps[0], /GET \/system\/user\/list\?pageNum=1/);
  assert.match(request.expected, /原始症状不再出现/);

  const element = buildSymptomCheck({
    element: { selector: '#app', page: { url: 'http://localhost:5173/page' } },
  });
  assert.match(element.steps[1], /#app/);
});

test('maps build and symptom status to a three-state verification level', () => {
  assert.equal(verificationLevel({ verification: { status: 'failed' }, symptomCheck: { status: 'passed' } }), 'failed');
  assert.equal(verificationLevel({ verification: { status: 'passed' }, symptomCheck: { status: 'pending' } }), 'unverified');
  assert.equal(verificationLevel({ verification: { status: 'skipped' }, symptomCheck: { status: 'passed' } }), 'symptom-verified');

  const gates = applySymptomToGates(
    { ok: true, checks: [] },
    { status: 'pending', method: 'manual' },
    { status: 'passed' },
  );
  assert.equal(gates.level, 'unverified');
  assert.equal(gates.symptom.status, 'pending');
});

test('persists a manual symptom confirmation to result.json and report.md', async (t) => {
  const root = tempDir('symptom-service-test');
  const runs = path.join(root, 'runs');
  const runId = '20260101-000000-abcdef';
  const runDir = path.join(runs, runId);
  await rm(root, { recursive: true, force: true });
  await mkdir(runDir, { recursive: true });
  await writeFile(path.join(runDir, 'result.json'), JSON.stringify({
    meta: { runId, question: '下单失败', symptomStatus: 'pending' },
    agent: { conclusion: 'ok', verification: { status: 'passed', mode: 'copy' } },
    gates: { ok: true, checks: [] },
    symptomCheck: { status: 'pending', method: 'manual', steps: ['复现请求'], expected: '正常' },
  }));
  await writeFile(path.join(runDir, 'report.md'), '# old\n');
  t.after(async () => { await rm(root, { recursive: true, force: true }); });

  const service = createService({ root, runsDir: runs, configDir: path.join(root, 'configs') });
  const updated = await service.updateRunSymptom(runId, { status: 'passed', note: '已复查' });
  assert.equal(updated.result.symptomCheck.status, 'passed');
  assert.equal(updated.result.meta.verificationLevel, 'verified');
  assert.equal(updated.result.gates.level, 'verified');
  const persisted = JSON.parse(await readFile(path.join(runDir, 'result.json'), 'utf8'));
  assert.equal(persisted.symptomCheck.status, 'passed');
  assert.equal(persisted.symptomCheck.note, '已复查');
  const report = await readFile(path.join(runDir, 'report.md'), 'utf8');
  assert.match(report, /## 症状验证/);
  assert.match(report, /已确认症状消失/);
  assert.match(report, /已验证（构建自检通过 \+ 症状确认）/);
});

test('persists an element recheck with before/after evidence', async (t) => {
  const root = tempDir('symptom-element-recheck-test');
  const runs = path.join(root, 'runs');
  const runId = '20260101-000000-element';
  const runDir = path.join(runs, runId);
  await rm(root, { recursive: true, force: true });
  await mkdir(runDir, { recursive: true });
  await writeFile(path.join(runDir, 'result.json'), JSON.stringify({
    meta: { runId, question: '元素错位', symptomStatus: 'pending' },
    agent: { conclusion: 'ok', verification: { status: 'passed', mode: 'copy' } },
    gates: { ok: true, checks: [] },
    element: { selector: '#app', page: { url: 'http://localhost:5173/page' } },
    symptomCheck: { status: 'pending', method: 'manual', steps: ['打开页面'], expected: '正常' },
  }));
  await writeFile(path.join(runDir, 'report.md'), '# old\n');
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const service = createService({ root, runsDir: runs, configDir: path.join(root, 'configs') });
  const updated = await service.updateRunSymptomCheck(runId, {
    status: 'pending',
    method: 'element-recheck',
    observed: '重新渲染后检测到 2 项变化',
    reason: 'element-changed-needs-review',
    evidence: {
      beforeScreenshot: 'evidence/element.png',
      afterScreenshot: 'evidence/element-recheck-after.png',
      json: 'evidence/element-recheck.json',
    },
    checkedAt: new Date().toISOString(),
  });
  assert.equal(updated.result.symptomCheck.method, 'element-recheck');
  assert.equal(updated.result.symptomCheck.evidence.afterScreenshot, 'evidence/element-recheck-after.png');
  assert.equal(updated.result.meta.verificationLevel, 'unverified');
  const report = await readFile(path.join(runDir, 'report.md'), 'utf8');
  assert.match(report, /浏览器元素复检/);
  assert.match(report, /element-recheck-after\.png/);
});
