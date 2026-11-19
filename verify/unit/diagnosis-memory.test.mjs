import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, rm } from 'node:fs/promises';
import { tempDir } from './tmp.mjs';
import {
  buildMemoryCandidates,
  createDiagnosisMemoryStore,
  memoryPromptLines,
  projectIdentityForWorkspace,
  selectPromptNotes,
} from '../../src/core/diagnosis-memory.mjs';
import { buildPrompt, buildFollowUpPrompt } from '../../src/agent/claude.mjs';

const TMP = tempDir('diagnosis-memory-test');

async function fixture(t) {
  await rm(TMP, { recursive: true, force: true });
  const backend = path.join(TMP, 'backend');
  const frontend = path.join(TMP, 'frontend');
  await mkdir(backend, { recursive: true });
  await mkdir(frontend, { recursive: true });
  t.after(async () => { await rm(TMP, { recursive: true, force: true }); });
  return { backend, frontend, configDir: path.join(TMP, 'configs') };
}

test('derives a stable project key from repository roots', async (t) => {
  const { backend, frontend } = await fixture(t);
  const a = await projectIdentityForWorkspace({ sourceRoot: backend, frontendProjectRoot: frontend }, { root: TMP });
  const b = await projectIdentityForWorkspace({
    sourceRoot: path.relative(TMP, backend),
    frontendProjectRoot: path.relative(TMP, frontend),
  }, { root: TMP });
  const c = await projectIdentityForWorkspace({ sourceRoot: frontend }, { root: TMP });
  assert.equal(a.key, b.key);
  assert.notEqual(a.key, c.key);
  assert.equal(a.name, 'backend');
  assert.equal(await projectIdentityForWorkspace({}, { root: TMP }), null);
});

test('stores, pins, updates and deletes user notes', async (t) => {
  const { backend, configDir } = await fixture(t);
  const store = createDiagnosisMemoryStore({ configDir });
  const identity = await projectIdentityForWorkspace({ sourceRoot: backend }, { root: TMP });
  const withNote = await store.addNote(identity, { kind: 'environment', text: '部署环境 profile=prod' });
  assert.equal(withNote.notes.length, 1);
  const note = withNote.notes[0];
  const pinned = await store.updateNote(identity, note.id, { pinned: true });
  assert.equal(pinned.notes[0].pinned, true);
  const loaded = await store.getProject(identity);
  assert.equal(loaded.enabled, true);
  assert.equal(loaded.notes.length, 1);
  const removed = await store.deleteNote(identity, note.id);
  assert.equal(removed.notes.length, 0);
});

test('merges auto candidates, de-duplicates and replaces stale log format', async (t) => {
  const { backend, configDir } = await fixture(t);
  const store = createDiagnosisMemoryStore({ configDir });
  const identity = await projectIdentityForWorkspace({ sourceRoot: backend }, { root: TMP });
  await store.mergeCandidates(identity, [{ kind: 'log-format', source: 'tool', text: '日志格式：logback' }]);
  await store.mergeCandidates(identity, [{ kind: 'log-format', source: 'tool', text: '日志格式：json-lines' }]);
  let project = await store.getProject(identity);
  const logNotes = project.notes.filter((note) => note.kind === 'log-format');
  assert.equal(logNotes.length, 1);
  assert.match(logNotes[0].text, /json-lines/);

  const candidate = { kind: 'excluded-hypothesis', source: 'previous-run', text: '已排除：缓存未命中；理由：命中日志', runId: 'run-1' };
  await store.mergeCandidates(identity, [candidate]);
  await store.mergeCandidates(identity, [candidate]);
  project = await store.getProject(identity);
  const rejected = project.notes.find((note) => note.kind === 'excluded-hypothesis');
  assert.equal(rejected.seenCount, 2);
  assert.equal(rejected.runId, 'run-1');
});

test('selects prompts by pin/source/recency and labels sources', async (t) => {
  const { backend, configDir } = await fixture(t);
  const store = createDiagnosisMemoryStore({ configDir });
  const identity = await projectIdentityForWorkspace({ sourceRoot: backend }, { root: TMP });
  await store.mergeCandidates(identity, [
    { kind: 'log-format', source: 'tool', text: '日志格式：logback' },
    { kind: 'excluded-hypothesis', source: 'previous-run', text: '已排除：旧假设', runId: 'run-2' },
  ]);
  await store.addNote(identity, { kind: 'environment', text: '部署环境 profile=prod', pinned: true });
  const project = await store.getProject(identity);
  const selected = selectPromptNotes(project.notes);
  assert.equal(selected[0].pinned, true);
  const lines = memoryPromptLines(selected);
  assert.match(lines[0], /\[项目笔记 \|/);
  assert.ok(lines.some((line) => line.includes('[工具积累 |')));
  assert.ok(lines.some((line) => line.includes('[历史诊断 |')));

  const prompt = buildPrompt('下单失败', {
    symptom: { question: '下单失败' },
    triage: null,
    request: {}, response: {}, logs: { records: [] },
  }, { notes: selected });
  assert.match(prompt, /# 工具积累的项目前提/);
  assert.match(prompt, /# 诊断前确认（用户本次回答）/);
  assert.match(prompt, /不是当前证据/);
  assert.match(prompt, /部署环境 profile=prod/);
});

test('follow-up snapshot carries the injected memory', () => {
  const prompt = buildFollowUpPrompt('为什么排除了它？', {
    meta: { memory: { used: [{ kind: 'excluded-hypothesis', source: 'previous-run', text: '已排除：缓存未命中' }] } },
    agent: { conclusion: '库存不足' },
  });
  assert.match(prompt, /已排除：缓存未命中/);
});

test('builds only safe automatic candidates', () => {
  const complete = {
    logs: { parser: 'logback' },
    meta: { runId: 'run-1' },
    gates: { checks: [{ name: 'hypothesis-disclosure', ok: true }] },
    agent: { rejectedHypotheses: [{ hypothesis: '缓存未命中', reason: '日志显示命中' }] },
  };
  const candidates = buildMemoryCandidates(complete);
  assert.equal(candidates.length, 2);
  assert.equal(candidates[0].kind, 'log-format');
  assert.equal(candidates[1].source, 'previous-run');

  const incomplete = { ...complete, meta: { runId: 'run-2', incomplete: true } };
  assert.equal(buildMemoryCandidates(incomplete).length, 1);
});
