import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { walkSourceFiles } from '../evidence/source.mjs';

export const FIX_RISKS = ['low', 'medium', 'high'];

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_SEARCH_BYTES = 100 * 1024;

function clean(value, max = 1000) {
  return String(value ?? '').trim().slice(0, max);
}

function cleanBlock(value) {
  return typeof value === 'string' ? value.slice(0, MAX_SEARCH_BYTES) : '';
}

// Logger calls such as log.info(...) / logger.warn(...). The word boundary
// avoids matching e.g. `catalog.debug`.
const LOGGER_CALL = /\b(log|logger|LOG|LOGGER)\s*\.\s*(?:trace|debug|info|warn|error|fatal|log|fine|finest|finer|config|severe|warning|notice|critical|print(?:ln|f)?|panic(?:ln|f)?)\s*\(/;
const LOGGER_CALL_ALL = new RegExp(LOGGER_CALL.source, 'g');

const LOMBOK_LOGGERS = [
  { name: 'Slf4j', pkg: 'lombok.extern.slf4j' },
  { name: 'XSlf4j', pkg: 'lombok.extern.slf4j' },
  { name: 'Log4j2', pkg: 'lombok.extern.log4j' },
  { name: 'Log4j', pkg: 'lombok.extern.log4j' },
  { name: 'CommonsLog', pkg: 'lombok.extern.apachecommons' },
  { name: 'JBossLog', pkg: 'lombok.extern.jbosslog' },
];

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Check that a newly introduced logger call has a usable definition and, when
 * the definition needs an import, that the import is present too.
 *
 * @param {string} updated full file text after applying the patch
 * @returns {string | null}
 */
function loggerDefinitionIssue(updated) {
  let defined = false;
  const problems = [];

  for (const { name, pkg } of LOMBOK_LOGGERS) {
    const simple = new RegExp(`@${name}\\b`);
    const qualified = new RegExp(`@${escapeRegex(pkg)}\\.${name}\\b`);
    if (!simple.test(updated) && !qualified.test(updated)) continue;
    defined = true;
    const imported = new RegExp(
      `import\\s+(?:${escapeRegex(pkg)}\\.${name}|${escapeRegex(pkg)}\\.\\*)\\s*;`,
    ).test(updated);
    if (!qualified.test(updated) && !imported) {
      problems.push(`使用了 @${name}，但缺少 import ${pkg}.${name}`);
    }
  }

  const fullyQualifiedField = /(?:[A-Za-z_$][\w$]*\.)+(?:Logger|Log)\s+(?:log|logger|LOG|LOGGER)\b/.test(updated);
  if (fullyQualifiedField) {
    defined = true;
  } else {
    const field = updated.match(/\b(Logger|Log)\s+(?:log|logger|LOG|LOGGER)\b/);
    if (field) {
      defined = true;
      const type = field[1];
      const imported = new RegExp(`import\\s+[\\w.]*\\.${type}\\s*;`).test(updated);
      if (!imported) problems.push(`声明了 ${type} 字段，但缺少 import 对应的 ${type} 类`);
    }
  }

  if (/\b(?:org\.slf4j\.)?LoggerFactory\s*\.\s*getLogger\s*\(/.test(updated)) {
    const factoryImported = /import\s+org\.slf4j\.LoggerFactory\s*;/.test(updated)
      || /\borg\.slf4j\.LoggerFactory\s*\.\s*getLogger/.test(updated);
    if (!factoryImported) problems.push('使用了 LoggerFactory，但缺少 import org.slf4j.LoggerFactory');
  }

  if (/\blogging\s*\.\s*getLogger\s*\(/.test(updated)) {
    defined = true;
    const imported = /^\s*import\s+logging\b/m.test(updated)
      || /^\s*from\s+logging\s+import\b/m.test(updated);
    if (!imported) problems.push('使用了 logging.getLogger，但缺少 import logging');
  }

  if (/(?:^|\n)\s*import\s+[^\n]*\b(?:log|logger|Logger)\b[^\n]*from/m.test(updated)
    || /^\s*(?:const|let|var)\s+(?:log|logger)\s*=/m.test(updated)) {
    defined = true;
  }

  if (/(?:import\s+)?["']log["']/.test(updated)) {
    defined = true; // Go standard library logger
  }

  if (!defined) return '文件中没有可用的 logger 定义';
  if (problems.length > 0) return problems[0];
  return null;
}

function symbolDefined(updated, symbol) {
  if (symbol === 'log' && /@(?:[a-z][\w$]*\.)*(?:Slf4j|XSlf4j|Log4j2?|CommonsLog|JBossLog)\b/.test(updated)) {
    return true;
  }
  const escaped = escapeRegex(symbol);
  if (new RegExp(`\\b(?:[A-Za-z_$][\\w$]*\\.)*(?:Logger|Log)\\s+${escaped}\\b`).test(updated)) return true;
  if (new RegExp(`\\b${escaped}\\s*=\\s*[^\\n]*(?:getLogger|LoggerFactory|LogFactory)`).test(updated)) return true;
  if (new RegExp(`\\b(?:const|let|var)\\s+${escaped}\\s*=`).test(updated)) return true;
  if (new RegExp(`^\\s*import\\s+${escaped}\\b[^\\n]*from`, 'm').test(updated)
    || new RegExp(`^\\s*import\\s+\\{[^}]*\\b${escaped}\\b[^}]*\\}\\s+from`, 'm').test(updated)) {
    return true;
  }
  if (symbol === 'log' && /(?:import\s+)?["']log["']/.test(updated)) return true;
  return false;
}

/**
 * Reject a patch that starts calling a logger method without making the logger
 * available in the same file. Existing logger calls mean the symbol already
 * resolves (including inherited loggers), so only new symbols are checked.
 *
 * @param {{ original: string, updated: string, replacement: string }} input
 * @returns {string | null}
 */
export function inspectLoggerUsage({ original, updated, replacement }) {
  const replacementSymbols = [...replacement.matchAll(LOGGER_CALL_ALL)].map((match) => match[1]);
  if (replacementSymbols.length === 0) return null;
  const existingSymbols = new Set([...original.matchAll(LOGGER_CALL_ALL)].map((match) => match[1]));
  const newSymbols = [...new Set(replacementSymbols)].filter((symbol) => !existingSymbols.has(symbol));
  if (newSymbols.length === 0) return null;

  const issue = loggerDefinitionIssue(updated);
  if (issue) {
    return `修改新增了 log 调用，但${issue}；请在同一条修改中补齐 import/声明（如 Java 的 @Slf4j 与 import，或项目已有的 Logger 字段），或改用文件已有的 logger。`;
  }
  const missing = newSymbols.find((symbol) => !symbolDefined(updated, symbol));
  if (!missing) return null;
  return `修改使用了 ${missing}，但文件中没有定义这个 logger；请在同一条修改中补齐 import/声明，或改用文件已有的 logger。`;
}

const METHOD_CALL = /\b([a-z_$][A-Za-z0-9_$]*)\s*\(/g;
const METHOD_CALL_ALL = new RegExp(METHOD_CALL.source, 'g');

// Control-flow keywords and common language/library methods. The project-wide
// method index is the primary source of truth; this list only suppresses the
// obvious false positives when a library method is first used inside a patch.
const NON_METHOD_WORDS = new Set(
  'if for while switch catch return throw new synchronized assert do else try finally when case super this function typeof await yield delete in with match'.split(' '),
);
const BUILTIN_METHODS = new Set(`
  toString hashCode equals compareTo clone getClass getMessage getCause printStackTrace
  println printf print format valueOf parseInt parseLong parseDouble parseFloat parseBoolean
  now of asList stream map filter collect forEach sorted limit skip count findFirst findAny
  orElse orElseGet orElseThrow ifPresent isPresent isEmpty isNotEmpty isBlank isNumeric
  length size add addAll put putAll get getOrDefault remove contains containsKey containsValue
  keySet values entrySet iterator next hasNext clear poll peek offer push pop join split trim strip
  replace replaceAll replaceFirst startsWith endsWith indexOf lastIndexOf substring charAt
  toCharArray toUpperCase toLowerCase concat matches toArray copyOf requireNonNull checkArgument
  checkState checkNotNull nonNull isNull uuid random currentTimeMillis nanoTime sleep wait notify
  notifyAll append insert reverse setLength build builder getBean getLogger log info debug warn
  error trace fatal execute query queryForObject queryForList batchUpdate commit rollback
  beginTransaction close read write flush sendRedirect getParameter setAttribute getAttribute
  setHeader getHeader selectOne selectList selectCount insert update delete selectById
  insertBatch updateBatch deleteByIds startPage getDataTable success toAjax getLoginUser
  getUserId getUsername getDeptId isAdmin fetch then json text reduce find some every includes
  slice splice stringify parse querySelector querySelectorAll addEventListener removeEventListener
  getElementById createElement appendChild focus preventDefault stopPropagation setTimeout
  clearTimeout requestAnimationFrame alert confirm toLocaleString len str int float bool list
  dict set tuple range enumerate zip open items keys update startswith endswith isinstance
  hasattr getattr setattr any all min max sum sorted Printf Sprintf Errorf WriteLine
  isNotBlank isEqual isTrue isFalse capitalize abbreviate defaultString defaultIfBlank
  isNotNull notEmpty hasText hasLength ofNullable empty copyProperties convert parseObject
  toJSONString toBean getInstance newInstance newBuilder computeIfAbsent putIfAbsent merge
  requireNonNullElse singletonList emptyList unmodifiableList synchronizedList newArrayList
  newHashMap newHashSet copyOfRange binarySearch deepEquals deepHashCode identityHashCode
  send doGet doPost service init destroy post request use next emit on off once mount unmount
  render setup computed ref reactive watch watchEffect provide inject createApp useRouter
  useRoute beforeEach afterEach push back go useState useEffect useMemo useCallback useRef
  useContext createElement setState dispatch require resolve readFile writeFile existsSync
  mkdir readdir stat exec spawn getCurrentUser getRequest getResponse getNowDate
  checkUserAllowed checkRoleAllowed checkDataScope
`.trim().split(/\s+/).filter(Boolean));

function methodNamesIn(text) {
  const names = new Set();
  for (const match of String(text ?? '').matchAll(METHOD_CALL_ALL)) names.add(match[1]);
  return names;
}

function methodDefined(updated, name) {
  const escaped = escapeRegex(name);
  return [
    new RegExp(`\\b(?:public|private|protected|static|final|synchronized|abstract|native|default|async|export|function|def|fun|func|fn|void|int|long|double|float|boolean|char|byte|short|String|Object)\\b[^\\n;{}=]*\\b${escaped}\\s*\\(`, 'm'),
    new RegExp(`^\\s*(?:@[^\\n]+\\s*)*(?:[\\w<>\\[\\],.?]+\\s+)?${escaped}\\s*\\([^)]*\\)\\s*(?:throws[^\\n{]+)?\\{`, 'm'),
    new RegExp(`\\b(?:const|let|var)\\s+${escaped}\\s*=\\s*(?:async\\s*)?(?:\\(|function)`, 'm'),
    new RegExp(`\\bfunction\\s+${escaped}\\s*\\(`),
    new RegExp(`\\bdef\\s+${escaped}\\s*\\(`),
    new RegExp(`\\bfun\\s+${escaped}\\s*\\(`),
    new RegExp(`\\b(?:func|fn)\\s+${escaped}\\s*\\(`),
  ].some((pattern) => pattern.test(updated));
}

const projectMethodIndexCache = new Map();

export function clearProjectMethodIndexCache() {
  projectMethodIndexCache.clear();
}

async function projectMethodIndex(root) {
  const key = path.resolve(root);
  if (projectMethodIndexCache.has(key)) return projectMethodIndexCache.get(key);
  const names = new Set();
  try {
    const files = await walkSourceFiles(key);
    for (const file of files) {
      try {
        const info = await stat(file);
        if (info.size > MAX_FILE_BYTES) continue;
        const text = await readFile(file, 'utf8');
        for (const match of text.matchAll(METHOD_CALL_ALL)) names.add(match[1]);
      } catch {
        // unreadable file: skip
      }
    }
  } catch {
    // A source scan failure must never block a fix preview.
  }
  projectMethodIndexCache.set(key, names);
  return names;
}

/**
 * Reject an edit that calls a method which exists nowhere in the project and is
 * not added by the same patch. Getter/setter names are ignored because Lombok
 * and similar generators create them without textual definitions.
 *
 * @param {{ original: string, updated: string, replacement: string, sourceRoot?: string | null }} input
 * @returns {Promise<string | null>}
 */
export async function inspectMissingMethods({ original, updated, replacement, sourceRoot }) {
  if (!sourceRoot) return null;
  const existing = methodNamesIn(original);
  const added = [...methodNamesIn(replacement)].filter((name) => !existing.has(name));
  const candidates = added.filter((name) => (
    !NON_METHOD_WORDS.has(name)
    && !BUILTIN_METHODS.has(name)
    && !/^(?:get|set|is)[A-Z]/.test(name)
  ));
  if (candidates.length === 0) return null;

  const index = await projectMethodIndex(sourceRoot);
  if (index.size === 0) return null;
  const missing = [];
  for (const name of candidates) {
    if (methodDefined(updated, name)) continue;
    if (index.has(name)) continue;
    missing.push(name);
    if (missing.length >= 3) break;
  }
  if (missing.length === 0) return null;
  return `修改调用了项目中不存在的方法：${missing.map((name) => `${name}()`).join('、')}，且没有在同一条修改中新增该方法；请补充方法实现或改用已有方法。`;
}

/**
 * Normalize one fix. Strings (the pre-2a schema) remain text-only suggestions.
 *
 * @param {any} item
 * @returns {any | null}
 */
export function normalizeFix(item) {
  if (typeof item === 'string') {
    const summary = clean(item);
    return summary
      ? {
          summary,
          kind: 'text',
          root: null,
          extraRoot: null,
          file: '',
          search: '',
          replace: '',
          content: '',
          baseHash: null,
          risk: null,
          verification: '',
          note: '',
        }
      : null;
  }
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null;

  const summary = clean(item.summary ?? item.title ?? '');
  const file = clean(item.file, 500);
  const search = cleanBlock(item.search);
  const replace = cleanBlock(item.replace);
  const content = cleanBlock(item.content);
  let kind = 'text';
  if (item.kind === 'create' && file) kind = 'create';
  else if (item.kind === 'delete' && file) kind = 'delete';
  else if (item.kind === 'edit' || search || replace) kind = 'edit';
  const root = ['frontend', 'backend', 'extra'].includes(item.root) ? item.root : null;
  const risk = FIX_RISKS.includes(item.risk) ? item.risk : kind === 'text' ? null : 'medium';
  if (!summary && !file) return null;

  return {
    summary: summary || `修改 ${file}`,
    kind,
    root,
    extraRoot: clean(item.extraRoot, 200) || null,
    file,
    search,
    replace,
    content,
    baseHash: clean(item.baseHash, 128) || null,
    risk,
    verification: clean(item.verification, 1000),
    note: clean(item.note, 1000),
  };
}

export function normalizeFixList(value) {
  if (!Array.isArray(value)) return [];
  return value.map(normalizeFix).filter(Boolean);
}

async function pathKind(target) {
  try {
    const info = await stat(target);
    if (info.isDirectory()) return 'dir';
    if (info.isFile()) return 'file';
    return 'other';
  } catch {
    return null;
  }
}

function isInside(root, target) {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  return resolvedTarget === resolvedRoot || resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`);
}

/**
 * Resolve a fix's relative file inside the configured roots.
 * Exported so the apply/undo path uses exactly the same validation as the preview.
 *
 * @param {any} item
 * @param {{
 *   sourceRoot?: string | null,
 *   frontendSourceRoot?: string | null,
 *   extraSourceRoots?: Array<{ id: string, root: string }>
 * }} roots
 */
export async function resolveFixTarget(item, {
  sourceRoot = null,
  frontendSourceRoot = null,
  extraSourceRoots = [],
} = {}) {
  const fix = normalizeFix(item);
  if (!fix) return { error: '无效的修复建议' };
  if (!fix.file) return { error: '修复建议没有指定文件' };
  if (path.isAbsolute(fix.file)) return { error: '文件路径必须是相对路径' };

  const relative = fix.file.replace(/\\/g, '/');
  const candidates = [];
  const add = (name, root, extraRoot = null) => {
    if (!root) return;
    const resolved = path.resolve(root, relative);
    if (!isInside(root, resolved)) {
      candidates.push({ name, root, extraRoot, outside: true });
      return;
    }
    candidates.push({ name, root, extraRoot, resolved });
  };

  if (fix.root === 'backend') add('backend', sourceRoot);
  else if (fix.root === 'frontend') add('frontend', frontendSourceRoot);
  else if (fix.root === 'extra') {
    const list = Array.isArray(extraSourceRoots) ? extraSourceRoots : [];
    const matched = list.find((entry) => entry.id === fix.extraRoot);
    if (!matched) {
      return { error: '其他后端源码未授权或 extraRoot 无效，无法生成预览' };
    }
    add('extra', matched.root, matched.id);
  } else {
    add('backend', sourceRoot);
    add('frontend', frontendSourceRoot);
  }

  if (candidates.length === 0) {
    return { error: '未配置后端/前端源码目录，无法生成预览' };
  }
  if (candidates.some((candidate) => candidate.outside)) {
    return { error: `文件路径越出源码目录：${fix.file}` };
  }

  const existing = [];
  for (const candidate of candidates) {
    if (await pathKind(candidate.resolved) !== 'file') continue;
    const [realRoot, realFile] = await Promise.all([
      realpath(candidate.root).catch(() => null),
      realpath(candidate.resolved).catch(() => null),
    ]);
    if (realRoot && realFile && !isInside(realRoot, realFile)) {
      return { error: `文件通过符号链接越出源码目录：${fix.file}` };
    }
    existing.push(candidate);
  }
  if (existing.length === 0) {
    return { error: `未找到文件：${fix.file}${fix.root ? `（${fix.root}）` : ''}` };
  }
  if (existing.length > 1) {
    return { error: `同一相对路径同时存在于后端和前端源码目录，请在修复建议中指定 root：${fix.file}` };
  }
  return { ...existing[0], relative: relative };
}

/**
 * Resolve the destination of a new file. The path must be inside a configured
 * root and must not exist yet.
 */
export async function resolveFixDestination(item, {
  sourceRoot = null,
  frontendSourceRoot = null,
  extraSourceRoots = [],
} = {}) {
  const fix = normalizeFix(item);
  if (!fix) return { error: '无效的修复建议' };
  if (!fix.file) return { error: '修复建议没有指定文件' };
  if (path.isAbsolute(fix.file)) return { error: '文件路径必须是相对路径' };

  const relative = fix.file.replace(/\\/g, '/');
  const candidates = [];
  const add = (name, root, extraRoot = null) => {
    if (!root) return;
    const resolved = path.resolve(root, relative);
    if (!isInside(root, resolved)) {
      candidates.push({ name, root, extraRoot, outside: true });
      return;
    }
    candidates.push({ name, root, extraRoot, resolved });
  };

  if (fix.root === 'backend') add('backend', sourceRoot);
  else if (fix.root === 'frontend') add('frontend', frontendSourceRoot);
  else if (fix.root === 'extra') {
    const list = Array.isArray(extraSourceRoots) ? extraSourceRoots : [];
    const matched = list.find((entry) => entry.id === fix.extraRoot);
    if (!matched) return { error: '其他后端源码未授权或 extraRoot 无效，无法生成预览' };
    add('extra', matched.root, matched.id);
  } else {
    add('backend', sourceRoot);
    add('frontend', frontendSourceRoot);
  }

  if (candidates.length === 0) return { error: '未配置后端/前端源码目录，无法生成预览' };
  if (candidates.some((candidate) => candidate.outside)) {
    return { error: `文件路径越出源码目录：${fix.file}` };
  }
  const missing = [];
  for (const candidate of candidates) {
    const kind = await pathKind(candidate.resolved);
    if (kind !== null) return { error: `目标文件已存在：${fix.file}` };
    let parent = path.dirname(candidate.resolved);
    let safeParent = false;
    for (;;) {
      if (await pathKind(parent)) {
        const [realRoot, realParent] = await Promise.all([
          realpath(candidate.root).catch(() => null),
          realpath(parent).catch(() => null),
        ]);
        safeParent = Boolean(realRoot && realParent && isInside(realRoot, realParent));
        break;
      }
      const next = path.dirname(parent);
      if (next === parent) break;
      parent = next;
    }
    if (!safeParent) return { error: `新建文件路径通过符号链接越出源码目录：${fix.file}` };
    missing.push(candidate);
  }
  if (missing.length === 0) return { error: `目标文件已存在：${fix.file}` };
  if (missing.length > 1) {
    return { error: `同一相对路径可同时创建于后端和前端源码目录，请在修复建议中指定 root：${fix.file}` };
  }
  return { ...missing[0], relative };
}

async function readText(file) {
  const info = await stat(file);
  if (!info.isFile()) throw new Error('目标不是文件');
  if (info.size > MAX_FILE_BYTES) throw new Error('文件超过 2MB，拒绝预览');
  const buffer = await readFile(file);
  const text = buffer.toString('utf8').replace(/^﻿/, '').replace(/\r\n/g, '\n');
  return { text, hash: createHash('sha256').update(buffer).digest('hex') };
}

function countOccurrences(text, needle) {
  if (!needle) return 0;
  let count = 0;
  let index = 0;
  while ((index = text.indexOf(needle, index)) !== -1) {
    count += 1;
    index += needle.length;
  }
  return count;
}

function splitLines(text) {
  return text === '' ? [] : text.split('\n');
}

function diffLines(oldLines, newLines) {
  if (oldLines.length * newLines.length > 200_000) {
    return [
      ...oldLines.map((line) => ({ type: '-', line })),
      ...newLines.map((line) => ({ type: '+', line })),
    ];
  }
  const rows = oldLines.length + 1;
  const cols = newLines.length + 1;
  const dp = Array.from({ length: rows }, () => new Array(cols).fill(0));
  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      dp[i][j] = oldLines[i - 1] === newLines[j - 1]
        ? dp[i - 1][j - 1] + 1
        : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  const ops = [];
  let i = oldLines.length;
  let j = newLines.length;
  while (i > 0 && j > 0) {
    if (oldLines[i - 1] === newLines[j - 1]) {
      ops.push({ type: ' ', line: oldLines[i - 1] });
      i -= 1;
      j -= 1;
    } else if (dp[i - 1][j] >= dp[i][j - 1]) {
      ops.push({ type: '-', line: oldLines[i - 1] });
      i -= 1;
    } else {
      ops.push({ type: '+', line: newLines[j - 1] });
      j -= 1;
    }
  }
  while (i > 0) {
    ops.push({ type: '-', line: oldLines[i - 1] });
    i -= 1;
  }
  while (j > 0) {
    ops.push({ type: '+', line: newLines[j - 1] });
    j -= 1;
  }
  const reversed = ops.reverse();
  // Keep a conventional diff shape: deletions before additions within a change block.
  const normalized = [];
  let index = 0;
  while (index < reversed.length) {
    if (reversed[index].type === ' ') {
      normalized.push(reversed[index]);
      index += 1;
      continue;
    }
    const deletions = [];
    const additions = [];
    while (index < reversed.length && reversed[index].type !== ' ') {
      (reversed[index].type === '-' ? deletions : additions).push(reversed[index]);
      index += 1;
    }
    normalized.push(...deletions, ...additions);
  }
  return normalized;
}

function buildPatch({ file, line, search, replace, text }) {
  const lines = text.split('\n');
  const oldLines = splitLines(search);
  const newLines = splitLines(replace);
  const beforeStart = Math.max(0, line - 1 - 2);
  const before = lines.slice(beforeStart, line - 1);
  const afterStart = line - 1 + oldLines.length;
  const after = lines.slice(afterStart, afterStart + 2);
  const hunkStart = beforeStart + 1;
  const ops = diffLines(oldLines, newLines);
  return [
    `--- a/${file}`,
    `+++ b/${file}`,
    `@@ -${hunkStart},${before.length + oldLines.length + after.length} +${hunkStart},${before.length + newLines.length + after.length} @@`,
    ...before.map((item) => ` ${item}`),
    ...ops.map((op) => `${op.type}${op.line}`),
    ...after.map((item) => ` ${item}`),
  ].join('\n');
}

function buildCreatePatch(file, content) {
  const lines = String(content ?? '').replace(/\r\n/g, '\n').split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return [
    '--- /dev/null',
    `+++ b/${file}`,
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines.map((line) => `+${line}`),
  ].join('\n');
}

function buildDeletePatch(file, text) {
  const lines = splitLines(text);
  return [
    `--- a/${file}`,
    '+++ /dev/null',
    `@@ -1,${lines.length} +0,0 @@`,
    ...lines.map((line) => `-${line}`),
  ].join('\n');
}

/**
 * Build a read-only diff preview for a structured fix. Never writes files.
 *
 * @param {any} item
 * @param {{
 *   sourceRoot?: string | null,
 *   frontendSourceRoot?: string | null,
 *   extraSourceRoots?: Array<{ id: string, root: string }>
 * }} roots
 */
export async function buildFixPreview(item, {
  sourceRoot = null,
  frontendSourceRoot = null,
  extraSourceRoots = [],
  staticChecks = 'strict',
} = {}) {
  const fix = normalizeFix(item);
  if (!fix) return null;
  const file = fix.file.replace(/\\/g, '/');
  const roots = { sourceRoot, frontendSourceRoot, extraSourceRoots };

  if (fix.kind === 'text') {
    return { ...fix, preview: { status: 'no-edit', message: '仅文字建议，未提供可预览的代码修改' } };
  }

  if (fix.kind === 'create') {
    if (!fix.content) {
      return { ...fix, preview: { status: 'error', message: '新建文件的 content 不能为空' } };
    }
    const target = await resolveFixDestination(fix, roots);
    if (target.error) return { ...fix, preview: { status: 'error', message: target.error } };
    return {
      ...fix,
      root: target.name,
      preview: {
        status: 'ready',
        line: 1,
        patch: buildCreatePatch(file, fix.content),
        message: '可预览（新建文件）',
      },
    };
  }

  if (fix.kind === 'delete') {
    const target = await resolveFixTarget(fix, roots);
    if (target.error) return { ...fix, preview: { status: 'error', message: target.error } };
    let text;
    let hash;
    try {
      ({ text, hash } = await readText(target.resolved));
    } catch (error) {
      return {
        ...fix,
        root: target.name,
        preview: { status: 'error', message: `读取文件失败：${error?.message ?? error}` },
      };
    }
    if (fix.baseHash && hash !== fix.baseHash) {
      return {
        ...fix,
        root: target.name,
        preview: {
          status: 'error',
          message: '文件在诊断后已被修改，不能安全删除；请重新诊断。',
        },
      };
    }
    return {
      ...fix,
      root: target.name,
      preview: {
        status: 'ready',
        line: 1,
        patch: buildDeletePatch(file, text),
        message: '可预览（删除文件）',
      },
    };
  }

  if (!fix.search) {
    return { ...fix, preview: { status: 'error', message: 'search 片段不能为空' } };
  }

  const target = await resolveFixTarget(fix, roots);
  if (target.error) return { ...fix, preview: { status: 'error', message: target.error } };

  let text;
  let hash;
  try {
    ({ text, hash } = await readText(target.resolved));
  } catch (error) {
    return {
      ...fix,
      root: target.name,
      preview: { status: 'error', message: `读取文件失败：${error?.message ?? error}` },
    };
  }

  if (fix.baseHash && hash !== fix.baseHash) {
    return {
      ...fix,
      root: target.name,
      preview: {
        status: 'error',
        message: '文件在诊断后已被修改，补丁基于旧版本；请重新诊断或手动合并。',
      },
    };
  }

  const occurrences = countOccurrences(text, fix.search);
  if (occurrences === 0) {
    return {
      ...fix,
      root: target.name,
      preview: { status: 'error', message: '未在文件中找到 search 片段（文件可能已被修改）' },
    };
  }
  if (occurrences > 1) {
    return {
      ...fix,
      root: target.name,
      preview: { status: 'error', message: `search 片段在文件中出现 ${occurrences} 次，无法唯一定位` },
    };
  }
  if (fix.search === fix.replace) {
    return { ...fix, root: target.name, preview: { status: 'no-change', message: '修改前后内容相同' } };
  }

  const index = text.indexOf(fix.search);
  const updated = text.slice(0, index) + fix.replace + text.slice(index + fix.search.length);
  const warnings = [];
  if (staticChecks !== 'off') {
    const loggerIssue = inspectLoggerUsage({ original: text, updated, replacement: fix.replace });
    if (loggerIssue) {
      if (staticChecks === 'strict') {
        return { ...fix, root: target.name, preview: { status: 'error', message: loggerIssue } };
      }
      warnings.push(loggerIssue);
    }
    const missingMethodIssue = await inspectMissingMethods({
      original: text,
      updated,
      replacement: fix.replace,
      sourceRoot: target.root,
    });
    if (missingMethodIssue) {
      if (staticChecks === 'strict') {
        return { ...fix, root: target.name, preview: { status: 'error', message: missingMethodIssue } };
      }
      warnings.push(missingMethodIssue);
    }
  }

  const line = text.slice(0, index).split('\n').length;
  const patch = buildPatch({ file, line, search: fix.search, replace: fix.replace, text });
  return {
    ...fix,
    root: target.name,
    preview: {
      status: 'ready',
      line,
      occurrences,
      patch,
      message: warnings.length > 0 ? '可预览（有静态告警）' : '可预览',
      ...(warnings.length > 0 ? { warnings } : {}),
    },
  };
}

/** Build a preview directly from baseline/current text, without reading the file. */
export function previewFixFromTexts(fixItem, original, updated) {
  const fix = normalizeFix(fixItem);
  if (!fix) return null;
  const file = fix.file.replace(/\\/g, '/');
  if (fix.kind === 'create') {
    return {
      ...fix,
      preview: {
        status: 'ready',
        line: 1,
        patch: buildCreatePatch(file, updated ?? fix.content ?? ''),
        message: '可预览（新建文件）',
      },
    };
  }
  if (fix.kind === 'delete') {
    return {
      ...fix,
      preview: {
        status: 'ready',
        line: 1,
        patch: buildDeletePatch(file, original ?? ''),
        message: '可预览（删除文件）',
      },
    };
  }
  if (fix.kind !== 'edit') {
    return { ...fix, preview: { status: 'no-edit', message: '仅文字建议，未提供可预览的代码修改' } };
  }
  return {
    ...fix,
    preview: {
      status: 'ready',
      line: 1,
      occurrences: 1,
      patch: buildPatch({
        file,
        line: 1,
        search: original ?? '',
        replace: updated ?? '',
        text: original ?? '',
      }),
      message: '可预览',
    },
  };
}

/**
 * Normalize and preview a list of fixes. Previewing is capped to avoid reading many files.
 *
 * @param {any} value
 * @param {{
 *   sourceRoot?: string | null,
 *   frontendSourceRoot?: string | null,
 *   extraSourceRoots?: Array<{ id: string, root: string }>,
 *   maxFixes?: number
 * }} [options]
 */
export async function buildFixPreviews(value, options = {}) {
  const fixes = normalizeFixList(value);
  const maxFixes = options.maxFixes ?? 5;
  return Promise.all(fixes.map((fix, index) => (
    index < maxFixes
      ? buildFixPreview(fix, options)
      : Promise.resolve({ ...fix, preview: { status: 'skipped', message: '超出预览数量上限' } })
  )));
}
