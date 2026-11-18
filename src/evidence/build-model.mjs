import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { AppError } from '../core/errors.mjs';
import { inside, isSensitivePath, normalizePath, resolveWithinRoot } from '../core/path-policy.mjs';

const MAX_FILE_BYTES = 512 * 1024;
const MAX_MODULES = 200;
const MAX_POMS = 200;

export function resolveBuildProbeRoot({ sourceRoot, configured = '', root = process.cwd() } = {}) {
  if (configured && String(configured).trim()) return path.resolve(root, String(configured).trim());
  return sourceRoot ? path.dirname(path.resolve(sourceRoot)) : null;
}

function stripXmlComments(text) {
  return String(text ?? '').replace(/<!--[\s\S]*?-->/g, '');
}

function firstTag(xml, name) {
  const match = String(xml).match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i'));
  return match ? match[1].trim() : null;
}

function modulesFromPom(xml) {
  const block = firstTag(xml, 'modules');
  if (!block) return [];
  return [...block.matchAll(/<module(?:\s[^>]*)?>([\s\S]*?)<\/module>/gi)]
    .map((match) => match[1].trim())
    .filter(Boolean);
}

function parsePom(xml) {
  const clean = stripXmlComments(xml);
  const parentBlock = firstTag(clean, 'parent');
  const parent = parentBlock
    ? {
        groupId: firstTag(parentBlock, 'groupId'),
        artifactId: firstTag(parentBlock, 'artifactId'),
        version: firstTag(parentBlock, 'version'),
      }
    : null;
  const own = clean.replace(/<parent(?:\s[^>]*)?>[\s\S]*?<\/parent>/i, '');
  return {
    groupId: firstTag(own, 'groupId'),
    artifactId: firstTag(own, 'artifactId'),
    version: firstTag(own, 'version'),
    parent,
    modules: modulesFromPom(own),
  };
}

function decodeIdeUrl(value, { probeRoot, moduleDir = probeRoot } = {}) {
  let text = String(value ?? '').trim();
  if (!text) return null;
  text = text.replace(/\$PROJECT_DIR\$/g, normalizePath(probeRoot)).replace(/\$MODULE_DIR\$/g, normalizePath(moduleDir));
  if (text.startsWith('file:')) {
    text = text.replace(/^file:\/\//, '');
    if (/^\/[A-Za-z]:\//.test(text)) text = text.slice(1);
    try {
      text = decodeURIComponent(text);
    } catch {
      // Keep the raw path when percent-decoding fails.
    }
  }
  return normalizePath(text);
}

function parseModulesXml(xml, { probeRoot } = {}) {
  const modules = [];
  for (const match of String(xml ?? '').matchAll(/<module\b([^>]*)\/?>/gi)) {
    const attrs = match[1];
    const filePath = attrs.match(/\bfilepath="([^"]+)"/i)?.[1]
      ?? attrs.match(/\bfileurl="([^"]+)"/i)?.[1]
      ?? null;
    if (!filePath) continue;
    const decoded = decodeIdeUrl(filePath, { probeRoot });
    if (!decoded) continue;
    const relative = path.isAbsolute(decoded) ? path.relative(probeRoot, decoded) : decoded;
    const normalized = normalizePath(relative);
    if (!normalized || normalized.startsWith('..')) continue;
    modules.push({
      name: path.basename(normalized, '.iml'),
      path: normalized,
    });
  }
  return modules.slice(0, MAX_MODULES);
}

function parseIml(xml, { probeRoot, modulePath } = {}) {
  const moduleDir = path.dirname(path.resolve(probeRoot, modulePath));
  const sourceFolders = [];
  const outputFolders = [];
  for (const match of String(xml ?? '').matchAll(/<sourceFolder\b([^>]*)\/?>/gi)) {
    const url = decodeIdeUrl(match[1].match(/\burl="([^"]+)"/i)?.[1], { probeRoot, moduleDir });
    if (url) sourceFolders.push(normalizePath(path.isAbsolute(url) ? path.relative(probeRoot, url) : url));
  }
  for (const match of String(xml ?? '').matchAll(/<output\b([^>]*)\/?>/gi)) {
    const url = decodeIdeUrl(match[1].match(/\burl="([^"]+)"/i)?.[1], { probeRoot, moduleDir });
    if (url) outputFolders.push(normalizePath(path.isAbsolute(url) ? path.relative(probeRoot, url) : url));
  }
  return { sourceFolders, outputFolders };
}

async function safeRead(probeRoot, relative) {
  if (!relative) return null;
  const normalized = normalizePath(relative);
  if (!normalized || normalized.startsWith('..') || path.isAbsolute(normalized)) return null;
  if (isSensitivePath(normalized)) return null;
  const lower = normalized.toLowerCase();
  const allowed = lower.endsWith('/pom.xml')
    || lower === 'pom.xml'
    || lower === '.idea/modules.xml'
    || lower.endsWith('.iml');
  if (!allowed) return null;
  try {
    const resolved = await resolveWithinRoot(probeRoot, normalized, { allowMissing: true });
    if (!resolved.info || !resolved.info.isFile() || resolved.info.size > MAX_FILE_BYTES) return null;
    return { path: normalized, text: await readFile(resolved.absolute, 'utf8'), mtime: resolved.info.mtime.toISOString() };
  } catch {
    return null;
  }
}

async function fileInfo(probeRoot, relative) {
  try {
    const resolved = await resolveWithinRoot(probeRoot, relative, { allowMissing: true });
    if (!resolved.info) return null;
    return { exists: true, isDirectory: resolved.info.isDirectory(), mtime: resolved.info.mtime.toISOString() };
  } catch {
    return null;
  }
}

async function realpathOr(value) {
  try {
    return await realpath(value);
  } catch {
    return path.resolve(value);
  }
}

export async function inspectBuildModel({ sourceRoot, probeRoot, rootLabel = 'backend' } = {}) {
  if (!sourceRoot) throw new AppError('SOURCE_ROOT_REQUIRED', 'source root is not configured', { exitCode: 3 });
  const realSource = await realpathOr(sourceRoot);
  const realProbe = probeRoot ? await realpathOr(probeRoot) : path.dirname(realSource);
  if (!inside(realProbe, realSource)) {
    throw new AppError('BUILD_PROBE_ROOT_INVALID', 'build probe root must contain the configured source root', { exitCode: 2 });
  }
  if (path.dirname(realProbe) === realProbe) {
    throw new AppError('BUILD_PROBE_ROOT_INVALID', 'filesystem root cannot be used as a build probe root', { exitCode: 2 });
  }
  const sourceRelative = normalizePath(path.relative(realProbe, realSource)) || '.';
  const pomCandidates = [];
  if (sourceRelative !== '.') pomCandidates.push(path.posix.join(sourceRelative, 'pom.xml'));
  pomCandidates.push('pom.xml');
  const seenPoms = new Set();
  const poms = [];
  const limitations = [];
  for (const candidate of pomCandidates) {
    if (seenPoms.has(candidate)) continue;
    seenPoms.add(candidate);
    const file = await safeRead(realProbe, candidate);
    if (!file) continue;
    const parsed = parsePom(file.text);
    poms.push({ path: file.path, mtime: file.mtime, ...parsed });
    for (const module of parsed.modules) {
      const modulePom = path.posix.join(module.replace(/\\/g, '/'), 'pom.xml');
      if (seenPoms.has(modulePom)) continue;
      seenPoms.add(modulePom);
      const moduleFile = await safeRead(realProbe, modulePom);
      if (!moduleFile) continue;
      const moduleParsed = parsePom(moduleFile.text);
      poms.push({ path: moduleFile.path, mtime: moduleFile.mtime, ...moduleParsed });
      if (poms.length >= MAX_POMS) break;
    }
    if (poms.length >= MAX_POMS) break;
  }

  const ideFile = await safeRead(realProbe, '.idea/modules.xml');
  let ide = null;
  if (ideFile) {
    const modules = parseModulesXml(ideFile.text, { probeRoot: realProbe });
    const moduleDetails = [];
    for (const module of modules.slice(0, MAX_MODULES)) {
      const file = await safeRead(realProbe, module.path);
      const parsed = file ? parseIml(file.text, { probeRoot: realProbe, modulePath: module.path }) : { sourceFolders: [], outputFolders: [] };
      moduleDetails.push({ ...module, ...parsed, mtime: file?.mtime ?? null });
    }
    ide = { type: 'intellij', modulesFile: ideFile.path, mtime: ideFile.mtime, modules: moduleDetails };
  }

  const latestPomMtime = poms.reduce((latest, pom) => {
    const time = Date.parse(pom.mtime);
    return Number.isFinite(time) && time > latest ? time : latest;
  }, 0);
  const staleHints = [];
  if (ide && latestPomMtime > 0 && Date.parse(ide.mtime) < latestPomMtime) {
    staleHints.push({ kind: 'ide-older-than-pom', detail: '.idea/modules.xml 早于最新 pom.xml' });
  }
  const pomModuleNames = new Set();
  for (const pom of poms) {
    for (const module of pom.modules) pomModuleNames.add(path.posix.basename(module.replace(/\\/g, '/')));
  }
  if (ide) {
    const ideNames = new Set(ide.modules.map((module) => module.name));
    for (const name of pomModuleNames) {
      if (!ideNames.has(name)) staleHints.push({ kind: 'pom-module-missing-in-ide', detail: name });
    }
    for (const module of ide.modules) {
      if (!pomModuleNames.has(module.name)) staleHints.push({ kind: 'ide-module-missing-in-pom', detail: module.name });
      const info = await fileInfo(realProbe, module.path);
      if (!info) staleHints.push({ kind: 'module-path-missing', detail: module.path });
      for (const folder of module.sourceFolders) {
        const dir = await fileInfo(realProbe, folder);
        if (!dir || !dir.isDirectory) staleHints.push({ kind: 'source-folder-missing', detail: `${module.name}:${folder}` });
      }
    }
    const sourceModule = sourceRelative === '.' ? null : path.posix.basename(sourceRelative);
    if (sourceModule && !ide.modules.some((module) => module.name === sourceModule || module.path.startsWith(sourceRelative))) {
      staleHints.push({ kind: 'source-root-missing-in-ide', detail: sourceRelative });
    }
  }
  limitations.push('P0 只解析 Maven POM 与 IntelliJ modules.xml/iml；未执行 mvn help:effective-pom');
  limitations.push('不读取 .idea/workspace.xml 或同级其他源码');
  return {
    root: rootLabel,
    sourceRoot: sourceRelative,
    probeRoot: '.',
    poms,
    ide,
    staleHints,
    limitations,
  };
}
