import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { AppError } from '../core/errors.mjs';
import { redactCommand, redactSecrets } from '../core/redact.mjs';
import { findPortPids, parseJcmdCommandLine, parseJpsOutput, runJvmTool } from './jvm.mjs';
import { inside, resolveWithinRoot } from '../core/path-policy.mjs';

const MAX_SELECTORS = 20;
const MAX_SELECTED = 200;
const MAX_VALUE = 200;
const SENSITIVE_KEY = /(?:password|passwd|pwd|secret|token|credential|api[-_]?key|access[-_]?key|private[-_]?key|authorization|cookie|session)/i;
export const DEFAULT_DENY_PREFIXES = Object.freeze([
  'password', 'passwd', 'pwd', 'secret', 'token', 'credential',
  'apikey', 'api_key', 'api.key', 'accesskey', 'access_key', 'privatekey', 'private_key',
  'authorization', 'cookie', 'session', 'jwt', 'oauth', 'refresh_token',
  'license', 'licence', 'activation', 'serial', 'entitlement',
  'internal', 'intranet', 'corp',
]);

function denySegments(value) {
  return String(value ?? '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

function normalizeDenyPrefixes(values = []) {
  const out = [...DEFAULT_DENY_PREFIXES];
  for (const value of Array.isArray(values) ? values : []) {
    const text = String(value ?? '').trim().toLowerCase().replace(/[^a-z0-9._-]/g, '').slice(0, 80);

    if (text && !out.includes(text)) out.push(text);
    if (out.length >= 60) break;
  }
  return out;
}

function isDeniedKey(key, prefixes) {
  const segments = denySegments(key);
  if (segments.length === 0) return false;
  for (const prefix of prefixes) {
    const wanted = denySegments(prefix);
    if (wanted.length === 0 || wanted.length > segments.length) continue;
    for (let start = 0; start <= segments.length - wanted.length; start += 1) {
      if (wanted.every((part, index) => segments[start + index] === part)) return true;
    }
  }
  return false;
}
const VIEWS = new Map([
  ['system_properties', 'VM.system_properties'],
  ['classloader', 'VM.classloader_stats'],
  ['flags', 'VM.flags'],
  ['command_line', 'VM.command_line'],
]);

function fingerprint(value) {
  return createHash('sha1').update(String(value ?? '')).digest('hex').slice(0, 12);
}

function valueText(value, { hide = false, sensitive = false } = {}) {
  if (value === null || value === undefined) return null;
  if (hide || sensitive) return '<redacted>';
  return redactSecrets(String(value)).slice(0, MAX_VALUE);
}

function parseProperties(text) {
  const out = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const index = line.search(/[=:]/);
    if (index <= 0) continue;
    const key = line.slice(0, index).trim();
    if (!key || /\s/.test(key)) continue;
    out.push([key, line.slice(index + 1)]);
  }
  return out;
}

function parseDeclaredText(text) {
  const trimmed = String(text ?? '').replace(/^﻿/, '').trim();
  if (!trimmed) return new Map();
  if (trimmed.startsWith('{')) {
    try {
      const data = JSON.parse(trimmed);
      if (data && typeof data === 'object' && !Array.isArray(data)) {
        return new Map(Object.entries(data).map(([key, value]) => [key, String(value)]));
      }
    } catch {
      // Fall through to properties parsing.
    }
  }
  const map = new Map();
  for (const raw of trimmed.split(/\r?\n/)) {
    const line = raw.trim().replace(/^-D/, '');
    const index = line.search(/[=:]/);
    if (index <= 0) continue;
    map.set(line.slice(0, index).trim(), line.slice(index + 1));
  }
  return map;
}

function globMatch(pattern, text) {
  const p = String(pattern ?? '');
  const t = String(text ?? '');
  if (!p.includes('*')) return p === t;
  const parts = p.split('*');
  if (!t.startsWith(parts[0])) return false;
  let index = parts[0].length;
  for (let i = 1; i < parts.length; i += 1) {
    if (!parts[i]) continue;
    const found = t.indexOf(parts[i], index);
    if (found < 0) return false;
    index = found + parts[i].length;
  }
  return p.endsWith('*') || index === t.length;
}

function matchesSelector(key, selector) {
  const pattern = String(selector ?? '').trim();
  if (!pattern) return false;
  if (pattern.includes('*')) return globMatch(pattern, key);
  if (pattern.endsWith('.')) return key.startsWith(pattern);
  return key === pattern;
}

export function normalizeSelectors(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new AppError('INVALID_SELECTORS', 'selectors must be an array of strings', { exitCode: 2 });
  return value.slice(0, MAX_SELECTORS)
    .map((item) => String(item ?? '').trim())
    .filter(Boolean)
    .map((item) => item.replace(/[\r\n]/g, '').slice(0, 200));
}

function selectProperties(entries, selectors, denyPrefixes = []) {
  const all = new Map(entries);
  const wildcard = selectors.some((selector) => selector.includes('*') || selector.endsWith('.'));
  if (selectors.length === 0) {
    const groups = new Map();
    let deniedCount = 0;
    for (const [key] of entries) {
      if (isDeniedKey(key, denyPrefixes)) {
        deniedCount += 1;
        continue;
      }
      const group = key.split('.')[0] || '(root)';
      groups.set(group, (groups.get(group) ?? 0) + 1);
    }
    return {
      items: [],
      totalKeys: entries.length,
      selectedCount: 0,
      valuesHidden: true,
      deniedCount,
      groups: [...groups.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([group, count]) => ({ group, count })),
      sampleKeys: [...all.keys()].filter((key) => !isDeniedKey(key, denyPrefixes)).slice(0, 10),
    };
  }
  const items = [];
  let deniedCount = 0;
  for (const [key, value] of entries) {
    if (!selectors.some((selector) => matchesSelector(key, selector))) continue;
    if (isDeniedKey(key, denyPrefixes)) {
      deniedCount += 1;
      if (!wildcard) items.push({ key, present: true, denied: true });
      continue;
    }
    const sensitive = SENSITIVE_KEY.test(key);
    items.push({
      key,
      present: true,
      value: valueText(value, { hide: wildcard, sensitive }),
      fingerprint: sensitive ? null : fingerprint(value),
    });
    if (items.length >= MAX_SELECTED) break;
  }
  return {
    items,
    totalKeys: entries.length,
    selectedCount: items.length,
    valuesHidden: wildcard,
    deniedCount,
  };
}

function diffProperties(aEntries, bEntries, selectors, denyPrefixes = []) {
  const a = new Map(aEntries);
  const b = new Map(bEntries);
  const hide = selectors.some((selector) => selector.includes('*'));
  const keys = new Set([...a.keys(), ...b.keys()].filter((key) => selectors.some((selector) => matchesSelector(key, selector))));
  const items = [];
  let sameCount = 0;
  let deniedCount = 0;
  for (const key of keys) {
    if (isDeniedKey(key, denyPrefixes)) {
      deniedCount += 1;
      continue;
    }
    const hasA = a.has(key);
    const hasB = b.has(key);
    const sensitive = SENSITIVE_KEY.test(key);
    if (hasA && hasB && String(a.get(key)) === String(b.get(key))) {
      sameCount += 1;
      continue;
    }
    if (!hasA) {
      items.push({ kind: 'missing-in-a', key, b: valueText(b.get(key), { hide, sensitive }), fingerprint: sensitive ? null : fingerprint(b.get(key)) });
    } else if (!hasB) {
      items.push({ kind: 'missing-in-b', key, a: valueText(a.get(key), { hide, sensitive }), fingerprint: sensitive ? null : fingerprint(a.get(key)) });
    } else {
      items.push({
        kind: 'different',
        key,
        a: valueText(a.get(key), { hide, sensitive }),
        b: valueText(b.get(key), { hide, sensitive }),
        aFingerprint: sensitive ? null : fingerprint(a.get(key)),
        bFingerprint: sensitive ? null : fingerprint(b.get(key)),
      });
    }
  }
  return { items, sameCount, selectedCount: keys.size, deniedCount };
}

async function resolvePid({ pid = null, port = null } = {}) {
  let targetPid = pid === null || pid === undefined || pid === '' ? null : Number(pid);
  if (targetPid !== null && (!Number.isInteger(targetPid) || targetPid <= 0)) {
    throw new AppError('INVALID_PID', 'pid must be a positive integer', { exitCode: 2 });
  }
  const processes = parseJpsOutput(await runJvmTool('jps', ['-l']));
  if (targetPid === null) {
    if (port === null || port === undefined || port === '') {
      throw new AppError('JVM_PID_REQUIRED', 'pid or port is required', { exitCode: 2 });
    }
    const pids = await findPortPids(port);
    const javaPids = pids.filter((candidate) => processes.some((process) => process.pid === candidate));
    if (javaPids.length === 0) throw new AppError('JVM_PROCESS_NOT_FOUND', `没有发现监听端口 ${port} 的 Java 进程`, { exitCode: 2 });
    if (javaPids.length > 1) return { candidates: javaPids.map((item) => ({ pid: item })), reason: `端口 ${port} 对应多个 Java 进程` };
    targetPid = javaPids[0];
  }
  const processInfo = processes.find((process) => process.pid === targetPid);
  if (!processInfo) throw new AppError('JVM_PROCESS_NOT_FOUND', `pid ${targetPid} 不是当前可见的 Java 进程`, { exitCode: 2 });
  return { pid: targetPid, processInfo };
}

async function resolveDeclaredFile(input, allowRoots = [], cwd = process.cwd()) {
  if (!input) return null;
  const roots = [...new Set([...allowRoots, cwd].filter(Boolean).map((root) => path.resolve(root)))];
  const requestedList = path.isAbsolute(String(input))
    ? [path.resolve(String(input))]
    : roots.map((root) => path.resolve(root, String(input)));
  for (const requested of requestedList) {
    for (const root of roots) {
      const relative = path.relative(root, requested);
      if (relative.startsWith('..') || path.isAbsolute(relative)) continue;
      try {
        const resolved = await resolveWithinRoot(root, relative, { requireFile: true });
        return resolved.absolute;
      } catch {
        // Try the next allowed root.
      }
    }
  }
  throw new AppError('DECLARED_FACTS_OUT_OF_SCOPE', 'declaredFile must be inside the source root, run directory or workspace', { exitCode: 2 });
}

function selectLines(lines, selectors) {
  const selected = selectors.length > 0
    ? lines.filter((line) => selectors.some((selector) => matchesSelector(line, selector)
      || (selector.endsWith('*') && globMatch(selector, line))
      || (line.toLowerCase().includes(selector.toLowerCase()))))
    : lines;
  return selected.slice(0, MAX_SELECTED).map((line) => redactSecrets(line).slice(0, 300));
}

async function readView(pid, view) {
  const command = VIEWS.get(view);
  if (!command) throw new AppError('INVALID_VIEW', `view must be one of ${[...VIEWS.keys()].join(', ')}`, { exitCode: 2 });
  const stdout = await runJvmTool('jcmd', [String(pid), command]);
  if (view === 'system_properties') return { entries: parseProperties(stdout) };
  if (view === 'command_line') {
    const parsed = parseJcmdCommandLine(stdout);
    return {
      items: [{
        command: parsed.command ? redactCommand(parsed.command).slice(0, 1000) : null,
        classPath: parsed.classPath ? redactCommand(parsed.classPath).slice(0, 2000) : null,
      }],
    };
  }
  const lines = String(stdout ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return { items: lines };
}

export async function runtimeFacts({
  pid = null,
  port = null,
  view = 'system_properties',
  selectors = [],
  denyPrefixes = [],
  comparePid = null,
  declaredFile = null,
  allowRoots = [],
  cwd = process.cwd(),
} = {}) {
  if (!VIEWS.has(view)) throw new AppError('INVALID_VIEW', `view must be one of ${[...VIEWS.keys()].join(', ')}`, { exitCode: 2 });
  const normalizedSelectors = normalizeSelectors(selectors);
  const effectiveDenyPrefixes = normalizeDenyPrefixes(denyPrefixes);
  const target = await resolvePid({ pid, port });
  if (target.candidates) return target;
  const main = await readView(target.pid, view);
  const limitations = [];
  let items = [];
  let meta = {};

  if (view === 'system_properties') {
    if (comparePid !== null && comparePid !== undefined && comparePid !== '') {
      if (normalizedSelectors.length === 0) {
        throw new AppError('SELECTORS_REQUIRED', 'comparePid requires at least one selector', { exitCode: 2 });
      }
      const other = await resolvePid({ pid: comparePid });
      if (other.candidates) return other;
      const otherView = await readView(other.pid, view);
      const diff = diffProperties(main.entries, otherView.entries, normalizedSelectors, effectiveDenyPrefixes);
      items = diff.items;
      meta = {
        compared: { pidA: target.pid, pidB: other.pid },
        sameCount: diff.sameCount,
        selectedCount: diff.selectedCount,
        deniedCount: diff.deniedCount,
        totalKeysA: main.entries.length,
        totalKeysB: otherView.entries.length,
        selectors: normalizedSelectors,
      };
    } else if (declaredFile) {
      if (normalizedSelectors.length === 0) {
        throw new AppError('SELECTORS_REQUIRED', 'declaredFile requires at least one selector', { exitCode: 2 });
      }
      const absolute = await resolveDeclaredFile(declaredFile, allowRoots, cwd);
      const declared = parseDeclaredText(await readFile(absolute, 'utf8'));
      const diff = diffProperties(main.entries, [...declared.entries()], normalizedSelectors, effectiveDenyPrefixes);
      items = diff.items;
      meta = {
        comparedWith: 'declaredFile',
        declaredFile: path.basename(absolute),
        sameCount: diff.sameCount,
        selectedCount: diff.selectedCount,
        deniedCount: diff.deniedCount,
        totalKeys: main.entries.length,
        selectors: normalizedSelectors,
      };
    } else {
      const selected = selectProperties(main.entries, normalizedSelectors, effectiveDenyPrefixes);
      items = selected.items;
      meta = {
        totalKeys: selected.totalKeys,
        selectedCount: selected.selectedCount,
        valuesHidden: selected.valuesHidden,
        deniedCount: selected.deniedCount ?? 0,
        ...(selected.groups ? { groups: selected.groups } : {}),
        ...(selected.sampleKeys ? { sampleKeys: selected.sampleKeys } : {}),
        selectors: normalizedSelectors,
      };
      if (selected.valuesHidden) limitations.push('通配 selector 只返回键名，不返回值');
    }
  } else if (view === 'classloader') {
    items = selectLines(main.items, normalizedSelectors);
    meta = { totalLines: main.items.length, loaderCount: main.items.length, selectors: normalizedSelectors };
    limitations.push('classloader 视图来自 VM.classloader_stats，不包含每个 classloader 的 jar URL 或已加载类来源');
  } else if (view === 'flags') {
    items = selectLines(main.items, normalizedSelectors);
    meta = { totalLines: main.items.length, selectors: normalizedSelectors };
  } else {
    items = main.items;
    meta = { selectors: normalizedSelectors };
  }

  return {
    view,
    pid: target.pid,
    mainClass: target.processInfo?.mainClass ?? null,
    ...meta,
    items,
    limitations,
  };
}
