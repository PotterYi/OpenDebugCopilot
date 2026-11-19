import { createHash } from 'node:crypto';
import { mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { redactSecrets } from './redact.mjs';

export const MEMORY_FILE = 'diagnosis-memory.json';
export const MEMORY_VERSION = 1;
export const MEMORY_KINDS = Object.freeze(['log-format', 'environment', 'excluded-hypothesis', 'general']);
export const MEMORY_SOURCES = Object.freeze(['user', 'tool', 'previous-run']);
export const MAX_NOTE_CHARS = 300;
export const MAX_PROJECT_NOTES = 100;
export const MAX_AUTO_NOTES = 30;
export const MAX_PROMPT_NOTES = 20;
export const MAX_PROMPT_CHARS = 4096;

const SOURCE_LABELS = { user: '项目笔记', tool: '工具积累', 'previous-run': '历史诊断' };
const SOURCE_PRIORITY = { user: 0, tool: 1, 'previous-run': 2 };
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function cleanText(value, max = MAX_NOTE_CHARS) {
  return redactSecrets(String(value ?? '')).replace(/\s+/g, ' ').trim().slice(0, max);
}

function timestamp(value, fallback) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return fallback;
}

function newId(prefix = 'mem') {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function normalizeMemoryNote(input, { now = Date.now(), source = null } = {}) {
  if (!isObject(input)) return null;
  const text = cleanText(input.text);
  if (!text) return null;
  const kind = MEMORY_KINDS.includes(input.kind) ? input.kind : 'general';
  const noteSource = MEMORY_SOURCES.includes(source) ? source
    : MEMORY_SOURCES.includes(input.source) ? input.source : 'user';
  return {
    id: cleanText(input.id, 80) || newId(),
    kind,
    source: noteSource,
    text,
    runId: input.runId ? cleanText(input.runId, 80) : null,
    tags: Array.isArray(input.tags)
      ? input.tags.map((tag) => cleanText(tag, 40)).filter(Boolean).slice(0, 8)
      : [],
    pinned: input.pinned === true,
    seenCount: Math.max(1, Math.floor(Number(input.seenCount) || 1)),
    createdAt: timestamp(input.createdAt, now),
    lastSeenAt: timestamp(input.lastSeenAt, timestamp(input.createdAt, now)),
  };
}

function dedupeNotes(notes) {
  const byId = new Map();
  const byText = new Map();
  for (const note of notes) {
    const key = `${note.kind}\0${note.text.toLowerCase()}`;
    if (byId.has(note.id) || byText.has(key)) continue;
    byId.set(note.id, note);
    byText.set(key, note);
  }
  return [...byId.values()].slice(0, MAX_PROJECT_NOTES);
}

export function normalizeMemoryState(value) {
  const projects = {};
  const rawProjects = isObject(value?.projects) ? value.projects : {};
  for (const [key, project] of Object.entries(rawProjects)) {
    if (!isObject(project) || !key.startsWith('m-')) continue;
    const notes = (Array.isArray(project.notes) ? project.notes : [])
      .map((note) => normalizeMemoryNote(note))
      .filter(Boolean);
    projects[key] = {
      key,
      name: cleanText(project.name, 120) || 'project',
      roots: isObject(project.roots) ? {
        sourceRoot: project.roots.sourceRoot ? String(project.roots.sourceRoot) : null,
        frontendProjectRoot: project.roots.frontendProjectRoot ? String(project.roots.frontendProjectRoot) : null,
        extraSourceRoots: Array.isArray(project.roots.extraSourceRoots)
          ? project.roots.extraSourceRoots.map(String)
          : [],
      } : { sourceRoot: null, frontendProjectRoot: null, extraSourceRoots: [] },
      notes: dedupeNotes(notes),
      createdAt: timestamp(project.createdAt, Date.now()),
      updatedAt: timestamp(project.updatedAt, timestamp(project.createdAt, Date.now())),
    };
  }
  return { version: MEMORY_VERSION, projects };
}

async function realOrResolved(target) {
  return realpath(target).catch(() => path.resolve(target));
}

/**
 * Project identity is derived from the actual repository roots, not from the
 * workspace profile name, so the same repos share memory across profiles while
 * different projects stay separate.
 */
export async function projectIdentityForWorkspace(workspace = {}, { root = process.cwd() } = {}) {
  const sourceRoot = workspace.sourceRoot ? path.resolve(root, workspace.sourceRoot) : null;
  const frontendProjectRoot = (workspace.frontendProjectRoot || workspace.frontendSourceRoot)
    ? path.resolve(root, workspace.frontendProjectRoot || workspace.frontendSourceRoot)
    : null;
  const extraRoots = (workspace.extraSourceRoots ?? [])
    .filter(Boolean)
    .map((item) => path.resolve(root, item))
    .sort();
  if (!sourceRoot && !frontendProjectRoot && extraRoots.length === 0) return null;
  const [realSource, realFrontend, ...realExtra] = await Promise.all([
    sourceRoot ? realOrResolved(sourceRoot) : Promise.resolve(null),
    frontendProjectRoot ? realOrResolved(frontendProjectRoot) : Promise.resolve(null),
    ...extraRoots.map((item) => realOrResolved(item)),
  ]);
  const parts = [realSource, realFrontend, ...realExtra].filter(Boolean)
    .map((item) => (process.platform === 'win32' ? item.toLowerCase() : item));
  if (parts.length === 0) return null;
  const key = `m-${createHash('sha1').update(parts.join('\0')).digest('hex').slice(0, 16)}`;
  const primary = realSource || realFrontend || realExtra[0];
  return {
    key,
    name: path.basename(primary) || 'project',
    roots: {
      sourceRoot: realSource,
      frontendProjectRoot: realFrontend,
      extraSourceRoots: realExtra,
    },
  };
}

function noteSort(a, b) {
  if (Boolean(a.pinned) !== Boolean(b.pinned)) return a.pinned ? -1 : 1;
  const sourceDiff = (SOURCE_PRIORITY[a.source] ?? 9) - (SOURCE_PRIORITY[b.source] ?? 9);
  if (sourceDiff !== 0) return sourceDiff;
  return (b.lastSeenAt ?? 0) - (a.lastSeenAt ?? 0);
}

/** Pick a small, deterministic memory set for one prompt. */
export function selectPromptNotes(notes = []) {
  const ordered = (Array.isArray(notes) ? notes : []).filter((note) => note?.text).slice().sort(noteSort);
  const selected = [];
  let chars = 0;
  for (const note of ordered) {
    if (selected.length >= MAX_PROMPT_NOTES) break;
    const estimate = note.text.length + 80;
    if (chars + estimate > MAX_PROMPT_CHARS) continue;
    selected.push(note);
    chars += estimate;
  }
  return selected;
}

export function memoryPromptLines(notes = []) {
  return notes.map((note) => {
    const date = new Date(note.lastSeenAt ?? note.createdAt ?? Date.now()).toISOString().slice(0, 10);
    const source = SOURCE_LABELS[note.source] ?? note.source;
    const run = note.runId ? `（run ${note.runId}）` : '';
    return `- [${source} | ${date} | ${note.kind}] ${note.text}${run}`;
  });
}

/**
 * Deterministic facts worth remembering after a run. Model conclusions are not
 * saved automatically; rejected hypotheses are only stored when the run is
 * complete and the disclosure gate passed.
 */
export function buildMemoryCandidates(result = {}) {
  const candidates = [];
  const parser = result.logs?.parser;
  if (parser) {
    candidates.push({
      kind: 'log-format',
      source: 'tool',
      text: `日志格式：${parser}${result.logs?.parserFallback ? '（解析器自动降级）' : ''}`,
      tags: ['log-parser', parser],
    });
  }
  if (result.meta?.incomplete) return candidates;
  const disclosure = (result.gates?.checks ?? []).find((check) => check.name === 'hypothesis-disclosure');
  if (disclosure && disclosure.ok === false) return candidates;
  for (const item of (result.agent?.rejectedHypotheses ?? []).slice(0, 3)) {
    if (!item?.hypothesis || !item?.reason) continue;
    candidates.push({
      kind: 'excluded-hypothesis',
      source: 'previous-run',
      text: `已排除：${item.hypothesis}；理由：${item.reason}`,
      runId: result.meta?.runId ?? null,
      tags: ['excluded-hypothesis'],
    });
  }
  return candidates;
}

function emptyState() {
  return { version: MEMORY_VERSION, projects: {} };
}

function projectView(project) {
  const notes = project.notes.slice().sort(noteSort);
  return {
    key: project.key,
    name: project.name,
    roots: project.roots,
    notes,
    promptNotes: selectPromptNotes(notes),
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  };
}

export function createDiagnosisMemoryStore({ configDir = path.resolve('configs') } = {}) {
  const filePath = path.join(configDir, MEMORY_FILE);

  async function readState() {
    let text;
    try {
      text = await readFile(filePath, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return emptyState();
      throw error;
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new Error(`invalid diagnosis memory JSON: ${error?.message ?? error}`);
    }
    return normalizeMemoryState(parsed);
  }

  async function writeState(state) {
    await mkdir(configDir, { recursive: true });
    const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    await rename(tmp, filePath);
  }

  function ensureProject(state, identity) {
    const now = Date.now();
    let project = state.projects[identity.key];
    if (!project) {
      project = {
        key: identity.key,
        name: identity.name,
        roots: identity.roots,
        notes: [],
        createdAt: now,
        updatedAt: now,
      };
      state.projects[identity.key] = project;
    } else {
      project.name = identity.name;
      project.roots = identity.roots;
    }
    return project;
  }

  function trimNotes(project) {
    const auto = project.notes
      .filter((note) => note.source !== 'user')
      .sort((a, b) => (Number(b.pinned) - Number(a.pinned)) || ((b.lastSeenAt ?? 0) - (a.lastSeenAt ?? 0)))
      .slice(0, MAX_AUTO_NOTES);
    const user = project.notes.filter((note) => note.source === 'user');
    project.notes = dedupeNotes([...user, ...auto]).sort(noteSort);
  }

  async function getProject(identity) {
    if (!identity) {
      return { enabled: false, reason: 'no-project-roots', project: null, notes: [], promptNotes: [] };
    }
    const state = await readState();
    const project = state.projects[identity.key];
    if (!project) {
      return {
        enabled: true,
        project: { key: identity.key, name: identity.name, roots: identity.roots },
        notes: [],
        promptNotes: [],
      };
    }
    const view = projectView(project);
    return {
      enabled: true,
      project: {
        key: view.key,
        name: view.name,
        roots: view.roots,
        createdAt: view.createdAt,
        updatedAt: view.updatedAt,
      },
      notes: view.notes,
      promptNotes: view.promptNotes,
    };
  }

  async function addNote(identity, input) {
    if (!identity) throw new Error('project roots are required to save diagnosis memory');
    const note = normalizeMemoryNote(input, { source: input?.source ?? 'user' });
    if (!note) throw new Error('note text is required');
    const state = await readState();
    const project = ensureProject(state, identity);
    project.notes = dedupeNotes([note, ...project.notes]);
    trimNotes(project);
    project.updatedAt = Date.now();
    await writeState(state);
    return projectView(project);
  }

  async function updateNote(identity, id, patch = {}) {
    if (!identity) throw new Error('project roots are required to update diagnosis memory');
    const state = await readState();
    const project = ensureProject(state, identity);
    const index = project.notes.findIndex((note) => note.id === id);
    if (index < 0) throw new Error(`note not found: ${id}`);
    const updated = normalizeMemoryNote({
      ...project.notes[index],
      ...(patch.text !== undefined ? { text: patch.text } : {}),
      ...(patch.kind !== undefined ? { kind: patch.kind } : {}),
      ...(patch.pinned !== undefined ? { pinned: patch.pinned } : {}),
    }, { source: project.notes[index].source });
    if (!updated) throw new Error('note text is required');
    updated.id = project.notes[index].id;
    project.notes[index] = updated;
    trimNotes(project);
    project.updatedAt = Date.now();
    await writeState(state);
    return projectView(project);
  }

  async function deleteNote(identity, id) {
    if (!identity) throw new Error('project roots are required to delete diagnosis memory');
    const state = await readState();
    const project = ensureProject(state, identity);
    const before = project.notes.length;
    project.notes = project.notes.filter((note) => note.id !== id);
    if (project.notes.length === before) throw new Error(`note not found: ${id}`);
    project.updatedAt = Date.now();
    await writeState(state);
    return projectView(project);
  }

  async function mergeCandidates(identity, candidates = []) {
    if (!identity) return { saved: 0, updated: 0, total: 0 };
    const state = await readState();
    const project = ensureProject(state, identity);
    const now = Date.now();
    let saved = 0;
    let updated = 0;
    for (const raw of Array.isArray(candidates) ? candidates : []) {
      const note = normalizeMemoryNote(raw, { now, source: raw?.source ?? 'tool' });
      if (!note) continue;
      if (note.kind === 'log-format' && note.source === 'tool') {
        project.notes = project.notes.filter(
          (item) => !(item.kind === 'log-format' && item.source === 'tool' && item.text !== note.text),
        );
      }
      const existing = project.notes.find(
        (item) => item.kind === note.kind && item.text.toLowerCase() === note.text.toLowerCase(),
      );
      if (existing) {
        existing.lastSeenAt = now;
        existing.seenCount = (existing.seenCount ?? 1) + 1;
        existing.runId = note.runId ?? existing.runId;
        updated += 1;
      } else {
        project.notes.push(note);
        saved += 1;
      }
    }
    trimNotes(project);
    project.updatedAt = now;
    await writeState(state);
    return { saved, updated, total: project.notes.length };
  }

  async function listProjects() {
    const state = await readState();
    return Object.values(state.projects).map((project) => ({
      key: project.key,
      name: project.name,
      noteCount: project.notes.length,
      updatedAt: project.updatedAt,
    }));
  }

  return { filePath, getProject, addNote, updateNote, deleteNote, mergeCandidates, listProjects };
}
