import { mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { AppError } from '../core/errors.mjs';
import { newRunId } from '../core/ids.mjs';
import { resolveScenarioPaths } from '../core/scenario.mjs';
import { resolveFrontendSources } from '../evidence/frontend.mjs';
import { buildFixPreviews } from '../core/fixes.mjs';
import { resolveFrontendProjectRoot } from '../core/frontend-service.mjs';
import { fireScenario } from '../driver/index.mjs';
import { readLogs, listThreads } from '../evidence/logs.mjs';
import { correlateLogs, extractBusinessIds, extractTraceId } from '../evidence/correlate.mjs';
import { readSource } from '../evidence/source.mjs';
import { createTools } from '../tools/index.mjs';
import { runCapturePreflight, runPreflight } from '../doctor/preflight.mjs';
import { createMockAgent } from '../agent/mock.mjs';
import { buildReport, renderMarkdown } from '../report/report.mjs';
import { createRunLog } from './run-log.mjs';
import { evaluateRecheck } from './recheck.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function requestPathOf(url) {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return null;
  }
}
const DEFAULT_MARKER_TIMEOUT_MS = 2000;
const DEFAULT_POLL_INTERVAL_MS = 250;
const MAX_BODY_CHARS = 8000;
const MAX_SOURCE_CHARS = 4000;

const JAVA_FRAME = /^\s*at ([\w.$]+)\(([^():]+):(\d+)\)/;
const NODE_FRAME = /^\s*at .*\((.+):(\d+):(\d+)\)/;
const PY_FRAME = /^\s*File "(.+)", line (\d+)/;
const GO_FRAME = /^\s*[^\s(]+\(.*\)\s+(\S+\.go):(\d+)/;

function truncate(value, max = MAX_BODY_CHARS) {
  if (typeof value !== 'string' || value.length <= max) return value;
  return `${value.slice(0, max)}… (${value.length} chars)`;
}

function compactRecord(record) {
  return {
    ts: record.ts,
    level: record.level,
    thread: record.thread,
    message: record.message,
    stack: (record.stack ?? []).slice(0, 30),
    file: record.file ? path.basename(record.file) : null,
    lineNo: record.lineNo,
  };
}

function extractSourceHints(records) {
  const hints = new Map();
  for (const record of records) {
    for (const line of record.stack ?? []) {
      let match = line.match(JAVA_FRAME);
      if (match) {
        hints.set(`${match[1]}:${match[3]}`, { target: match[1], line: Number(match[3]) });
        continue;
      }
      match = line.match(NODE_FRAME);
      if (match) {
        hints.set(`${match[1]}:${match[2]}`, { target: match[1], line: Number(match[2]) });
        continue;
      }
      match = line.match(PY_FRAME);
      if (match) {
        hints.set(`${match[1]}:${match[2]}`, { target: match[1], line: Number(match[2]) });
        continue;
      }
      match = line.match(GO_FRAME);
      if (match) {
        hints.set(`${match[1]}:${match[2]}`, { target: match[1], line: Number(match[2]) });
      }
    }
  }
  return [...hints.values()].slice(0, 3);
}

async function collectSource(sourceRoot, records) {
  if (!sourceRoot) return { available: false, reason: 'source.root not declared', files: [] };
  const hints = extractSourceHints(records);
  if (hints.length === 0) return { available: true, files: [], hints: [] };
  const files = [];
  for (const hint of hints) {
    try {
      const result = await readSource({
        sourceRoot,
        target: hint.target,
        startLine: Math.max(1, hint.line - 5),
        endLine: hint.line + 20,
        maxLines: 40,
      });
      if (result.found) {
        files.push({
          target: hint.target,
          path: result.relativePath,
          startLine: result.startLine,
          endLine: result.endLine,
          content: truncate(result.content, MAX_SOURCE_CHARS),
        });
      } else {
        files.push({
          target: hint.target,
          found: false,
          reason: result.reason,
          candidates: (result.candidates ?? []).slice(0, 5),
        });
      }
    } catch (err) {
      files.push({ target: hint.target, found: false, reason: err?.code ?? 'read-failed' });
    }
  }
  return { available: true, hints, files };
}

async function waitForMarker({ logfiles, parser, encoding, anchor, window, marker, timeoutMs, intervalMs }) {
  if (!marker) return { matched: false, waitedMs: 0, result: null };
  const started = Date.now();
  let result = null;
  for (;;) {
    result = await readLogs({ logfiles, parser, encoding, anchor, window, marker, limit: 200 });
    if (result.records.length > 0) {
      return { matched: true, waitedMs: Date.now() - started, result };
    }
    if (Date.now() - started >= timeoutMs) {
      return { matched: false, waitedMs: Date.now() - started, result };
    }
    await sleep(intervalMs);
  }
}

function evaluateGates(fired, agentResult) {
  const refs = Array.isArray(agentResult?.evidenceRefs) ? agentResult.evidenceRefs : [];
  const checks = [
    { name: 'request-captured', ok: Boolean(fired?.request), detail: fired?.request?.url ?? 'missing request' },
    {
      name: 'response-settled',
      ok: Boolean(fired?.response) && !fired.response.pending,
      detail: String(fired?.response?.status ?? 'pending'),
    },
    {
      name: 'conclusion-present',
      ok: typeof agentResult?.conclusion === 'string' && agentResult.conclusion.trim() !== '',
      detail: truncate(agentResult?.conclusion ?? '', 200),
    },
    {
      name: 'evidence-refs',
      ok:
        refs.length > 0 &&
        refs.every((ref) => ref && typeof ref.type === 'string' && typeof ref.ref === 'string' && ref.type && ref.ref),
      detail: `${refs.length} ref(s)`,
    },
  ];
  return { ok: checks.every((check) => check.ok), checks };
}


/**
 * Run one diagnosis: preflight -> fire -> marker wait -> evidence -> agent -> gates -> persist.
 *
 * @param {Readonly<Record<string, any>>} scenario
 * @param {{
 *   runId?: string, runsDir?: string, question?: string, agent?: any, recheck?: number,
 *   markerTimeoutMs?: number, pollIntervalMs?: number, driverContext?: Record<string, any>,
 *   window?: { beforeMs: number, afterMs: number }, preflight?: { ok: boolean, checks: any[] }
 * }} [options]
 */
async function diagnoseWithFired({
  fired,
  scenario,
  paths,
  timeWindow,
  runId,
  runDir,
  question,
  agent,
  recheck,
  markerTimeoutMs,
  pollIntervalMs,
  preflight,
  startedAt,
  onProgress = () => {},
}) {
  const progress = (id, label, status = 'done', detail = null) => {
    try {
      onProgress({ id, label, status, detail, at: Date.now() });
    } catch {
      // progress must never break diagnosis
    }
  };
  const TOOL_LABELS = {
    get_logs: '查询日志',
    list_threads: '分析线程',
    search_log: '搜索日志',
    read_source: '读取源码',
    search_source: '搜索源码',
    read: '读取工具结果',
  };

  const extraSourceRoots = Array.isArray(scenario.extraSourceRoots) ? scenario.extraSourceRoots : [];
  const runLog = createRunLog(runDir);
  await runLog.info(`start scenario=${scenario.name} driver=${scenario.driverKind} question=${question || '-'}`);
  progress('prepare', '整理请求与证据', 'start');

  progress('logs', '关联日志与线程', 'start');
  const marker = fired.marker?.injected ? fired.marker.value : null;
  const wait = await waitForMarker({
    logfiles: paths.logfiles,
    parser: scenario.parser,
    encoding: scenario.logEncoding,
    anchor: fired.firedAt,
    window: timeWindow,
    marker,
    timeoutMs: markerTimeoutMs,
    intervalMs: pollIntervalMs,
  });

  const businessIds = extractBusinessIds({ request: fired.request, response: fired.response });
  const traceId = extractTraceId(fired.request?.headers, fired.response?.headers);
  const correlation = wait.matched
    ? { strategy: 'marker', matchedId: marker, result: wait.result }
    : await correlateLogs({
        logfiles: paths.logfiles,
        parser: scenario.parser,
        encoding: scenario.logEncoding,
        anchor: fired.firedAt,
        window: timeWindow,
        thread: null,
        businessIds,
        traceId,
        limit: 200,
      });
  const logsResult = correlation.result;
  await runLog.info(`logs strategy=${correlation.strategy} count=${logsResult.records.length} markerMatched=${wait.matched}`);

  const threads = await listThreads({
    logfiles: paths.logfiles,
    parser: scenario.parser,
    encoding: scenario.logEncoding,
    anchor: fired.firedAt,
    window: timeWindow,
  });
  progress('logs', '关联日志与线程', 'done');
  progress('source', '读取后端/前端源码', 'start');

  const source = await collectSource(paths.sourceRoot, logsResult.records);
  const frontendErrors = (fired.consoleErrors ?? []).slice(0, 10).map((error) => ({
    kind: error.kind,
    message: error.message,
    url: error.url,
    line: error.line,
    stack: (error.stack ?? []).slice(0, 10),
  }));
  const frontendFixRoot = scenario.frontendSourceRoot
    ? path.resolve(scenario.dir ?? process.cwd(), scenario.frontendSourceRoot)
    : null;
  const frontendSources = await resolveFrontendSources({
    frontendSourceRoot: frontendFixRoot,
    errors: frontendErrors,
  });
  progress('source', '读取后端/前端源码', 'done');
  progress('prepare', '整理请求与证据', 'done');

  const toolsBundle = createTools({
    scenario,
    anchor: fired.firedAt,
    runDir,
    logfiles: paths.logfiles,
    sourceRoot: paths.sourceRoot,
    frontendSourceRoot: frontendFixRoot,
    extraSourceRoots,
    window: timeWindow,
    onCall: (call) => {
      const label = TOOL_LABELS[call.name] ?? call.name;
      progress(
        `tool-${call.id}`,
        call.stage === 'start' ? `${label}…` : label,
        call.stage === 'start' ? 'start' : call.error ? 'error' : 'done',
        call.name,
      );
    },
  });

  const evidence = {
    symptom: { question, pageUrl: fired.request?.url ?? null },
    request: {
      method: fired.request?.method,
      url: fired.request?.url,
      headers: fired.request?.headers ?? {},
      body: truncate(fired.request?.body),
      startedAt: fired.request?.startedAt,
    },
    response: {
      status: fired.response?.status ?? null,
      statusText: fired.response?.statusText ?? '',
      ok: fired.response?.ok ?? false,
      headers: fired.response?.headers ?? {},
      body: truncate(fired.response?.body),
      truncated: fired.response?.truncated ?? false,
      error: fired.response?.error ?? null,
      durationMs: fired.response?.durationMs ?? null,
    },
    marker: {
      value: fired.marker?.value ?? null,
      mode: fired.marker?.mode ?? 'none',
      injected: Boolean(fired.marker?.injected),
      targets: fired.marker?.targets ?? { header: false, body: false },
      reason: fired.marker?.reason,
    },
    logs: {
      count: logsResult.records.length,
      markerMatched: wait.matched,
      waitedMs: wait.waitedMs,
      correlation: {
        strategy: correlation.strategy,
        matchedId: correlation.matchedId ?? null,
        businessIds,
        traceId,
      },
      stats: logsResult.stats,
      parser: logsResult.parser,
      parserFallback: Boolean(logsResult.parserFallback),
      parserWarning: logsResult.parserWarning ?? null,
      records: logsResult.records.slice(0, 50).map(compactRecord),
    },
    threads: { total: threads.total, threads: threads.threads.slice(0, 10) },
    source,
    frontend: {
      available: frontendSources.available,
      files: frontendSources.files,
      errors: frontendErrors,
    },
    extraSources: {
      configured: scenario.extraSourcesConfigured ?? extraSourceRoots.map(({ id, label }) => ({ id, label })),
      authorized: extraSourceRoots.length > 0,
    },
  };

  await runLog.info(`agent=${agent.id} mode=${agent.id === 'mock' ? 'mock' : 'live'}`);
  const callAgent = async () => {
    try {
      return await agent.diagnose({ question, evidence, tools: toolsBundle, budget: { maxRounds: 24 } });
    } catch (error) {
      await runLog.error(`agent failed: ${error?.message ?? error}`);
      throw error;
    }
  };
  progress('agent', 'AI 正在分析证据', 'start');
  let agentResult;
  try {
    agentResult = await callAgent();
    progress('agent', 'AI 已给出结论', 'done');
  } catch (error) {
    progress('agent', 'AI 分析失败', 'error');
    throw error;
  }
  const agentRuns = [agentResult];
  for (let i = 1; i < recheck; i += 1) {
    const id = `recheck-${i}`;
    progress(id, `第 ${i + 1}/${recheck} 轮复核`, 'start');
    try {
      agentRuns.push(await callAgent());
      progress(id, `第 ${i + 1}/${recheck} 轮复核`, 'done');
    } catch (error) {
      progress(id, `第 ${i + 1}/${recheck} 轮复核失败`, 'error');
      throw error;
    }
  }

  // 2a: attach read-only diff previews; never write the working tree here.
  progress('preview', '生成修复预览', 'start');
  try {
    agentResult.fixes = await buildFixPreviews(agentResult.fixes, {
      sourceRoot: paths.sourceRoot,
      frontendSourceRoot: frontendFixRoot,
      extraSourceRoots,
    });
    progress('preview', '生成修复预览', 'done');
  } catch (error) {
    progress('preview', '生成修复预览失败', 'error');
    await runLog.error(`fix preview failed: ${error?.message ?? error}`);
  }

  const gates = evaluateGates(fired, agentResult);
  const recheckInfo = recheck > 1
    ? (() => {
        const evaluation = evaluateRecheck(agentRuns, { responseStatus: fired.response?.status ?? null });
        return {
          runs: recheck,
          verdict: evaluation.verdict,
          checks: evaluation.checks,
          detail: evaluation.detail,
          conclusions: agentRuns.map((run) => run?.conclusion ?? ''),
          note: '一致不等于正确',
        };
      })()
    : null;

  const endedAt = Date.now();
  let target;
  if (scenario.driverKind === 'browser') {
    target = {
      driver: 'browser',
      path: scenario.browser.path,
      match: scenario.browser.match,
      actions: scenario.browser.actions.length,
    };
  } else if (scenario.driverKind === 'http') {
    target = { driver: 'http', method: scenario.http.method, path: scenario.http.path };
  } else {
    target = {
      driver: 'capture',
      method: fired.request?.method ?? null,
      path: requestPathOf(fired.request?.url),
      resourceType: scenario.capture?.resourceType ?? null,
      ruleId: scenario.capture?.ruleId ?? null,
    };
  }

  await runLog.info(`gates=${gates.ok} recheck=${recheckInfo ? recheckInfo.verdict : 'off'}`);
  progress('gates', '执行自检', 'done');

  const result = {
    meta: {
      runId,
      scenario: scenario.name,
      scenarioPath: scenario.filePath ?? null,
      driver: scenario.driverKind,
      agent: agent.id,
      mode: agent.id === 'mock' ? 'mock' : 'live',
      startedAt,
      endedAt,
      durationMs: endedAt - startedAt,
      question,
      runLog: 'run.log',
      // Needed by 2b apply/undo to re-resolve fix files safely.
      fixRoots: {
        sourceRoot: paths.sourceRoot ?? null,
        frontendSourceRoot: frontendFixRoot,
        extraSourceRoots,
      },
    },
    target,
    request: evidence.request,
    response: evidence.response,
    marker: evidence.marker,
    window: {
      anchor: fired.firedAt,
      beforeMs: timeWindow.beforeMs,
      afterMs: timeWindow.afterMs,
    },
    logs: evidence.logs,
    threads: evidence.threads,
    source: evidence.source,
    frontend: evidence.frontend,
    extraSources: evidence.extraSources,
    agent: agentResult,
    gates,
    recheck: recheckInfo,
  };

  const report = buildReport(result);
  await writeFile(path.join(runDir, 'result.json'), JSON.stringify(result, null, 2), 'utf8');
  await writeFile(path.join(runDir, 'report.md'), renderMarkdown(report), 'utf8');
  await writeFile(
    path.join(runDir, 'meta.json'),
    JSON.stringify({ ...result.meta, preflight }, null, 2),
    'utf8',
  );
  await runLog.info(`done durationMs=${Date.now() - startedAt} result=${runDir}`);
  progress('done', '诊断完成', 'done');

  return { result, runDir, runId, report };
}

export async function runDiagnosis(scenario, options = {}) {
  const {
    runId = newRunId(),
    runsDir = path.resolve('runs'),
    question = '',
    agent = createMockAgent(),
    recheck = 1,
    markerTimeoutMs = DEFAULT_MARKER_TIMEOUT_MS,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    driverContext = {},
    window,
    preflight: preflightOverride,
    onProgress = () => {},
  } = options;

  const startedAt = Date.now();
  const preflight = preflightOverride ?? (await runPreflight(scenario));
  if (!preflight.ok) {
    const failed = preflight.checks.filter((check) => !check.ok && check.severity === 'error');
    throw new AppError(
      'PREFLIGHT_FAILED',
      `Preflight failed: ${failed.map((check) => `${check.name}(${check.detail})`).join('; ')}`,
      { exitCode: 3, details: { checks: preflight.checks } },
    );
  }

  const runDir = path.resolve(runsDir, runId);
  await mkdir(runDir, { recursive: true });

  const paths = resolveScenarioPaths(scenario);
  const timeWindow = window ?? scenario.window;
  const fired = await fireScenario(scenario, driverContext);

  return diagnoseWithFired({
    fired,
    scenario,
    paths,
    timeWindow,
    runId,
    runDir,
    question,
    agent,
    recheck,
    markerTimeoutMs,
    pollIntervalMs,
    preflight,
    startedAt,
    onProgress,
  });

}

/**
 * Diagnose a captured request (no replay, no marker injection).
 *
 * @param {{
 *   request: any, response: any, firedAt?: number,
 *   resourceType?: string | null, ruleId?: string | null
 * }} observation
 * @param {{
 *   workspace?: any, root?: string, runId?: string, runsDir?: string,
 *   question?: string, agent?: any, recheck?: number,
 *   markerTimeoutMs?: number, pollIntervalMs?: number,
 *   window?: { beforeMs: number, afterMs: number }, preflight?: any,
 *   frontendErrors?: any[]
 * }} [options]
 */
export async function runCaptureDiagnosis(observation, options = {}) {
  const {
    workspace = {},
    root = process.cwd(),
    runId = newRunId(),
    runsDir = path.resolve('runs'),
    question = '',
    agent = createMockAgent(),
    recheck = 1,
    markerTimeoutMs = DEFAULT_MARKER_TIMEOUT_MS,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    window,
    preflight: preflightOverride,
    allowExtraSources = false,
    onProgress = () => {},
  } = options;

  const startedAt = Date.now();
  const logfiles = (workspace.logfiles ?? []).map((file) => path.resolve(root, file));
  const sourceRoot = workspace.sourceRoot ? path.resolve(root, workspace.sourceRoot) : null;
  const configuredExtraRoots = [];
  for (const [index, entry] of (workspace.extraSourceRoots ?? []).entries()) {
    if (!entry) continue;
    const resolved = path.resolve(root, String(entry));
    try {
      const info = await stat(resolved);
      if (!info.isDirectory()) continue;
    } catch {
      continue;
    }
    configuredExtraRoots.push({
      id: `extra-${index + 1}`,
      root: resolved,
      label: path.basename(resolved) || `extra-${index + 1}`,
    });
  }
  const authorizedExtraRoots = allowExtraSources ? configuredExtraRoots : [];
  const configuredFrontendSourceRoot = workspace.frontendSourceRoot
    ? path.resolve(root, workspace.frontendSourceRoot)
    : null;
  let frontendProjectRoot = null;
  try {
    const project = await resolveFrontendProjectRoot(workspace, { rootDir: root });
    if (project.ok) frontendProjectRoot = project.cwd;
  } catch {
    // source mapping can still work with an explicit frontendSourceRoot
  }
  // Project root is the default source base: it resolves Vite's /src/... paths directly.
  const frontendSourceRoot = configuredFrontendSourceRoot ?? frontendProjectRoot;
  const scenario = {
    name: `capture-${observation.request?.method ?? 'GET'} ${requestPathOf(observation.request?.url) ?? ''}`.trim(),
    driverKind: 'capture',
    capture: {
      resourceType: observation.resourceType ?? null,
      ruleId: observation.ruleId ?? null,
    },
    logfiles,
    source: sourceRoot ? { root: sourceRoot } : undefined,
    extraSourceRoots: authorizedExtraRoots,
    extraSourcesConfigured: configuredExtraRoots.map(({ id, label }) => ({ id, label })),
    frontendSourceRoot,
    frontendProjectRoot,
    parser: { preset: workspace.logParser || 'auto' },
    logEncoding: 'auto',
    marker: { mode: 'none', header: 'X-DC-Probe' },
    window: window ?? workspace.window ?? { beforeMs: 3000, afterMs: 2000 },
    filePath: undefined,
    dir: root,
  };

  const preflight = preflightOverride ?? (await runCapturePreflight({ logfiles, sourceRoot }));
  if (!preflight.ok) {
    const failed = preflight.checks.filter((check) => !check.ok && check.severity === 'error');
    throw new AppError(
      'PREFLIGHT_FAILED',
      `Preflight failed: ${failed.map((check) => `${check.name}(${check.detail})`).join('; ')}`,
      { exitCode: 3, details: { checks: preflight.checks } },
    );
  }

  const runDir = path.resolve(runsDir, runId);
  await mkdir(runDir, { recursive: true });
  const paths = resolveScenarioPaths(scenario);
  const timeWindow = scenario.window;
  const fired = {
    request: observation.request,
    response: observation.response,
    firedAt: observation.firedAt ?? startedAt,
    marker: { mode: 'none', injected: false, value: null, targets: { header: false, body: false } },
    consoleErrors: options.frontendErrors ?? observation.consoleErrors ?? [],
  };

  return diagnoseWithFired({
    fired,
    scenario,
    paths,
    timeWindow,
    runId,
    runDir,
    question,
    agent,
    recheck,
    markerTimeoutMs,
    pollIntervalMs,
    preflight,
    startedAt,
    onProgress,
  });
}
