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
    || lower.endsWith('.iml')
    || ['settings.gradle', 'settings.gradle.kts', 'build.gradle', 'build.gradle.kts', 'gradle.properties', 'gradle/libs.versions.toml', 'gradle/wrapper/gradle-wrapper.properties'].includes(lower)
    || ['package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'node_modules/.package-lock.json', 'tsconfig.json'].includes(lower);
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

function parseGradleModules(text) {
  const modules = new Set();
  for (const line of String(text ?? '').split(/\r?\n/)) {
    if (!/\binclude\b/.test(line)) continue;
    for (const match of line.matchAll(/['"]([^'"]+)['"]/g)) {
      const name = match[1].replace(/^:/, '').replace(/:/g, '/');
      if (name) modules.add(name);
    }
  }
  return [...modules].slice(0, MAX_MODULES);
}

async function readGradleProbe(realProbe) {
  const settings = await safeRead(realProbe, 'settings.gradle')
    ?? await safeRead(realProbe, 'settings.gradle.kts');
  const build = await safeRead(realProbe, 'build.gradle')
    ?? await safeRead(realProbe, 'build.gradle.kts');
  if (!settings && !build) return null;
  const properties = await safeRead(realProbe, 'gradle.properties');
  const catalog = await safeRead(realProbe, 'gradle/libs.versions.toml');
  const wrapper = await safeRead(realProbe, 'gradle/wrapper/gradle-wrapper.properties');
  const wrapperScript = (await fileInfo(realProbe, 'gradlew')) ?? (await fileInfo(realProbe, 'gradlew.bat'));
  const modules = settings ? parseGradleModules(settings.text) : [];
  const mtimes = [settings?.mtime, build?.mtime, properties?.mtime, catalog?.mtime, wrapper?.mtime]
    .filter(Boolean)
    .map((value) => Date.parse(value))
    .filter((value) => Number.isFinite(value));
  return {
    type: 'gradle',
    settingsFile: settings?.path ?? null,
    settingsMtime: settings?.mtime ?? null,
    buildFile: build?.path ?? null,
    buildMtime: build?.mtime ?? null,
    modules,
    wrapper: wrapper || wrapperScript
      ? { properties: wrapper?.path ?? null, mtime: wrapper?.mtime ?? null, script: Boolean(wrapperScript) }
      : null,
    properties: properties ? { path: properties.path, mtime: properties.mtime } : null,
    versionCatalog: catalog ? { path: catalog.path, mtime: catalog.mtime } : null,
    mtime: mtimes.length > 0 ? new Date(Math.max(...mtimes)).toISOString() : null,
  };
}

async function readFrontendProbe(realProbe) {
  const pkg = await safeRead(realProbe, 'package.json');
  if (!pkg) return null;
  let data = null;
  try {
    data = JSON.parse(pkg.text);
  } catch {
    data = null;
  }
  const lockCandidates = await Promise.all([
    fileInfo(realProbe, 'package-lock.json'),
    fileInfo(realProbe, 'pnpm-lock.yaml'),
    fileInfo(realProbe, 'yarn.lock'),
  ]);
  const lockNames = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock'];
  let lockfile = null;
  for (let index = 0; index < lockCandidates.length; index += 1) {
    const info = lockCandidates[index];
    if (info?.exists) {
      lockfile = { path: lockNames[index], mtime: info.mtime };
      break;
    }
  }
  const nodeModules = await fileInfo(realProbe, 'node_modules');
  const nodeModulesLock = await fileInfo(realProbe, 'node_modules/.package-lock.json');
  const tsconfig = await fileInfo(realProbe, 'tsconfig.json');
  const packageTime = Date.parse(pkg.mtime);
  const lockTime = lockfile ? Date.parse(lockfile.mtime) : null;
  const installTime = nodeModulesLock ? Date.parse(nodeModulesLock.mtime) : null;
  const staleHints = [];
  if (lockfile && Number.isFinite(packageTime) && Number.isFinite(lockTime) && packageTime > lockTime) {
    staleHints.push({ kind: 'package-json-newer-than-lock', detail: 'package.json 晚于 lockfile' });
  }
  if (lockfile && Number.isFinite(lockTime) && nodeModules?.isDirectory
    && installTime && Number.isFinite(installTime) && lockTime > installTime) {
    staleHints.push({ kind: 'lockfile-newer-than-node-modules', detail: 'lockfile 晚于 node_modules 安装记录' });
  }
  if (!nodeModules?.isDirectory) {
    staleHints.push({ kind: 'node-modules-missing', detail: 'node_modules 不存在' });
  }
  return {
    type: 'frontend',
    packageFile: pkg.path,
    packageMtime: pkg.mtime,
    name: data?.name ?? null,
    packageManager: data?.packageManager ?? null,
    workspaces: Array.isArray(data?.workspaces) ? data.workspaces.length : 0,
    dependencyCount: data?.dependencies ? Object.keys(data.dependencies).length : 0,
    devDependencyCount: data?.devDependencies ? Object.keys(data.devDependencies).length : 0,
    lockfile,
    nodeModules: nodeModules?.isDirectory ?? false,
    nodeModulesLockMtime: nodeModulesLock?.mtime ?? null,
    tsconfig: Boolean(tsconfig?.exists),
    staleHints,
  };
}

export async function inspectBuildModel({ sourceRoot, probeRoot, rootLabel = 'backend', mode = 'auto' } = {}) {
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

  const gradle = mode === 'frontend' ? null : await readGradleProbe(realProbe);
  const frontend = mode === 'backend' ? null : await readFrontendProbe(realProbe);
  const staleHints = [];
  const latestPomMtime = poms.reduce((latest, pom) => {
    const time = Date.parse(pom.mtime);
    return Number.isFinite(time) && time > latest ? time : latest;
  }, 0);
  const latestGradleMtime = gradle?.mtime ? Date.parse(gradle.mtime) : 0;
  const latestBuildMtime = Math.max(latestPomMtime, Number.isFinite(latestGradleMtime) ? latestGradleMtime : 0);
  if (ide && latestBuildMtime > 0 && Date.parse(ide.mtime) < latestBuildMtime) {
    const gradleNewest = gradle && latestGradleMtime >= latestPomMtime;
    staleHints.push({
      kind: gradleNewest ? 'ide-older-than-gradle' : 'ide-older-than-pom',
      detail: gradleNewest ? '.idea/modules.xml 早于最新 Gradle 构建文件' : '.idea/modules.xml 早于最新 pom.xml',
    });
  }
  const pomModuleNames = new Set();
  for (const pom of poms) {
    for (const module of pom.modules) pomModuleNames.add(path.posix.basename(module.replace(/\\/g, '/')));
  }
  const gradleModuleNames = new Set((gradle?.modules ?? []).map((module) => path.posix.basename(module)));
  const buildModuleNames = new Set([...pomModuleNames, ...gradleModuleNames]);
  if (ide) {
    const ideNames = new Set(ide.modules.map((module) => module.name));
    for (const name of pomModuleNames) {
      if (!ideNames.has(name)) staleHints.push({ kind: 'pom-module-missing-in-ide', detail: name });
    }
    for (const name of gradleModuleNames) {
      if (!ideNames.has(name)) staleHints.push({ kind: 'gradle-module-missing-in-ide', detail: name });
    }
    for (const module of ide.modules) {
      if (!buildModuleNames.has(module.name)) {
        staleHints.push({
          kind: poms.length > 0 ? 'ide-module-missing-in-pom' : 'ide-module-missing-in-build',
          detail: module.name,
        });
      }
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
  if (frontend) staleHints.push(...frontend.staleHints);
  const buildSystems = [
    poms.length > 0 ? 'maven' : null,
    gradle ? 'gradle' : null,
    frontend ? 'frontend' : null,
  ].filter(Boolean);
  limitations.push('P0 静态解析 POM/Gradle/package.json 与 IntelliJ modules.xml/iml；不执行构建命令');
  if (!gradle && mode !== 'frontend') limitations.push('未发现 Gradle settings/build 文件');
  if (!frontend && mode !== 'backend') limitations.push('未发现前端 package.json');
  limitations.push('不读取 .idea/workspace.xml 或同级其他源码');
  return {
    root: rootLabel,
    sourceRoot: sourceRelative,
    probeRoot: '.',
    buildSystem: buildSystems.length === 0 ? 'unknown' : (buildSystems.length === 1 ? buildSystems[0] : 'mixed'),
    poms,
    gradle,
    frontend,
    ide,
    staleHints,
    limitations,
  };
}
