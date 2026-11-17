import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TRIAGE_FIELDS,
  TRIAGE_OPTIONS,
  normalizeTriage,
  triagePromptLines,
  triageSummary,
} from '../../src/core/triage.mjs';
import {
  TRIAGE_FIELDS as UI_FIELDS,
  TRIAGE_OPTIONS as UI_OPTIONS,
} from '../../src/ui/triage-options.mjs';

test('core and UI triage options stay in sync', () => {
  assert.deepEqual(UI_FIELDS, TRIAGE_FIELDS);
  assert.deepEqual(UI_OPTIONS, TRIAGE_OPTIONS);
});

test('normalizes answers, labels and notes without accepting unknown keys', () => {
  const triage = normalizeTriage({
    answers: {
      environment: 'deploy-only',
      scope: 'endpoint',
      change: 'dependency',
      injected: 'ignore me',
    },
    note: '升级 Spring Boot 后出现',
    askedAt: '2026-11-14T10:00:00.000Z',
  });
  assert.deepEqual(triage.answers, {
    environment: 'deploy-only',
    scope: 'endpoint',
    change: 'dependency',
  });
  assert.equal(triage.labels.environment, '仅部署环境复现');
  assert.equal(triage.labels.scope, '仅当前接口/页面');
  assert.equal(triage.labels.change, '依赖或版本升级');
  assert.equal(triage.note, '升级 Spring Boot 后出现');
  assert.equal(triage.skipped, false);
  assert.equal(triage.askedAt, '2026-11-14T10:00:00.000Z');
  assert.equal(triage.answers.injected, undefined);
});

test('drops invalid values, supports skipped and bounds the note', () => {
  assert.equal(normalizeTriage(null), null);
  assert.equal(normalizeTriage({}), null);
  const skipped = normalizeTriage({ skipped: true });
  assert.equal(skipped.skipped, true);
  assert.deepEqual(skipped.answers, {});

  const invalid = normalizeTriage({ answers: { environment: 'prod', scope: 'endpoint' } });
  assert.equal(invalid.answers.environment, undefined);
  assert.equal(invalid.answers.scope, 'endpoint');

  const longNote = normalizeTriage({ skipped: true, note: 'x'.repeat(400) });
  assert.equal(longNote.note.length, 300);
});

test('renders prompt lines and a report summary', () => {
  const triage = normalizeTriage({
    answers: { environment: 'deploy-only', scope: 'endpoint', change: 'dependency' },
    note: '升级后出现',
  });
  const lines = triagePromptLines(triage);
  assert.ok(lines.includes('- 复现环境：仅部署环境复现'));
  assert.ok(lines.includes('- 影响范围：仅当前接口/页面'));
  assert.ok(lines.includes('- 最近变更：依赖或版本升级'));
  assert.ok(lines.includes('- 备注：升级后出现'));
  assert.match(triageSummary(triage), /仅部署环境复现/);

  assert.deepEqual(triagePromptLines(null), ['（未提供；诊断前未收集）']);
  assert.deepEqual(triagePromptLines({ skipped: true }), ['（用户跳过诊断前确认）']);
  assert.match(triageSummary(null), /已跳过/);
});
