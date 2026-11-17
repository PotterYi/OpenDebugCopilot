import { execFile } from 'node:child_process';
import { open, readdir, readFile, realpath, stat as statPath } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { inflateRawSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import iconv from 'iconv-lite';
import { AppError } from '../core/errors.mjs';

const exec = promisify(execFile);
const MAX_ROWS = 50;
const MAX_DECLARED_BYTES = 4 * 1024 * 1024;
const MAX_JAR_ENTRIES = 20_000;
const MAX_CD_BYTES = 16 * 1024 * 1024;
const JVM_TIMEOUT_MS = 5000;

const ALLOWED_PROPERTIES = new Set([
  'java.class.path',
  'java.home',
  'user.dir',
  'java.class.version',
  'sun.java.command',
  'loader.path',
]);

const IGNORED_CLASSIFIERS = new Set(['sources', 'javadoc', 'tests', 'test-sources', 'natives']);
const SKIP_CLASSIFIERS = new Set(['sources', 'javadoc', 'tests', 'test-sources']);
const PACKAGING_TYPES = new Set(['jar', 'war', 'pom', 'zip', 'aar', 'bundle', 'ejb', 'rar']);
const SCOPES = new Set(['compile', 'runtime', 'provided', 'test', 'system', 'import']);
const NON_RUNTIME_SCOPES = new Set(['test', 'provided', 'system']);

function decodeOutput(buffer) {
  if (!Buffer.isBuffer(buffer)) return String(buffer ?? '');
  const utf8 = buffer.toString('utf8');
  if (!utf8.includes('�')) return utf8;
  if (process.platform === 'win32') return iconv.decode(buffer, 'gbk');
  return utf8;
}

async function resolveJavaTool(name) {
  const exe = process.platform === 'win32' ? `${name}.exe` : name;
  const candidates = [name];
  if (process.env.JAVA_HOME) candidates.push(path.join(process.env.JAVA_HOME, 'bin', exe));
  try {
    const { stdout } = await exec(process.platform === 'win32' ? 'where' : 'which', ['java'], {
      timeout: 3000,
      windowsHide: true,
      encoding: 'utf8',
    });
    const javaPath = String(stdout).split(/\r?\n/).map((line) => line.trim()).find(Boolean);
    if (javaPath) candidates.push(path.join(path.dirname(javaPath), exe));
  } catch {
    // PATH lookup for java is best effort; direct candidates may still work.
  }
  return [...new Set(candidates)];
}

async function runJvmTool(name, args = []) {
  const candidates = await resolveJavaTool(name);
  for (const candidate of candidates) {
    try {
      const result = await exec(candidate, args, {
        timeout: JVM_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024,
        encoding: 'buffer',
      });
      return decodeOutput(result.stdout);
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        throw new AppError(
          'JVM_COMMAND_FAILED',
          `${name} 执行失败（${error?.code ?? 'unknown'}）；目标进程可能已退出或当前用户无权 attach`,
          { exitCode: 3, cause: error },
        );
      }
    }
  }
  throw new AppError(
    'JVM_TOOLS_UNAVAILABLE',
    `无法执行 ${name}；请安装 JDK，并把 JAVA_HOME/bin 或 JDK bin 加入 PATH`,
    { exitCode: 3 },
  );
}

async function runSystemTool(command, args) {
  try {
    const result = await exec(command, args, {
      timeout: 3000,
      windowsHide: true,
      maxBuffer: 2 * 1024 * 1024,
      encoding: 'utf8',
    });
    return String(result.stdout ?? '');
  } catch {
    return '';
  }
}

/** Parse `jps -l` output into pid/main-class rows, skipping jps itself. */
export function parseJpsOutput(text) {
  const processes = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const match = line.trim().match(/^(\d+)\s+(.+)$/);
    if (!match) continue;
    const pid = Number(match[1]);
    const mainClass = match[2].trim();
    if (!Number.isInteger(pid) || pid <= 0) continue;
    if (/sun\.tools\.jps\.Jps|jdk\.jcmd\/sun\.tools\.jps\.Jps/.test(mainClass)) continue;
    processes.push({ pid, mainClass });
  }
  return processes;
}

/** Split a classpath string without breaking Windows drive letters. */
export function splitClasspath(text) {
  const value = String(text ?? '').replace(/^﻿/, '').trim();
  if (!value) return [];
  let parts;
  if (value.includes(';')) {
    parts = value.split(';');
  } else {
    const lines = value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (lines.length === 1 && !/^[A-Za-z]:[\\/]/.test(lines[0]) && !lines[0].includes('://')) {
      parts = lines[0].split(':');
    } else {
      parts = lines;
    }
  }
  return parts
    .map((part) => part.trim().replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1'))
    .filter((part) => part && part !== '<no value>');
}

function looksLikeCoordinate(value) {
  if (!value.includes(':')) return false;
  if (/^[A-Za-z]:[\\/]/.test(value)) return false;
  if (value.includes('://')) return false;
  if (/[\\/]/.test(value) && !/^[^\/]+:[^\/]+:/.test(value)) return false;
  return true;
}

/** Parse a Maven/Gradle coordinate (`g:a:v`, `g:a:jar:v:scope`, ...). */
export function parseCoordinate(value) {
  const text = String(value ?? '').trim();
  if (!looksLikeCoordinate(text)) return null;
  const parts = text.split(':').map((part) => part.trim());
  if (parts.length < 2 || parts.some((part) => !part)) return null;
  if (parts.length >= 4 && PACKAGING_TYPES.has(parts[2].toLowerCase())) {
    const hasClassifier = parts.length >= 6;
    return {
      group: parts[0] || null,
      artifact: parts[1],
      version: hasClassifier ? parts[4] : parts[3],
      classifier: hasClassifier ? parts[3] : null,
      scope: hasClassifier ? parts[5] : parts[4] ?? null,
    };
  }
  if (parts.length >= 4) {
    return {
      group: parts[0] || null,
      artifact: parts[1],
      version: parts[2],
      classifier: SCOPES.has(parts[3]) ? null : parts[3],
      scope: SCOPES.has(parts[3]) ? parts[3] : null,
    };
  }
  if (parts.length === 3) {
    return { group: parts[0] || null, artifact: parts[1], version: parts[2], classifier: null };
  }
  return {
    group: null,
    artifact: parts[0],
    version: /^\d/.test(parts[1]) ? parts[1] : null,
    classifier: /^\d/.test(parts[1]) ? null : parts[1],
  };
}

function parseArtifactVersion(base) {
  let cut = -1;
  for (let index = 1; index < base.length - 1; index += 1) {
    if (base[index] === '-' && /\d/.test(base[index + 1])) cut = index;
  }
  if (cut <= 0) return { artifact: base, version: null };
  const tail = base.slice(cut + 1);
  if (!/^\d[\w.+-]*$/.test(tail)) return { artifact: base, version: null };
  return { artifact: base.slice(0, cut), version: tail };
}

/** Parse a jar filename into artifact/version/classifier (no group). */
export function parseJarFilename(file) {
  let base = String(file ?? '').replace(/^.*[\\/]/, '').replace(/\.(?:jar|zip)$/i, '');
  if (!base) return null;
  let classifier = null;
  for (const candidate of IGNORED_CLASSIFIERS) {
    if (base.endsWith(`-${candidate}`)) {
      classifier = candidate;
      base = base.slice(0, -candidate.length - 1);
      break;
    }
  }
  const timestamped = base.match(/^(.*)-(\d{8}\.\d{6}-\d+)$/);
  if (timestamped) {
    const inner = parseArtifactVersion(timestamped[1]);
    return {
      ...inner,
      version: inner.version ? `${inner.version}-SNAPSHOT` : null,
      classifier,
    };
  }
  return { ...parseArtifactVersion(base), classifier };
}

function coordinateFromRepositoryPath(value) {
  const normalized = String(value ?? '').replace(/\\/g, '/');
  const markers = ['/repository/', '/files-2.1/'];
  let rest = null;
  for (const marker of markers) {
    const index = normalized.lastIndexOf(marker);
    if (index >= 0) {
      rest = normalized.slice(index + marker.length);
      break;
    }
  }
  if (!rest) return null;
  const parts = rest.split('/').filter(Boolean);
  if (parts.length < 4) return null;
  const file = parts.at(-1) ?? '';
  if (!/\.(?:jar|zip)$/i.test(file)) return null;
  const gradleHash = parts.length >= 5 && /^[0-9a-f]{16,}$/i.test(parts.at(-2));
  const version = gradleHash ? parts.at(-3) : parts.at(-2);
  const artifact = gradleHash ? parts.at(-4) : parts.at(-3);
  const group = parts.slice(0, gradleHash ? -4 : -3).join('.');
  if (!group || !artifact || !version) return null;
  return { group, artifact, version };
}

export function normalizeVersion(version) {
  if (version === null || version === undefined || version === '') return null;
  const text = String(version).trim();
  const timestamped = text.match(/^(.+?)-\d{8}\.\d{6}-\d+$/);
  return timestamped ? `${timestamped[1]}-SNAPSHOT` : text;
}

/** Normalize a declared path/coordinate or runtime jar name to comparable metadata. */
export function normalizeArtifact(value) {
  const raw = String(value ?? '').trim().replace(/^"(.*)"$/, '$1');
  if (!raw) return null;
  if (raw.startsWith('file:')) {
    try {
      return normalizeArtifact(fileURLToPath(raw));
    } catch {
      return null;
    }
  }
  if (looksLikeCoordinate(raw)) {
    const parsed = parseCoordinate(raw);
    if (!parsed) return null;
    if (parsed.classifier && SKIP_CLASSIFIERS.has(parsed.classifier)) return null;
    return {
      raw,
      file: null,
      group: parsed.group,
      artifact: parsed.artifact,
      version: parsed.version ? normalizeVersion(parsed.version) : null,
      classifier: parsed.classifier,
      scope: parsed.scope ?? null,
    };
  }
  const name = raw.replace(/\\/g, '/').split('/').pop() ?? raw;
  if (!/\.(?:jar|zip)$/i.test(name)) return null;
  const fromName = parseJarFilename(name) ?? { artifact: name, version: null, classifier: null };
  if (fromName.classifier && SKIP_CLASSIFIERS.has(fromName.classifier)) return null;
  const fromPath = coordinateFromRepositoryPath(raw);
  return {
    raw,
    file: name,
    group: fromPath?.group ?? null,
    artifact: fromName.artifact || fromPath?.artifact || name,
    version: normalizeVersion(fromName.version ?? fromPath?.version ?? null),
    classifier: fromName.classifier ?? null,
  };
}

function artifactLabel(entry) {
  return entry.group ? `${entry.group}:${entry.artifact}` : entry.artifact;
}

function entryKey(entry) {
  return `${artifactLabel(entry)}:${entry.classifier ?? ''}`;
}

function entryText(entry) {
  return `${artifactLabel(entry)}:${entry.version ?? '?'}`;
}

function uniqueEntries(entries) {
  const seen = new Set();
  const out = [];
  for (const entry of entries) {
    if (!entry) continue;
    const key = `${entryKey(entry)}@${entry.version ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }
  return out;
}

/**
 * Diff declared vs runtime artifacts. Matching first uses group:artifact, then
 * falls back to artifact when one side has no group (e.g. bare jar filenames).
 */
export function diffClasspaths(declaredInput, runtimeInput, { limit = MAX_ROWS } = {}) {
  const declared = uniqueEntries(declaredInput);
  const runtime = uniqueEntries(runtimeInput);
  const declaredByKey = new Map();
  const runtimeByKey = new Map();
  const runtimeByArtifact = new Map();
  for (const entry of declared) {
    const key = entryKey(entry);
    if (!declaredByKey.has(key)) declaredByKey.set(key, []);
    declaredByKey.get(key).push(entry);
  }
  for (const entry of runtime) {
    const key = entryKey(entry);
    if (!runtimeByKey.has(key)) runtimeByKey.set(key, []);
    runtimeByKey.get(key).push(entry);
    const artifact = `${entry.artifact}:${entry.classifier ?? ''}`;
    if (!runtimeByArtifact.has(artifact)) runtimeByArtifact.set(artifact, []);
    runtimeByArtifact.get(artifact).push(key);
  }

  const matchedRuntimeKeys = new Set();
  const missing = [];
  const versionMismatch = [];
  for (const [key, declaredEntries] of declaredByKey) {
    let runtimeKey = runtimeByKey.has(key) ? key : null;
    if (!runtimeKey) {
      const artifact = `${declaredEntries[0].artifact}:${declaredEntries[0].classifier ?? ''}`;
      const candidates = [...new Set(runtimeByArtifact.get(artifact) ?? [])];
      if (candidates.length === 1) {
        runtimeKey = candidates[0];
      } else if (candidates.length > 1) {
        // The same artifact appears under different groups (or classifiers).
        // Prefer the candidate that actually carries the declared version.
        const declaredVersions = new Set(declaredEntries.map((entry) => entry.version).filter(Boolean));
        const versionMatch = candidates.find((candidate) => (runtimeByKey.get(candidate) ?? [])
          .some((entry) => entry.version && declaredVersions.has(entry.version)));
        if (versionMatch) runtimeKey = versionMatch;
      }
    }
    if (!runtimeKey) {
      for (const entry of declaredEntries) missing.push(entryText(entry));
      continue;
    }
    matchedRuntimeKeys.add(runtimeKey);
    const runtimeEntries = runtimeByKey.get(runtimeKey) ?? [];
    const declaredVersions = new Set(declaredEntries.map((entry) => entry.version).filter(Boolean));
    const runtimeVersions = new Set(runtimeEntries.map((entry) => entry.version).filter(Boolean));
    if (declaredVersions.size === 0 || runtimeVersions.size === 0) continue;
    const sameVersions = declaredVersions.size === runtimeVersions.size
      && [...declaredVersions].every((version) => runtimeVersions.has(version));
    if (sameVersions) continue;
    versionMismatch.push({
      artifact: artifactLabel(declaredEntries[0]),
      declared: [...declaredVersions].sort().join(', '),
      runtime: [...runtimeVersions].sort().join(', '),
    });
  }

  const runtimeOnly = [];
  for (const [key, entries] of runtimeByKey) {
    if (matchedRuntimeKeys.has(key)) continue;
    for (const entry of entries) runtimeOnly.push(entryText(entry));
  }

  const sortText = (items) => [...new Set(items)].sort((a, b) => a.localeCompare(b));
  const sortedMissing = sortText(missing);
  const sortedRuntimeOnly = sortText(runtimeOnly);
  const sortedMismatch = versionMismatch
    .sort((a, b) => a.artifact.localeCompare(b.artifact))
    .slice(0, limit);

  return {
    declaredCount: declared.length,
    runtimeCount: runtime.length,
    missing: sortedMissing.slice(0, limit),
    versionMismatch: sortedMismatch,
    runtimeOnly: sortedRuntimeOnly.slice(0, limit),
    truncated: {
      missing: sortedMissing.length > limit,
      versionMismatch: versionMismatch.length > limit,
      runtimeOnly: sortedRuntimeOnly.length > limit,
    },
  };
}

/** Parse JSON / Maven tree / classpath text / jar-file listings. */
export function parseDeclaredText(text) {
  const trimmed = String(text ?? '').replace(/^﻿/, '').trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed === 'string') return splitClasspath(parsed);
      const list = Array.isArray(parsed)
        ? parsed
        : parsed.files ?? parsed.classpath ?? parsed.jars ?? parsed.entries ?? null;
      if (Array.isArray(list)) return list.filter((item) => typeof item === 'string');
      return [];
    } catch {
      // Fall through to line parsing; the file may merely start with a bracket.
    }
  }

  const rows = trimmed.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  // Maven build-classpath output is one pathsep-separated line; split it before
  // treating each line as a single entry.
  if (rows.length === 1) {
    const split = splitClasspath(rows[0]);
    if (split.length > 1 && split.some((part) => /\.(?:jar|zip)$/i.test(part) || /[\\/]/.test(part))) {
      return split;
    }
  }
  const entries = [];
  // dependency:tree starts with the project itself (no branch marker). Skip it
  // so the project artifact is not reported as a missing runtime dependency.
  const treeLike = rows.some((row) => /(?:^|\s)(?:\||\+-|\\-)\s/.test(row));
  let rootLineSkipped = !treeLike;
  for (const row of rows) {
    const branchLine = row.replace(/^\[(?:INFO|DEBUG|WARN|ERROR)\]\s*/, '');
    const hasBranch = /^\s*(?:\||\+-|\\-)\s/.test(branchLine);
    const cleaned = branchLine.replace(/^[|+\\-\s]+/, '').trim();
    if (!cleaned || cleaned.startsWith('#') || cleaned.startsWith('---')) continue;
    const withoutComment = cleaned.replace(/\s+\(.*\)$/, '').trim();
    if (looksLikeCoordinate(withoutComment)) {
      const parsed = parseCoordinate(withoutComment);
      // Skip Maven plugin/goal headers such as "maven-dependency-plugin:3.6.0:tree".
      if (parsed && parsed.version && !/\d/.test(parsed.version)) continue;
      // test/provided/system artifacts are intentionally absent from most run
      // classpaths; including them would bury the real missing jars.
      if (parsed?.scope && NON_RUNTIME_SCOPES.has(parsed.scope)) continue;
      if (parsed) {
        if (!rootLineSkipped) {
          rootLineSkipped = true;
          if (!hasBranch) continue;
        }
        entries.push(withoutComment);
        continue;
      }
    }
    if (/\.(?:jar|zip)$/i.test(withoutComment)) {
      const split = splitClasspath(withoutComment);
      if (split.length > 1) entries.push(...split);
      else entries.push(withoutComment);
    }
  }
  if (entries.length > 0) return entries;
  const remaining = splitClasspath(trimmed);
  return remaining.some((part) => /\.(?:jar|zip)$/i.test(part) || /[\\/]/.test(part)) ? remaining : [];
}

/** Pick the whitelisted properties out of `jcmd <pid> VM.system_properties`. */
export function parseJcmdSystemProperties(text, allowed = ALLOWED_PROPERTIES) {
  const out = {};
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const match = line.match(/^([^=\s]+)=(.*)$/);
    if (!match) continue;
    if (!allowed.has(match[1])) continue;
    out[match[1]] = match[2].replace(/\\n/g, '\n').replace(/\\t/g, '\t');
  }
  return out;
}

/** Parse `jcmd <pid> VM.command_line`. */
export function parseJcmdCommandLine(text) {
  const result = { command: null, classPath: null };
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const command = line.match(/^java_command:\s*(.*)$/);
    if (command) {
      result.command = command[1].trim();
      continue;
    }
    const classPath = line.match(/^java_class_path\s*\(initial\):\s*(.*)$/i);
    if (classPath) result.classPath = classPath[1].trim();
  }
  return result;
}

/** Read and unfold a jar manifest Class-Path entry. */
export function parseManifestClassPath(text) {
  const unfolded = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    if ((line.startsWith(' ') || line.startsWith('\t')) && unfolded.length > 0) {
      unfolded[unfolded.length - 1] += line.trim();
    } else {
      unfolded.push(line);
    }
  }
  for (const line of unfolded) {
    const match = line.match(/^Class-Path:\s*(.*)$/i);
    if (!match) continue;
    return match[1].split(/\s+/).map((item) => item.trim()).filter(Boolean);
  }
  return [];
}

async function readSlice(handle, position, length) {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, position);
  return buffer.subarray(0, bytesRead);
}

/**
 * Read only the zip directory of a jar: nested libs plus manifest Class-Path.
 * Never returns file contents beyond the manifest, and never returns the path.
 */
export async function readJarMetadata(file) {
  let handle;
  try {
    handle = await open(file, 'r');
  } catch {
    return { error: 'JAR_UNREADABLE', libs: [], manifestClassPath: [], format: null, truncated: false };
  }
  try {
    const info = await handle.stat();
    if (info.size < 22) {
      return { error: 'JAR_INVALID', libs: [], manifestClassPath: [], format: null, truncated: false };
    }
    const tailSize = Math.min(info.size, 65_557 + 22);
    const tail = await readSlice(handle, info.size - tailSize, tailSize);
    let eocd = -1;
    for (let index = tail.length - 22; index >= 0; index -= 1) {
      if (tail.readUInt32LE(index) === 0x06054b50) {
        eocd = index;
        break;
      }
    }
    if (eocd < 0) {
      return { error: 'JAR_INVALID', libs: [], manifestClassPath: [], format: null, truncated: false };
    }
    const count = tail.readUInt16LE(eocd + 10);
    const cdSize = tail.readUInt32LE(eocd + 12);
    const cdOffset = tail.readUInt32LE(eocd + 16);
    if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
      return {
        error: 'JAR_ZIP64_UNSUPPORTED',
        libs: [],
        manifestClassPath: [],
        format: null,
        truncated: false,
      };
    }
    if (cdOffset + cdSize > info.size) {
      return { error: 'JAR_INVALID', libs: [], manifestClassPath: [], format: null, truncated: false };
    }
    const readSize = Math.min(cdSize, MAX_CD_BYTES);
    const cd = await readSlice(handle, cdOffset, readSize);
    const libs = [];
    let manifest = null;
    let hasSpringBoot = false;
    let hasWar = false;
    let offset = 0;
    let parsed = 0;
    while (offset + 46 <= cd.length && parsed < MAX_JAR_ENTRIES) {
      if (cd.readUInt32LE(offset) !== 0x02014b50) break;
      const method = cd.readUInt16LE(offset + 10);
      const compressedSize = cd.readUInt32LE(offset + 20);
      const nameLength = cd.readUInt16LE(offset + 28);
      const extraLength = cd.readUInt16LE(offset + 30);
      const commentLength = cd.readUInt16LE(offset + 32);
      const localOffset = cd.readUInt32LE(offset + 42);
      const name = cd.toString('utf8', offset + 46, offset + 46 + nameLength);
      parsed += 1;
      if (/^BOOT-INF\/lib\/[^/]+\.jar$/i.test(name)) {
        libs.push(name.split('/').pop());
        hasSpringBoot = true;
      } else if (/^BOOT-INF\/classes\//.test(name)) {
        hasSpringBoot = true;
      } else if (/^WEB-INF\/lib\/[^/]+\.jar$/i.test(name)) {
        libs.push(name.split('/').pop());
        hasWar = true;
      } else if (/^WEB-INF\/classes\//.test(name)) {
        hasWar = true;
      } else if (name === 'META-INF/MANIFEST.MF') {
        manifest = { method, compressedSize, localOffset };
      }
      offset += 46 + nameLength + extraLength + commentLength;
    }

    let manifestClassPath = [];
    if (manifest && manifest.compressedSize > 0 && manifest.compressedSize < 1024 * 1024) {
      try {
        const localHeader = await readSlice(handle, manifest.localOffset, 30);
        if (localHeader.length === 30 && localHeader.readUInt32LE(0) === 0x04034b50) {
          const nameLength = localHeader.readUInt16LE(26);
          const extraLength = localHeader.readUInt16LE(28);
          const dataOffset = manifest.localOffset + 30 + nameLength + extraLength;
          const bytes = await readSlice(handle, dataOffset, manifest.compressedSize);
          const content = manifest.method === 0 ? bytes : inflateRawSync(bytes);
          manifestClassPath = parseManifestClassPath(content.toString('utf8'));
        }
      } catch {
        // A broken manifest only removes one evidence source; nested libs remain valid.
      }
    }

    return {
      error: null,
      libs: [...new Set(libs)].sort((a, b) => a.localeCompare(b)),
      manifestClassPath,
      format: hasSpringBoot ? 'spring-boot-jar' : hasWar ? 'war-lib' : null,
      truncated: parsed >= MAX_JAR_ENTRIES || readSize < cdSize,
      entryCount: parsed,
    };
  } catch {
    return { error: 'JAR_INVALID', libs: [], manifestClassPath: [], format: null, truncated: false };
  } finally {
    await handle.close().catch(() => {});
  }
}

/** Resolve the PID listening on a local TCP port; only used to narrow jps rows. */
export async function findPortPids(port) {
  const numeric = Number(port);
  if (!Number.isInteger(numeric) || numeric <= 0 || numeric > 65535) return [];
  if (process.platform === 'win32') {
    const stdout = await runSystemTool('netstat', ['-ano', '-p', 'tcp']);
    const pids = new Set();
    for (const line of stdout.split(/\r?\n/)) {
      if (!/\bLISTENING\b/i.test(line)) continue;
      if (!new RegExp(`[:.]${numeric}\\s`).test(line)) continue;
      const match = line.trim().match(/(\d+)\s*$/);
      if (match) pids.add(Number(match[1]));
    }
    return [...pids];
  }
  if (process.platform === 'linux') {
    const stdout = await runSystemTool('ss', ['-ltnp']);
    const pids = new Set();
    for (const line of stdout.split(/\r?\n/)) {
      if (!new RegExp(`:${numeric}\\s`).test(line)) continue;
      for (const match of line.matchAll(/pid=(\d+)/g)) pids.add(Number(match[1]));
    }
    if (pids.size > 0) return [...pids];
  }
  const lsof = await runSystemTool('lsof', ['-nP', `-iTCP:${numeric}`, '-sTCP:LISTEN', '-t']);
  return [...new Set(lsof.split(/\r?\n/).map((line) => Number(line.trim())).filter(Number.isInteger))];
}

export async function listJavaProcesses({ port = null } = {}) {
  const stdout = await runJvmTool('jps', ['-l']);
  const all = parseJpsOutput(stdout);
  const targetPort = port === null || port === undefined || port === '' ? null : Number(port);
  if (targetPort !== null && (!Number.isInteger(targetPort) || targetPort < 1 || targetPort > 65535)) {
    throw new AppError('INVALID_PORT', 'port must be an integer between 1 and 65535', { exitCode: 2 });
  }
  let processes = all;
  if (targetPort !== null) {
    const allowed = new Set(await findPortPids(targetPort));
    processes = all.filter((process) => allowed.has(process.pid));
  }
  return {
    processes: processes.map((process) => {
      const launchedAsJar = /\.jar$/i.test(process.mainClass);
      return {
        pid: process.pid,
        // Never expose the absolute jar path; the basename is enough to pick a pid.
        mainClass: launchedAsJar ? path.basename(process.mainClass.replace(/\\/g, '/')) : process.mainClass,
        launchedAsJar,
      };
    }),
    count: processes.length,
    ...(targetPort === null ? {} : { port: targetPort }),
    ...(targetPort !== null && processes.length === 0
      ? { reason: `没有发现监听端口 ${targetPort} 的 Java 进程；可用 list_java_processes 不带 port 查看全部` }
      : {}),
  };
}

async function resolveDeclaredFile(input, allowRoots, cwd) {
  const requested = String(input ?? '').trim();
  if (!requested) {
    throw new AppError(
      'DECLARED_CLASSPATH_REQUIRED',
      'declaredFile is required；先用构建工具生成声明侧清单（例如 mvn dependency:build-classpath -Dmdep.includeScope=runtime -Dmdep.outputFile=target/classpath.txt）',
      { exitCode: 2 },
    );
  }
  const roots = [...new Set([...(allowRoots ?? []), cwd].filter(Boolean).map((root) => path.resolve(root)))];
  const candidates = path.isAbsolute(requested)
    ? [requested]
    : roots.map((root) => path.resolve(root, requested));
  let found = null;
  for (const candidate of candidates) {
    try {
      found = await realpath(candidate);
      break;
    } catch {
      // Try the next allowed root.
    }
  }
  if (!found) {
    throw new AppError(
      'DECLARED_CLASSPATH_NOT_FOUND',
      `未找到声明侧 classpath 文件：${requested}；请生成后放在源码根或当前 run 目录下`,
      { exitCode: 2 },
    );
  }
  const realRoots = [];
  for (const root of roots) {
    try {
      realRoots.push(await realpath(root));
    } catch {
      // A missing root cannot authorize anything.
    }
  }
  const inside = realRoots.some((root) => {
    const relative = path.relative(root, found);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  });
  if (!inside) {
    throw new AppError(
      'DECLARED_CLASSPATH_OUT_OF_SCOPE',
      '声明侧 classpath 只能读取源码根、run 目录或当前工作区内的文件',
      { exitCode: 2 },
    );
  }
  return found;
}

async function readDeclaredEntries(file) {
  const info = await statPath(file);
  if (info.isDirectory()) {
    const entries = await readdir(file, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && /\.(?:jar|zip)$/i.test(entry.name))
      .map((entry) => path.join(file, entry.name));
  }
  if (info.size > MAX_DECLARED_BYTES) {
    throw new AppError('DECLARED_CLASSPATH_TOO_LARGE', '声明侧 classpath 文件超过 4MB，请只保留依赖清单', {
      exitCode: 2,
    });
  }
  const buffer = await readFile(file);
  const text = decodeOutput(buffer);
  return parseDeclaredText(text).map((raw) => {
    if (path.isAbsolute(raw) || looksLikeCoordinate(raw)) return raw;
    return path.resolve(path.dirname(file), raw);
  });
}

function jarPathFromEntry(entry, baseDir) {
  if (!entry) return null;
  if (entry.startsWith('file:')) {
    try {
      return fileURLToPath(entry);
    } catch {
      return null;
    }
  }
  return path.isAbsolute(entry) ? entry : path.resolve(baseDir, entry);
}

/**
 * Collect the classpath visible to a local JVM and diff it against a declared
 * classpath file. Only the diff and aggregate counts reach the caller.
 */
export async function runtimeClasspath({
  pid = null,
  port = null,
  declaredFile,
  allowRoots = [],
  cwd = process.cwd(),
} = {}) {
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
    if (javaPids.length === 0) {
      throw new AppError('JVM_PROCESS_NOT_FOUND', `没有发现监听端口 ${port} 的 Java 进程`, { exitCode: 2 });
    }
    if (javaPids.length > 1) {
      return {
        candidates: javaPids.map((item) => ({ pid: item })),
        reason: `端口 ${port} 对应多个 Java 进程，请用 pid 指定其中一个`,
      };
    }
    targetPid = javaPids[0];
  }

  const processInfo = processes.find((process) => process.pid === targetPid);
  if (!processInfo) {
    throw new AppError(
      'JVM_PROCESS_NOT_FOUND',
      `pid ${targetPid} 不是当前可见的 Java 进程；先用 list_java_processes 查看`,
      { exitCode: 2 },
    );
  }

  const declaredPath = await resolveDeclaredFile(declaredFile, allowRoots, cwd);

  let commandLine = { command: null, classPath: null };
  let commandLineOk = false;
  let properties = {};
  let propertiesOk = false;
  try {
    commandLine = parseJcmdCommandLine(await runJvmTool('jcmd', [String(targetPid), 'VM.command_line']));
    commandLineOk = true;
  } catch {
    // Some JVMs restrict VM.command_line; VM.system_properties is the fallback.
  }
  try {
    properties = parseJcmdSystemProperties(
      await runJvmTool('jcmd', [String(targetPid), 'VM.system_properties']),
    );
    propertiesOk = true;
  } catch {
    // VM.command_line already gives the main class and java.class.path on most JDKs.
  }
  if (!commandLineOk && !propertiesOk) {
    throw new AppError(
      'JVM_INFO_UNAVAILABLE',
      `无法读取 pid ${targetPid} 的 JVM 信息（VM.command_line / VM.system_properties 均失败）`,
      { exitCode: 3 },
    );
  }

  const userDir = properties['user.dir'] || cwd;
  const mainCommand = commandLine.command || properties['sun.java.command'] || processInfo.mainClass;
  const mainToken = String(mainCommand ?? '')
    .trim()
    .split(/\s+/)[0]
    .replace(/^"(.*)"$/, '$1');
  const mainJarBase = /\.jar$/i.test(mainToken)
    ? path.basename(mainToken.replace(/\\/g, '/')).toLowerCase()
    : null;
  const sources = new Set();
  const limitations = [];
  const rawRuntime = [];
  const classDirs = [];

  function addClasspath(text, source) {
    const parts = splitClasspath(text);
    if (parts.length > 0) sources.add(source);
    for (const entry of parts) {
      const resolved = jarPathFromEntry(entry, userDir);
      if (!resolved) continue;
      if (/\.(?:jar|zip)$/i.test(resolved)) rawRuntime.push(resolved);
      else classDirs.push(resolved);
    }
  }

  if (commandLine.classPath) addClasspath(commandLine.classPath, 'java.class.path');
  else if (properties['java.class.path']) addClasspath(properties['java.class.path'], 'java.class.path');
  if (properties['loader.path']) {
    addClasspath(properties['loader.path'].split(',').join(path.delimiter), 'loader.path');
  }

  const runtimeEntries = [];
  const readJarQueue = [];
  const seenJars = new Map();
  const enqueueJar = (jarPath) => {
    let normalized;
    try {
      normalized = path.resolve(jarPath);
    } catch {
      return;
    }
    if (seenJars.has(normalized)) return;
    seenJars.set(normalized, normalizeArtifact(normalized));
    readJarQueue.push(normalized);
  };
  for (const jarPath of rawRuntime) enqueueJar(jarPath);

  let jarsRead = 0;
  while (readJarQueue.length > 0 && jarsRead < 500) {
    const jarPath = readJarQueue.shift();
    jarsRead += 1;
    const metadata = await readJarMetadata(jarPath);
    if (metadata.format) sources.add(metadata.format);
    if (metadata.truncated) {
      limitations.push(`jar ${path.basename(jarPath)} 的 zip 目录过大，只解析了前 20000 个条目`);
    }
    if (metadata.error === 'JAR_ZIP64_UNSUPPORTED') {
      limitations.push(`jar ${path.basename(jarPath)} 使用 zip64，未展开嵌套依赖`);
    }
    const isApplicationJar = metadata.format === 'spring-boot-jar'
      || metadata.format === 'war-lib'
      || (mainJarBase !== null && path.basename(jarPath).toLowerCase() === mainJarBase);
    if (!isApplicationJar) runtimeEntries.push(seenJars.get(jarPath));
    for (const lib of metadata.libs) {
      const parsed = normalizeArtifact(lib);
      if (parsed) {
        parsed.file = lib;
        runtimeEntries.push(parsed);
      }
    }
    if (metadata.manifestClassPath.length > 0) {
      sources.add('manifest-class-path');
      for (const raw of metadata.manifestClassPath) {
        const resolved = jarPathFromEntry(raw, path.dirname(jarPath));
        if (resolved && /\.(?:jar|zip)$/i.test(resolved)) enqueueJar(resolved);
      }
    }
  }

  const declaredRaw = await readDeclaredEntries(declaredPath);
  const declaredEntries = declaredRaw.map((raw) => normalizeArtifact(raw)).filter(Boolean);
  if (declaredEntries.length === 0) {
    throw new AppError(
      'DECLARED_CLASSPATH_EMPTY',
      '声明侧 classpath 文件中没有解析出 jar 依赖；支持 mvn dependency:build-classpath、dependency:tree、JSON 数组或 jar 目录',
      { exitCode: 2 },
    );
  }

  if (runtimeEntries.length === 0) {
    limitations.push('没有从目标 JVM 读取到 java.class.path / loader.path，运行侧为空');
  }
  const diff = diffClasspaths(declaredEntries, runtimeEntries);
  if (classDirs.length > 0) limitations.push(`${classDirs.length} 个 class 目录未参与 jar 差集`);
  limitations.push(
    '运行侧来自目标 JVM 的 java.class.path、loader.path、executable jar manifest 与 BOOT-INF/lib / WEB-INF/lib；自定义 ClassLoader 和动态加载的 jar 不可见',
  );

  const runtimeSources = [...sources];
  const mainClass = mainToken.replace(/\\/g, '/').split('/').pop();

  return {
    pid: targetPid,
    mainClass: mainClass || processInfo.mainClass,
    runtimeSource: runtimeSources[0] ?? 'java.class.path',
    runtimeSources,
    declaredFile: path.basename(declaredPath),
    declaredCount: diff.declaredCount,
    runtimeCount: diff.runtimeCount,
    classDirCount: classDirs.length,
    missing: diff.missing,
    versionMismatch: diff.versionMismatch,
    runtimeOnly: diff.runtimeOnly,
    truncated: diff.truncated,
    limitations,
  };
}
