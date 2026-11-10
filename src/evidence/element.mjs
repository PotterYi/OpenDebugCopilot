import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { walkSourceFiles } from './source.mjs';

const FRONTEND_EXTS = new Set(['.vue', '.tsx', '.jsx', '.ts', '.js', '.html']);
const GENERIC_CLASSES = new Set([
  'row', 'col', 'container', 'wrapper', 'content', 'item', 'list', 'table', 'form',
  'input', 'button', 'btn', 'text', 'title', 'label', 'value', 'active', 'disabled',
]);
const MAX_FILE_BYTES = 2 * 1024 * 1024;

async function readText(file) {
  try {
    const info = await stat(file);
    if (info.size > MAX_FILE_BYTES) return null;
    return await readFile(file, 'utf8');
  } catch {
    return null;
  }
}

function normalizeRoute(value) {
  return String(value ?? '').split('?')[0].replace(/\/+$/, '') || '/';
}

function routeTerms(route) {
  return normalizeRoute(route)
    .split('/')
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part && !['app', 'index', 'home', 'admin'].includes(part));
}

function collectSignals(element) {
  const attributes = element?.attributes ?? {};
  const text = String(element?.text ?? '').trim();
  const signals = {
    texts: text.length >= 2 ? [text.slice(0, 120)] : [],
    attributes: [],
    classes: [],
    route: routeTerms(element?.page?.route || element?.page?.url),
    componentName: element?.framework?.componentName ?? '',
  };
  for (const key of ['prop', 'placeholder', 'aria-label', 'name', 'id', 'label']) {
    const value = String(attributes[key] ?? '').trim();
    if (value.length >= 2) signals.attributes.push({ key, value: value.slice(0, 120) });
  }
  for (const name of element?.classes ?? []) {
    const textName = String(name);
    if (textName.startsWith('data-v-') || GENERIC_CLASSES.has(textName)) continue;
    if (/^(?:el|ant|van|iv|nut)-/.test(textName) && textName.length <= 12) continue;
    signals.classes.push(textName);
  }
  return signals;
}

function scoreFile(file, text, signals) {
  let score = 0;
  const matches = [];
  const relative = file.replace(/\\/g, '/').toLowerCase();
  const haystack = text.toLowerCase();
  for (const term of signals.route) {
    if (relative.includes(term)) {
      score += 3;
      matches.push(`route:${term}`);
    }
  }
  if (signals.route.length >= 2) {
    const pair = signals.route.slice(-2).join('/');
    if (relative.includes(pair)) {
      score += 5;
      matches.push(`route-pair:${pair}`);
    }
  }
  for (const item of signals.texts) {
    if (haystack.includes(item.toLowerCase())) {
      score += item.length >= 8 ? 7 : 4;
      matches.push(`text:${item.slice(0, 24)}`);
    }
  }
  for (const attr of signals.attributes) {
    if (haystack.includes(attr.value.toLowerCase())) {
      score += attr.key === 'prop' || attr.key === 'placeholder' ? 4 : 2;
      matches.push(`${attr.key}:${attr.value.slice(0, 24)}`);
    }
  }
  for (const cls of signals.classes) {
    if (haystack.includes(cls.toLowerCase())) {
      score += 1;
      matches.push(`class:${cls}`);
    }
  }
  if (signals.componentName && haystack.includes(signals.componentName.toLowerCase())) {
    score += 4;
    matches.push(`component:${signals.componentName}`);
  }
  const ext = path.extname(file).toLowerCase();
  if (ext === '.vue' || ext === '.tsx' || ext === '.jsx') score += 2;
  if (relative.includes('/views/') || relative.includes('/pages/')) score += 2;
  if (relative.includes('/components/')) score += 1;
  return { score, matches };
}

async function fallbackCandidates(element, searchRoot) {
  if (!searchRoot) return [];
  const files = (await walkSourceFiles(searchRoot)).filter((file) => (
    FRONTEND_EXTS.has(path.extname(file).toLowerCase())
  ));
  const signals = collectSignals(element);
  if (signals.texts.length === 0 && signals.attributes.length === 0 && signals.route.length === 0) {
    return [];
  }
  const candidates = [];
  for (const file of files) {
    if (candidates.length > 200) break;
    const text = await readText(file);
    if (!text) continue;
    const { score, matches } = scoreFile(file, text, signals);
    if (score <= 0) continue;
    candidates.push({
      file: path.relative(searchRoot, file).split(path.sep).join('/'),
      absolutePath: file,
      score,
      matches,
    });
  }
  candidates.sort((a, b) => b.score - a.score);
  return candidates.slice(0, 5);
}

function resolveImportBases(importPath, componentFile, searchRoot, frontendSourceRoot) {
  const text = String(importPath ?? '');
  if (!text) return [];
  if (text.startsWith('@/')) {
    const stripped = text.slice(2);
    return [...new Set([
      path.resolve(searchRoot, 'src', stripped),
      path.resolve(searchRoot, stripped),
      path.resolve(frontendSourceRoot ?? searchRoot, stripped),
    ])];
  }
  if (text.startsWith('.')) {
    return [path.resolve(path.dirname(componentFile), text)];
  }
  return [];
}

async function readImportFile(base) {
  for (const suffix of ['', '.js', '.ts', '.mjs', '/index.js', '/index.ts']) {
    const target = `${base}${suffix}`;
    const text = await readText(target);
    if (text !== null) return { file: target, text };
  }
  return null;
}

async function extractApiCalls(componentText, componentFile, searchRoot, frontendSourceRoot) {
  const calls = [];
  const seenUrls = new Set();
  const importPattern = /import\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"]/g;
  for (const match of componentText.matchAll(importPattern)) {
    const imported = match[1];
    const importPath = match[2];
    if (!/api|request|service/i.test(importPath)) continue;
    let loaded = null;
    for (const base of resolveImportBases(importPath, componentFile, searchRoot, frontendSourceRoot)) {
      loaded = await readImportFile(base);
      if (loaded) break;
    }
    if (!loaded) continue;
    for (const urlMatch of loaded.text.matchAll(/url\s*:\s*['"`]([^'"`]+)['"`]/g)) {
      const url = urlMatch[1];
      if (seenUrls.has(url)) continue;
      seenUrls.add(url);
      const tail = loaded.text.slice(urlMatch.index, urlMatch.index + 240);
      const method = /method\s*:\s*['"`](\w+)['"`]/i.exec(tail)?.[1] ?? 'GET';
      calls.push({
        url,
        method: method.toUpperCase(),
        apiFile: path.relative(searchRoot, loaded.file).split(path.sep).join('/'),
        imported: String(imported).replace(/\s+/g, ' ').trim().slice(0, 200),
      });
      if (calls.length >= 8) return calls;
    }
  }
  return calls;
}

async function backendCandidatesForApis(apis, backendSourceRoot) {
  const root = backendSourceRoot ? path.resolve(backendSourceRoot) : null;
  if (!root || apis.length === 0) return [];
  const files = (await walkSourceFiles(root)).filter((file) => (
    /\.(?:java|kt|cs|py|go|ts|js)$/i.test(file)
  ));
  const terms = [];
  for (const api of apis.slice(0, 4)) {
    const clean = String(api.url).split('?')[0];
    terms.push(clean);
    const parts = clean.split('/').filter(Boolean);
    if (parts.length >= 2) {
      // Controllers often split /system/user/list into @RequestMapping + @GetMapping.
      terms.push(`/${parts.slice(0, -1).join('/')}`);
      terms.push(parts.slice(-2).join('/'));
    }
  }
  const uniqueTerms = [...new Set(terms.filter((term) => term.length >= 3))];
  const candidates = [];
  for (const file of files) {
    const text = await readText(file);
    if (!text) continue;
    const haystack = text.toLowerCase();
    const matched = uniqueTerms.filter((term) => haystack.includes(term.toLowerCase()));
    if (matched.length === 0) continue;
    candidates.push({
      file: path.relative(root, file).split(path.sep).join('/'),
      matches: matched.slice(0, 3),
      score: Math.max(...matched.map((term) => term.length)),
    });
    if (candidates.length >= 50) break;
  }
  return candidates
    .sort((a, b) => b.score - a.score)
    .slice(0, 8)
    .map(({ score: _score, ...candidate }) => candidate);
}

/**
 * Enrich an element snapshot with fallback component candidates and a
 * deterministic frontend → API → backend candidate chain.
 */
export async function collectElementEvidence({
  element,
  frontendSourceRoot = null,
  frontendProjectRoot = null,
  backendSourceRoot = null,
} = {}) {
  const searchRoot = frontendProjectRoot ?? frontendSourceRoot;
  let componentCandidates = [];
  let componentFile = null;
  let componentText = null;

  const frameworkFile = element?.framework?.componentFile;
  if (frameworkFile) {
    const bases = [searchRoot, frontendSourceRoot].filter(Boolean);
    if (path.isAbsolute(frameworkFile)) bases.push(path.dirname(frameworkFile));
    if (bases.length === 0) bases.push(process.cwd());
    for (const base of bases) {
      const candidates = path.isAbsolute(frameworkFile)
        ? [frameworkFile]
        : [
            path.resolve(base, String(frameworkFile)),
            path.resolve(base, String(frameworkFile).replace(/^\/+/, '')),
          ];
      let found = false;
      for (const target of candidates) {
        const text = await readText(target);
        if (text === null) continue;
        componentCandidates = [{
          file: path.relative(searchRoot ?? base, target).split(path.sep).join('/'),
          absolutePath: target,
          score: 999,
          matches: ['framework'],
        }];
        componentFile = target;
        componentText = text;
        found = true;
        break;
      }
      if (found) break;
    }
  }

  if (componentCandidates.length === 0) {
    componentCandidates = await fallbackCandidates(element, searchRoot);
    const top = componentCandidates[0];
    if (top) {
      componentFile = top.absolutePath;
      componentText = await readText(componentFile);
    }
  }

  let source = null;
  if (componentFile && componentText !== null) {
    const base = searchRoot ?? path.dirname(componentFile);
    let relative = path.relative(base, componentFile).split(path.sep).join('/');
    if (relative.startsWith('..')) {
      relative = path.relative(frontendSourceRoot ?? base, componentFile).split(path.sep).join('/');
    }
    source = {
      file: relative,
      path: componentFile,
      content: componentText.slice(0, 12_000),
    };
  }

  const apiRoot = searchRoot ?? (componentFile ? path.dirname(componentFile) : null);
  const apis = componentText && componentFile && apiRoot
    ? await extractApiCalls(componentText, componentFile, apiRoot, frontendSourceRoot)
    : [];
  const backendCandidates = await backendCandidatesForApis(apis, backendSourceRoot);

  return {
    element: {
      ...element,
      source,
      componentCandidates,
      apiCandidates: apis,
      backendCandidates,
    },
  };
}
