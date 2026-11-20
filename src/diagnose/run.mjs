import { mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { AppError } from '../core/errors.mjs';
import { redactHeaders } from '../core/redact.mjs';
import { buildEvidenceRefIndex, validateEvidenceRefs } from '../core/evidence-refs.mjs';
import { newRunId } from '../core/ids.mjs';
import { resolveScenarioPaths } from '../core/scenario.mjs';
import { normalizeTriage } from '../core/triage.mjs';
import { actionStatusCounts } from '../core/actions.mjs';
import { buildMemoryCandidates, selectPromptNotes } from '../core/diagnosis-memory.mjs';
import {
  applySymptomToGates,
  buildSymptomCheck,
} from '../core/symptom.mjs';
import {
  buildReplayFixture,
  compareSymptom,
  replayFixture,
  responseSignature,
} from '../core/replay.mjs';
import {
  buildRepairFailure,
  failureSignature,
  mergeUsage,
  planRepairBudget,
  shouldAutoRepair,
} from '../core/auto-repair.mjs';
import { resolveFrontendSources } from '../evidence/frontend.mjs';
import { collectElementEvidence } from '../evidence/element.mjs';
import { buildFixPreviews, extraRootFixes, mergeExtractedFixes } from '../core/fixes.mjs';
import {
  applyVerificationGate,
  detectCompileCommands,
  runWorkspaceCheck,
} from '../core/fix-validation.mjs';
import {
  cleanupAgentSandbox,
  createAgentSandbox,
  createSandboxCommandRunner,
  extractSandboxFixes,
  sandboxPromptFor,
  sandboxRootsForCheck,
} from '../core/agent-sandbox.mjs';
import { createInPlaceSession } from '../core/inplace-session.mjs';
import { resolveFrontendProjectRoot } from '../core/frontend-service.mjs';
import { fireScenario } from '../driver/index.mjs';
import { readLogs, listThreads } from '../evidence/logs.mjs';
import { correlateLogs, extractBusinessIds, extractTraceId } from '../evidence/correlate.mjs';
import { readSource } from '../evidence/source.mjs';
import { resolveBuildProbeRoot } from '../evidence/build-model.mjs';
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

/**
 * Database degradation notice. A missing or unreachable database must never
 * abort a diagnosis; it only changes which evidence was available.
 */
function buildDatabaseNotice(configured = [], reachable = []) {
  const configuredList = Array.isArray(configured) ? configured : [];
  const reachableList = Array.isArray(reachable) ? reachable : [];
  if (configuredList.length === 0) return null;
  if (reachableList.length === 0) {
    return '数据库查询不可用，本次诊断仅通过源码与日志分析获得结论。';
  }
  const reachableIds = new Set(reachableList.map((connection) => connection.id));
  const unavailable = configuredList.filter((connection) => !reachableIds.has(connection.id));
  if (unavailable.length === 0) return null;
  const names = unavailable.map((connection) => connection.name || connection.id).join('、');
  return `部分数据库不可用（${names}），相关结论仅基于源码与日志分析。`;
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

function verificationProgress(verification, scopeLabel) {
  const buildStatus = verification?.buildStatus ?? verification?.status ?? 'skipped';
  const testStatus = verification?.testStatus ?? 'skipped';
  let label = `${scopeLabel}未执行构建自检`;
  if (buildStatus === 'failed') label = `${scopeLabel}构建自检失败`;
  else if (verification?.status === 'failed' && testStatus === 'failed') label = `${scopeLabel}必需测试失败`;
  else if (testStatus === 'failed') {
    label = buildStatus === 'passed'
      ? `${scopeLabel}构建通过，测试失败（未阻断）`
      : `${scopeLabel}测试失败（未阻断）`;
  } else if (buildStatus === 'passed' && testStatus === 'passed') label = `${scopeLabel}构建与测试通过`;
  else if (buildStatus === 'passed') label = `${scopeLabel}构建通过（测试未执行）`;
  else if (testStatus === 'passed') label = `${scopeLabel}未执行构建，测试通过`;
  const failed = buildStatus === 'failed' || verification?.status === 'failed' || verification?.detectionError;
  return {
    label,
    level: failed ? 'error' : 'done',
    detail: verification?.error ?? verification?.testError ?? verification?.testReason ?? verification?.reason,
  };
}

function describeInvalidRefs(invalid) {
  return invalid
    .slice(0, 3)
    .map(({ ref, reason }) => `${ref?.type ?? '?'}:${ref?.ref ?? '?'}(${reason})`)
    .join(', ');
}

export function evaluateGates(fired, agentResult, element = null, evidence = null) {
  const refs = Array.isArray(agentResult?.evidenceRefs) ? agentResult.evidenceRefs : [];
  const refIndex = evidence ? buildEvidenceRefIndex(evidence) : null;
  const refShapesOk = refs.length > 0
    && refs.every((ref) => ref && typeof ref.type === 'string' && typeof ref.ref === 'string' && ref.type && ref.ref);
  const refValidation = validateEvidenceRefs(refIndex, refs);
  const conclusionCheck = {
    name: 'conclusion-present',
    ok: typeof agentResult?.conclusion === 'string' && agentResult.conclusion.trim() !== '',
    detail: truncate(agentResult?.conclusion ?? '', 200),
  };
  const evidenceCheck = {
    name: 'evidence-refs',
    ok: refShapesOk && refValidation.ok,
    detail: `${refs.length} ref(s)${refValidation.invalid.length ? `; invalid: ${describeInvalidRefs(refValidation.invalid)}` : ''}`,
  };
  const rejected = Array.isArray(agentResult?.rejectedHypotheses) ? agentResult.rejectedHypotheses : [];
  const noRejectedReason = String(agentResult?.noRejectedHypothesesReason ?? '').trim();
  const hypothesisProblems = [];
  for (const [index, item] of rejected.entries()) {
    const label = `#${index + 1}`;
    if (!String(item?.hypothesis ?? '').trim()) hypothesisProblems.push(`${label} missing hypothesis`);
    if (!String(item?.reason ?? '').trim()) hypothesisProblems.push(`${label} missing reason`);
    const refutedBy = Array.isArray(item?.refutedBy) ? item.refutedBy : [];
    if (refutedBy.length === 0) {
      hypothesisProblems.push(`${label} missing refutedBy`);
    } else {
      const validation = validateEvidenceRefs(refIndex, refutedBy);
      if (!validation.ok) hypothesisProblems.push(`${label} invalid ref ${describeInvalidRefs(validation.invalid)}`);
    }
  }
  const hypothesisCheck = {
    name: 'hypothesis-disclosure',
    ok: rejected.length > 0 ? hypothesisProblems.length === 0 : Boolean(noRejectedReason),
    detail: rejected.length > 0
      ? `${rejected.length} hypothesis(es)${hypothesisProblems.length ? `; ${hypothesisProblems.slice(0, 3).join('; ')}` : ''}`
      : (noRejectedReason
          ? `none: ${truncate(noRejectedReason, 120)}`
          : 'missing rejectedHypotheses or noRejectedHypothesesReason'),
  };
  if (element) {
    const checks = [
      {
        name: 'element-captured',
        ok: Boolean(element.selector) && Boolean(element.page?.url),
        detail: element.selector ?? 'missing selector',
      },
      {
        name: 'component-context',
        ok: Boolean(element.framework?.componentFile || element.componentCandidates?.length),
        severity: 'warn',
        detail: element.framework?.componentFile
          ?? element.componentCandidates?.[0]?.file
          ?? (element.framework?.componentName ?? '未解析到组件文件'),
      },
      conclusionCheck,
      evidenceCheck,
      hypothesisCheck,
    ];
    return {
      ok: checks.every((check) => check.ok || check.severity === 'warn'),
      checks,
    };
  }
  const checks = [
    { name: 'request-captured', ok: Boolean(fired?.request), detail: fired?.request?.url ?? 'missing request' },
    {
      name: 'response-settled',
      ok: Boolean(fired?.response) && !fired.response.pending,
      detail: String(fired?.response?.status ?? 'pending'),
    },
    conclusionCheck,
    evidenceCheck,
    hypothesisCheck,
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
  triage = null,
  symptomStatus = 'pending',
  symptomNote = null,
  replayFetch = null,
  agent,
  recheck,
  markerTimeoutMs,
  pollIntervalMs,
  preflight,
  startedAt,
  databases = [],
  activeDatabaseId = null,
  approveWrite = null,
  databaseConnect = undefined,
  databaseNotice = null,
  verifyCommand = '',
  workspace = {},
  sandbox = false,
  element = null,
  memory = null,
  onMemory = null,
  onProgress = () => {},
}) {
  const normalizedTriage = normalizeTriage(triage);
  const memoryProject = memory?.enabled && memory?.project ? memory.project : null;
  const memoryNotes = memoryProject
    ? selectPromptNotes(memory?.notes ?? memory?.promptNotes ?? [])
    : [];
  const memoryContext = memoryProject ? { project: memoryProject, notes: memoryNotes } : null;
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
    query_result: '查询工具结果',
    inspect_build_model: '检查工程模型',
    runtime_facts: '查看运行时事实',
    list_java_processes: '查找 Java 进程',
    list_processes: '查看运行进程',
    list_dir: '查看目录',
    stat_file: '查看文件时间',
    git_status: '查看 Git 状态',
    git_log: '查看最近提交',
    git_diff: '查看代码变更',
    maven_dependencies: '分析 Maven 依赖',
    runtime_classpath: '对比运行 classpath',
    query_db: '查询数据库',
    write_db: '写入数据库',
    run_command: '运行编译/测试',
  };

  const extraSourceRoots = Array.isArray(scenario.extraSourceRoots) ? scenario.extraSourceRoots : [];
  const toolMode = workspace.agent?.toolMode;
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
    ? {
        strategy: 'marker',
        matchedId: marker,
        strength: 'strong',
        caveat: null,
        result: wait.result,
      }
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
  if (databaseNotice) {
    progress('database', '数据库不可用，改用源码与日志分析', 'error', databaseNotice);
  }

  let sandboxContext = null;
  let sandboxRunCommand = null;
  let sandboxUsed = false;
  let inPlaceUsed = false;
  let workspaceNotice = null;
  // Full mode always runs through the same in-place session as sandbox mode;
  // Bash is the only extra capability. This guarantees journal/baseline
  // coverage even if a caller forgets to pass sandbox:true.
  const useWorkspaceSession = agent.id !== 'mock' && (sandbox || toolMode === 'full');
  if (useWorkspaceSession && typeof agent.configureScope === 'function') {
    const writableRoots = [
      paths.sourceRoot ? { key: 'backend', name: 'backend', root: paths.sourceRoot } : null,
      frontendFixRoot ? { key: 'frontend', name: 'frontend', root: frontendFixRoot } : null,
    ].filter(Boolean);
    const readOnlyRoots = extraSourceRoots.map((entry) => ({
      key: 'extra',
      extraRoot: entry.id,
      name: `extra-${entry.id}`,
      root: entry.root,
    }));
    progress('sandbox', '准备工作区', 'start');
    let inPlace = null;
    try {
      inPlace = await createInPlaceSession({
        runDir,
        roots: writableRoots.map(({ key, root }) => ({ key, root })),
        readOnlyRoots,
        runId,
        workspace,
        verifyCommand,
        projectRoot: scenario.dir ?? process.cwd(),
      });
    } catch (error) {
      inPlace = { ok: false, reason: 'baseline-error', error };
    }
    if (inPlace?.ok) {
      sandboxContext = inPlace;
      sandboxUsed = true;
      inPlaceUsed = true;
      agent.configureScope({
        cwd: inPlace.cwd,
        allowedRoots: inPlace.allowedRoots,
        writeRoots: inPlace.writeRoots,
        // Full mode uses the same in-place session; only Bash is additionally
        // enabled by the permission layer.
        toolMode: toolMode === 'full' ? 'full' : 'sandbox',
        systemPromptSuffix: inPlace.systemPromptSuffix,
        onBeforeWrite: inPlace.onBeforeWrite,
        onAfterWrite: inPlace.onAfterWrite,
      });
      sandboxRunCommand = inPlace.runCommand;
      workspaceNotice = { mode: 'in-place', code: 'ok', message: '原地工作区已就绪' };
      progress(
        'sandbox',
        toolMode === 'full'
          ? '原地工作区已就绪，开放编辑、Bash 与测试'
          : '原地工作区已就绪，开放编辑与测试',
        'done',
        inPlace.cwd,
      );
      await runLog.info(`in-place session repos=${inPlace.repos.length}`);
    } else if (inPlace?.reason === 'not-git') {
      try {
        sandboxContext = await createAgentSandbox({ runDir, roots: writableRoots });
        sandboxUsed = true;
        const sandboxWriteRoots = sandboxContext.roots.map((entry) => entry.sandboxRoot);
        agent.configureScope({
          cwd: sandboxContext.dir,
          allowedRoots: [...sandboxWriteRoots, ...readOnlyRoots.map((entry) => entry.root)],
          writeRoots: sandboxWriteRoots,
          toolMode: toolMode === 'full' ? 'full' : 'sandbox',
          systemPromptSuffix: sandboxPromptFor(sandboxContext),
        });
        sandboxRunCommand = createSandboxCommandRunner({
          sandbox: sandboxContext,
          verifyCommand,
          workspace,
        });
        workspaceNotice = {
          mode: 'copy',
          code: 'not-git',
          message: '非 Git 项目，使用隔离副本',
          fileCount: sandboxContext.fileCount,
        };
        progress('sandbox', '非 Git 项目，使用隔离副本', 'done', `${sandboxContext.fileCount} 个文件`);
        await runLog.info(`copy sandbox files=${sandboxContext.fileCount}`);
      } catch (error) {
        sandboxContext = null;
        sandboxRunCommand = null;
        agent.configureScope({ toolMode: 'readonly', systemPromptSuffix: '' });
        workspaceNotice = {
          mode: 'readonly',
          code: error?.code ?? 'sandbox-error',
          message: '工作区过大或无法创建副本，退回只读模式',
          detail: error?.message ?? String(error),
        };
        progress('sandbox', workspaceNotice.message, 'error', workspaceNotice.detail);
        await runLog.error(`copy sandbox failed: ${error?.message ?? error}`);
      }
    } else {
      sandboxContext = null;
      sandboxRunCommand = null;
      agent.configureScope({ toolMode: 'readonly', systemPromptSuffix: '' });
      const owner = inPlace?.reason === 'busy' ? inPlace.owner ?? null : null;
      const ownerDetail = owner
        ? `占用诊断：${owner.runId ?? 'unknown'} · pid ${owner.pid ?? '?'}${owner.at ? ` · 开始于 ${new Date(owner.at).toLocaleString()}` : ''}`
        : null;
      const reason = inPlace?.reason === 'busy'
        ? '工作区正被其他诊断占用，本次使用只读模式'
        : `无法建立工作区基线，本次使用只读模式：${inPlace?.error?.message ?? inPlace?.reason ?? 'unknown'}`;
      workspaceNotice = {
        mode: 'readonly',
        code: inPlace?.reason ?? 'unknown',
        message: reason,
        busyRepo: inPlace?.busyRepo ?? null,
        detail: inPlace?.error?.message ?? null,
        owner: owner
          ? { runId: owner.runId ?? null, pid: owner.pid ?? null, at: owner.at ?? null, repoRoot: owner.repoRoot ?? null }
          : null,
      };
      progress('sandbox', reason, 'error', ownerDetail);
      await runLog.warn(`workspace session degraded to readonly: ${reason}${ownerDetail ? ` (${ownerDetail})` : ''}`);
    }
  }

  const toolsBundle = createTools({
    scenario,
    anchor: fired.firedAt,
    runDir,
    logfiles: paths.logfiles,
    sourceRoot: paths.sourceRoot,
    frontendSourceRoot: frontendFixRoot,
    extraSourceRoots,
    databases,
    activeDatabaseId,
    approveWrite,
    databaseConnect,
    runCommand: sandboxRunCommand,
    toolMode: toolMode === 'full' ? 'full' : (sandboxRunCommand ? 'sandbox' : 'readonly'),
    buildProbeRoot: resolveBuildProbeRoot({
      sourceRoot: paths.sourceRoot,
      configured: workspace.buildProbeRoot,
      root: scenario.dir ?? process.cwd(),
    }),
    runtimeFactsConfig: workspace.runtimeFacts,
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

  const elementContext = element
    ? (await collectElementEvidence({
        element,
        frontendSourceRoot: frontendFixRoot ?? scenario.frontendSourceRoot,
        frontendProjectRoot: scenario.frontendProjectRoot ?? null,
        backendSourceRoot: paths.sourceRoot,
      })).element
    : null;

  const evidence = {
    symptom: { question, pageUrl: element?.page?.url ?? fired.request?.url ?? null },
    triage: normalizedTriage ?? undefined,
    element: elementContext ?? undefined,
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
        strength: correlation.strength ?? 'none',
        caveat: correlation.caveat ?? null,
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
  let wroteWorkspace = false;
  const BUILTIN_TOOL_LABELS = {
    Read: '读取文件',
    Grep: '搜索项目引用',
    Glob: '查找项目文件',
    Edit: '修改沙箱文件',
    Write: '写入沙箱文件',
  };
  const onAgentToolUse = (tool) => {
    if (!tool?.id) return;
    if (tool.stage === 'start' && toolMode === 'full'
      && ['Edit', 'Write', 'Bash'].includes(tool.name)) {
      wroteWorkspace = true;
    }
    if (tool.stage === 'done' && !tool.error && ['Edit', 'Write', 'Bash'].includes(tool.name)) {
      toolsBundle.resetCommandCache();
    }
    const toolLabel = tool.name
      ? (BUILTIN_TOOL_LABELS[tool.name] ?? tool.name)
      : null;
    progress(
      `builtin-${tool.id}`,
      tool.stage === 'start'
        ? (toolLabel ? `${toolLabel}…` : '调用工具…')
        : (toolLabel ?? '工具调用完成'),
      tool.stage === 'start' ? 'start' : tool.isError ? 'error' : 'done',
      tool.name,
    );
  };
  const callAgent = async () => {
    try {
      return await agent.diagnose({
        question,
        evidence,
        tools: toolsBundle,
        memory: memoryContext,
        onToolUse: onAgentToolUse,
      });
    } catch (error) {
      await runLog.error(`agent failed: ${error?.message ?? error}`);
      throw error;
    }
  };
  progress('agent', 'AI 正在分析证据', 'start');
  let agentResult;
  try {
    agentResult = await callAgent();
    progress(
      'agent',
      agentResult.incomplete ? 'AI 未完成，已保留部分结论' : 'AI 已给出结论',
      agentResult.incomplete ? 'error' : 'done',
    );
    if (process.env.DC_DEBUG_USAGE === '1' && agentResult.usage) {
      await runLog.info(`usage ${JSON.stringify(agentResult.usage)}`);
    }
  } catch (error) {
    progress('agent', 'AI 分析失败', 'error');
    if (sandboxContext) {
      if (sandboxContext.mode === 'in-place') await sandboxContext.discard();
      else await cleanupAgentSandbox(sandboxContext);
      sandboxContext = null;
    }
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
      if (sandboxContext) {
        await cleanupAgentSandbox(sandboxContext);
        sandboxContext = null;
      }
      throw error;
    }
  }

  async function attemptRepair({
    verification,
    phase,
    changedFiles = [],
    previousFixes = [],
    allowUnknownFiles = false,
    recheck: recheckFn = null,
  }) {
    if (agent.id === 'mock' || typeof agent.followUp !== 'function' || typeof recheckFn !== 'function') {
      return { attempted: false, skippedReason: 'agent-no-repair' };
    }
    const startedAt = Date.now();
    let current = { verification, changedFiles, previousFixes };
    let maxAttempts = Math.max(1, Math.min(5, Number(workspace.agent?.repairRetry?.maxAttempts ?? 3) || 3));
    let attempts = 0;
    let repairSpentUsd = 0;
    let lastFailure = null;
    let lastPlan = null;
    let lastError = null;
    let skippedReason = null;
    const history = [];

    while (attempts < maxAttempts) {
      const decision = shouldAutoRepair({
        verification: current.verification,
        changedFiles: current.changedFiles,
        recheck,
        enabled: workspace.agent?.repairRetry?.enabled !== false,
        allowUnknownFiles,
      });
      if (!decision.ok) {
        if (attempts === 0) return { attempted: false, skippedReason: decision.reason };
        skippedReason = decision.reason;
        await runLog.info(`auto-repair stop attempt=${attempts} reason=${decision.reason}`);
        break;
      }
      const plan = planRepairBudget({
        workspace,
        usage: agentResult.usage,
        elapsedMs: Date.now() - startedAt,
        repairSpentUsd,
      });
      if (!plan.ok) {
        if (attempts === 0) return { attempted: false, skippedReason: plan.reason };
        skippedReason = plan.reason;
        await runLog.info(`auto-repair stop attempt=${attempts} reason=${plan.reason}`);
        break;
      }
      maxAttempts = Math.min(maxAttempts, plan.maxAttempts);
      const attempt = attempts + 1;
      const failure = buildRepairFailure({
        verification: current.verification,
        phase,
        changedFiles: current.changedFiles,
        previousFixes: current.previousFixes,
        previousAttempts: history,
        attempt,
      });
      if (lastFailure && failureSignature(lastFailure) === failureSignature(failure)) {
        skippedReason = 'no-progress';
        await runLog.info(`auto-repair stop attempt=${attempts} reason=no-progress`);
        break;
      }
      attempts = attempt;
      lastFailure = failure;
      lastPlan = plan;
      progress('repair', `自动修复尝试 ${attempt}/${maxAttempts}`, 'start', failure.error);
      await runLog.info(`auto-repair start attempt=${attempt}/${maxAttempts} phase=${phase} command=${failure.commands[0]?.command ?? '-'}`);

      let repair;
      try {
        repair = await agent.followUp({
          question: '',
          previous: {
            meta: { question },
            agent: agentResult,
            request: evidence.request,
            response: evidence.response,
            logs: evidence.logs,
          },
          tools: toolsBundle,
          budget: plan.budget,
          onToolUse: onAgentToolUse,
          purpose: 'repair',
          failure,
        });
      } catch (error) {
        lastError = error?.message ?? String(error);
        skippedReason = 'repair-error';
        progress('repair', '自动修复失败', 'error', lastError);
        await runLog.error(`auto-repair failed: ${lastError}`);
        break;
      }

      agentResult.usage = mergeUsage(agentResult.usage, repair.usage);
      repairSpentUsd += Number(repair.usage?.costUsd ?? 0) || 0;
      if (repair.needsMoreInfo?.length) {
        agentResult.needsMoreInfo = [...(agentResult.needsMoreInfo ?? []), ...repair.needsMoreInfo];
      }

      let next;
      try {
        next = await recheckFn({ repair, failure, attempt });
      } catch (error) {
        lastError = error?.message ?? String(error);
        skippedReason = 'recheck-error';
        break;
      }
      const nextChangedFiles = next?.changedFiles ?? current.changedFiles;
      const nextFixes = next?.previousFixes ?? current.previousFixes;
      history.push({
        attempt,
        changedFiles: nextChangedFiles.slice(0, 20),
        fixSummaries: nextFixes
          .map((fix) => (typeof fix === 'string' ? fix : fix?.summary ?? fix?.file))
          .filter(Boolean)
          .slice(0, 10),
        errorLines: (failure.errorLines ?? []).slice(0, 10),
        commands: (failure.commands ?? []).map((entry) => entry.command).slice(0, 5),
      });
      current = {
        verification: next?.verification ?? current.verification,
        changedFiles: nextChangedFiles,
        previousFixes: nextFixes,
      };
      if (current.verification?.status !== 'failed') break;
      if (next?.progress === false) {
        skippedReason = 'no-progress';
        await runLog.info(`auto-repair stop attempt=${attempts} reason=no-progress-after-recheck`);
        break;
      }
    }

    if (lastError) {
      agentResult.needsMoreInfo = [
        ...(agentResult.needsMoreInfo ?? []),
        `自动修复未完成：${lastError}`,
      ];
    }
    const info = {
      attempted: attempts > 0,
      attempts,
      maxAttempts,
      failure: lastFailure,
      lastFailure,
      history,
      budget: lastPlan?.budget ?? null,
      finalStatus: current.verification?.status ?? 'unknown',
      skippedReason: skippedReason ?? undefined,
      ...(lastError ? { error: lastError } : {}),
    };
    if (attempts > 0) agentResult.repair = info;
    if (attempts > 0) {
      progress(
        'repair',
        current.verification?.status === 'failed'
          ? `自动修复结束（${attempts} 次尝试，仍失败）`
          : `自动修复结束（${attempts} 次尝试，已通过）`,
        current.verification?.status === 'failed' ? 'error' : 'done',
        current.verification?.error ?? current.verification?.testError ?? current.verification?.reason,
      );
      await runLog.info(`auto-repair done attempts=${attempts} final=${current.verification?.status ?? 'unknown'} cost=${repairSpentUsd}`);
    }
    return {
      attempted: attempts > 0,
      info,
      verification: current.verification,
      changedFiles: current.changedFiles,
      previousFixes: current.previousFixes,
      history,
    };
  }

  if (sandboxContext) {
    if (sandboxContext.mode === 'in-place') {
      try {
        let extracted = await sandboxContext.extract();
        let extractedFixes = (extracted.fixes ?? []).map((fix) => ({
          ...fix,
          workspaceApplied: true,
          pendingDecision: true,
        }));
        // Extra backend roots stay read-only, but the agent's suggestions for
        // them must survive the extracted workspace fixes and be previewable.
        const extraFixes = extraRootFixes(agentResult.fixes);
        let previewedExtras = [];
        if (extraFixes.length > 0) {
          try {
            previewedExtras = await buildFixPreviews(extraFixes, {
              sourceRoot: paths.sourceRoot,
              frontendSourceRoot: frontendFixRoot,
              extraSourceRoots,
              staticChecks: 'strict',
            });
          } catch (error) {
            previewedExtras = extraFixes.map((fix) => ({
              ...fix,
              preview: { status: 'error', message: `其他源码根预览失败：${error?.message ?? error}` },
            }));
          }
        }
        agentResult.fixes = [...previewedExtras, ...extractedFixes];
        // Full mode can also modify files via Bash, which is not part of the
        // Edit/Write snapshot map; use the tool-level write flag as fallback.
        const hasWorkspaceChanges = (extracted.changedFiles?.length ?? 0) > 0
          || (toolMode === 'full' && wroteWorkspace);
        let selfCheck = hasWorkspaceChanges
          ? await sandboxContext.runSelfCheck()
          : {
              status: 'skipped',
              ok: true,
              reason: '本轮没有检测到工作区修改',
              commands: [],
              durationMs: 0,
              output: '',
            };
        agentResult.workspaceSession = {
          mode: 'in-place',
          status: 'pending',
          runId,
          baselineDir: sandboxContext.baselineDir,
          repos: sandboxContext.repos,
          changedFiles: extracted.changedFiles,
          touchedFiles: extracted.touchedFiles ?? [],
          skipped: extracted.skipped,
          conflicts: extracted.conflicts,
          selfCheck,
        };
        agentResult.verification = { scope: 'workspace', mode: 'in-place', ...selfCheck };
        if (selfCheck.status === 'failed') {
          const repair = await attemptRepair({
            verification: selfCheck,
            phase: 'in-place-self-check',
            changedFiles: extracted.changedFiles,
            previousFixes: agentResult.fixes,
            recheck: async () => {
              extracted = await sandboxContext.extract();
              extractedFixes = (extracted.fixes ?? []).map((fix) => ({
                ...fix,
                workspaceApplied: true,
                pendingDecision: true,
              }));
              agentResult.fixes = [...previewedExtras, ...extractedFixes];
              const hasChangesAfter = (extracted.changedFiles?.length ?? 0) > 0
                || (toolMode === 'full' && wroteWorkspace);
              selfCheck = hasChangesAfter
                ? await sandboxContext.runSelfCheck()
                : {
                    status: 'failed',
                    ok: false,
                    error: '自动修复回合没有产生新的文件修改',
                    commands: [],
                    durationMs: 0,
                    output: '',
                  };
              agentResult.workspaceSession = {
                ...agentResult.workspaceSession,
                changedFiles: extracted.changedFiles,
                touchedFiles: extracted.touchedFiles ?? [],
                skipped: extracted.skipped,
                conflicts: extracted.conflicts,
                selfCheck,
              };
              agentResult.verification = {
                scope: 'workspace',
                mode: 'in-place',
                ...selfCheck,
              };
              const retryUi = verificationProgress(selfCheck, '自动修复复验');
              progress('selfcheck', retryUi.label, retryUi.level, retryUi.detail);
              await runLog.info(`in-place auto-repair recheck=${selfCheck.status}`);
              return {
                verification: selfCheck,
                changedFiles: extracted.changedFiles,
                previousFixes: agentResult.fixes,
                progress: hasChangesAfter,
              };
            },
          });
          if (repair.attempted) {
            selfCheck = repair.verification;
            selfCheck.repair = { ...repair.info, finalStatus: selfCheck.status };
            agentResult.workspaceSession = {
              ...agentResult.workspaceSession,
              changedFiles: extracted.changedFiles,
              touchedFiles: extracted.touchedFiles ?? [],
              skipped: extracted.skipped,
              conflicts: extracted.conflicts,
              selfCheck,
            };
            agentResult.verification = {
              scope: 'workspace',
              mode: 'in-place',
              ...selfCheck,
            };
          } else {
            selfCheck.repair = {
              attempted: false,
              skippedReason: repair.skippedReason ?? 'not-eligible',
            };
            agentResult.verification.repair = selfCheck.repair;
          }
        }

        if (extracted.skipped.length > 0 || extracted.conflicts.length > 0) {
          agentResult.needsMoreInfo = [
            ...(agentResult.needsMoreInfo ?? []),
            `原地修改中有 ${extracted.skipped.length} 个跳过、${extracted.conflicts.length} 个冲突，请在保留/丢弃前检查。`,
          ];
        }
        if (selfCheck.status === 'skipped' && selfCheck.detectionError) {
          agentResult.needsMoreInfo = [
            ...(agentResult.needsMoreInfo ?? []),
            `未能验证原地修改：${selfCheck.reason ?? '命令探测失败'}`,
          ];
        }
        progress(
          'selfcheck',
          selfCheck.status === 'passed'
            ? '编译自测通过，等待保留/丢弃'
            : selfCheck.status === 'failed'
              ? '编译自测失败，等待保留/丢弃'
              : '未执行编译自测，等待保留/丢弃',
          selfCheck.status === 'failed' || selfCheck.detectionError ? 'error' : 'done',
          selfCheck.error ?? selfCheck.reason,
        );
        await runLog.info(`in-place extracted=${extracted.fixes.length} selfCheck=${selfCheck.status}`);
      } catch (error) {
        agentResult.fixes = [];
        agentResult.needsMoreInfo = [
          ...(agentResult.needsMoreInfo ?? []),
          `原地修改提取失败，已恢复工作区：${error?.message ?? error}`,
        ];
        await sandboxContext.discard();
        sandboxContext = null;
        progress('sandbox', '原地修改提取失败，已恢复工作区', 'error', error?.message ?? String(error));
        await runLog.error(`in-place extract failed: ${error?.message ?? error}`);
      }
    } else {
      try {
        let extracted = await extractSandboxFixes(sandboxContext);
        agentResult.sandbox = {
          changedFiles: extracted.changedFiles,
          skipped: extracted.skipped,
        };
        if (extracted.skipped.length > 0) {
          agentResult.needsMoreInfo = [
            ...(agentResult.needsMoreInfo ?? []),
            `沙箱中有 ${extracted.skipped.length} 个变更未能自动提取（新增/删除/大文件），请手动检查。`,
          ];
        }

        const runSandboxCheck = async (changedFiles) => {
          if (!changedFiles.length) {
            return {
              status: 'skipped',
              ok: true,
              reason: '本轮没有修改沙箱文件',
              commands: [],
              durationMs: 0,
              output: '',
            };
          }
          progress('selfcheck', '沙箱内构建/测试自检', 'start');
          try {
            return await runWorkspaceCheck({
              roots: sandboxRootsForCheck(sandboxContext),
              verifyCommand,
              // Do not let an absolute real-project config leak the command cwd
              // outside the disposable sandbox.
              workspace: { ...workspace, frontendProjectRoot: '', frontendSourceRoot: '' },
              projectRoot: sandboxContext.dir,
              runDir,
              restrictToProjectRoot: true,
            });
          } catch (error) {
            return {
              status: 'failed',
              ok: false,
              error: `沙箱验证执行失败：${error?.message ?? error}`,
              commands: [],
              durationMs: 0,
              output: '',
            };
          }
        };

        // Verify inside the disposable sandbox before extracting fixes. The
        // real source tree is never written for validation.
        let verification = await runSandboxCheck(extracted.changedFiles);
        agentResult.verification = { scope: 'sandbox', mode: 'copy', ...verification };
        const verificationUi = verificationProgress(verification, '沙箱内');
        progress('selfcheck', verificationUi.label, verificationUi.level, verificationUi.detail);
        await runLog.info(`sandbox self-check ${verification.status} commands=${(verification.commands ?? []).length}`);

        if (verification.status === 'failed') {
          const recheckSandbox = async () => {
            extracted = await extractSandboxFixes(sandboxContext);
            agentResult.sandbox = {
              changedFiles: extracted.changedFiles,
              skipped: extracted.skipped,
            };
            verification = await runSandboxCheck(extracted.changedFiles);
            agentResult.verification = {
              scope: 'sandbox',
              mode: 'copy',
              ...verification,
            };
            const retryUi = verificationProgress(verification, '自动修复复验（沙箱）');
            progress('selfcheck', retryUi.label, retryUi.level, retryUi.detail);
            await runLog.info(`sandbox auto-repair recheck=${verification.status}`);
            return {
              verification,
              changedFiles: extracted.changedFiles,
              previousFixes: extracted.fixes,
              progress: (extracted.changedFiles?.length ?? 0) > 0,
            };
          };
          const repair = await attemptRepair({
            verification,
            phase: 'sandbox-self-check',
            changedFiles: extracted.changedFiles,
            previousFixes: extracted.fixes,
            recheck: recheckSandbox,
          });
          if (repair.attempted) {
            verification = repair.verification;
            agentResult.verification = {
              scope: 'sandbox',
              mode: 'copy',
              ...verification,
              repair: { ...repair.info, finalStatus: verification.status },
            };
          } else {
            agentResult.verification.repair = {
              attempted: false,
              skippedReason: repair.skippedReason ?? 'not-eligible',
            };
          }
        }

        let mergedFixes = mergeExtractedFixes(extracted.fixes, agentResult.fixes);
        if (verification.status === 'failed') {
          agentResult.fixesWithheld = mergedFixes;
          agentResult.fixes = [];
          agentResult.needsMoreInfo = [
            ...(agentResult.needsMoreInfo ?? []),
            `沙箱修改未通过构建或必需测试，已隐藏。${verification.error ?? ''}`.trim(),
          ];
        } else {
          agentResult.fixes = mergedFixes;
        }

        progress('sandbox', `沙箱修改 ${extracted.changedFiles.length} 个文件`, 'done');
        await runLog.info(`sandbox extracted=${extracted.fixes.length} skipped=${extracted.skipped.length}`);
      } catch (error) {
        agentResult.fixes = [];
        agentResult.needsMoreInfo = [
          ...(agentResult.needsMoreInfo ?? []),
          `沙箱修改提取失败，已隐藏修改建议：${error?.message ?? error}`,
        ];
        progress('sandbox', '沙箱修改提取失败', 'error', error?.message ?? String(error));
        await runLog.error(`sandbox extract failed: ${error?.message ?? error}`);
      } finally {
        await cleanupAgentSandbox(sandboxContext);
        sandboxContext = null;
      }
    }
  }

  // Full-permission edits land in the real workspace with no sandbox session.
  // Run an independent compile/test pass so an unverified edit cannot pass as
  // a fix. No command detected means the result is explicitly "skipped".
  if (!inPlaceUsed && !sandboxUsed && toolMode === 'full' && agent.id !== 'mock') {
    if (!wroteWorkspace) {
      agentResult.verification = {
        scope: 'workspace',
        mode: 'full',
        status: 'skipped',
        ok: true,
        reason: '本轮没有直接写入工作区的操作',
        commands: [],
        durationMs: 0,
        output: '',
      };
    } else {
      const runFullCheck = () => runWorkspaceCheck({
        roots: {
          sourceRoot: paths.sourceRoot,
          frontendSourceRoot: frontendFixRoot,
          extraSourceRoots,
        },
        verifyCommand,
        workspace,
        projectRoot: scenario.dir ?? process.cwd(),
        runDir,
      });
      progress('selfcheck', '构建/测试自检工作区修改', 'start');
      let verification = await runFullCheck();
      agentResult.verification = { scope: 'workspace', mode: 'full', ...verification };
      const reportVerification = (value) => {
        const ui = verificationProgress(value, '工作区');
        progress('selfcheck', ui.label, ui.level, ui.detail);
      };
      reportVerification(verification);
      await runLog.info(`workspace self-check ${verification.status} commands=${(verification.commands ?? []).length}`);
      if (verification.status === 'failed') {
        const recheckFull = async () => {
          verification = await runFullCheck();
          agentResult.verification = {
            scope: 'workspace',
            mode: 'full',
            ...verification,
          };
          reportVerification(verification);
          await runLog.info(`workspace auto-repair recheck=${verification.status}`);
          return {
            verification,
            changedFiles: [],
            previousFixes: agentResult.fixes,
            progress: true,
          };
        };
        const repair = await attemptRepair({
          verification,
          phase: 'workspace-self-check',
          changedFiles: [],
          previousFixes: agentResult.fixes,
          allowUnknownFiles: true,
          recheck: recheckFull,
        });
        if (repair.attempted) {
          verification = repair.verification;
          agentResult.verification = {
            scope: 'workspace',
            mode: 'full',
            ...verification,
            repair: { ...repair.info, finalStatus: verification.status },
          };
        } else {
          agentResult.verification.repair = {
            attempted: false,
            skippedReason: repair.skippedReason ?? 'not-eligible',
          };
        }
      }

      if (verification.status === 'failed') {
        agentResult.needsMoreInfo = [
          ...(agentResult.needsMoreInfo ?? []),
          `工作区修改未通过构建或必需测试：${verification.error ?? ''}`.trim(),
        ];
      } else if (verification.detectionError) {
        agentResult.needsMoreInfo = [
          ...(agentResult.needsMoreInfo ?? []),
          `未能验证工作区修改：${verification.reason ?? '命令探测失败'}`,
        ];
      }
    }
  }

  if (!inPlaceUsed) {
    // 2a: attach read-only diff previews; never write the working tree here.
    let staticChecks = 'strict';
    if (sandboxUsed || workspace.agent?.toolMode === 'full') {
      const commands = await detectCompileCommands({
        roots: {
          sourceRoot: paths.sourceRoot,
          frontendSourceRoot: frontendFixRoot,
          extraSourceRoots,
        },
        verifyCommand,
        workspace,
        projectRoot: scenario.dir ?? process.cwd(),
      }).catch(() => []);
      if (commands.length > 0) staticChecks = 'warn';
    }
    progress('preview', '生成修复预览', 'start');
    try {
      agentResult.fixes = await buildFixPreviews(agentResult.fixes, {
        sourceRoot: paths.sourceRoot,
        frontendSourceRoot: frontendFixRoot,
        extraSourceRoots,
        staticChecks,
      });
      progress('preview', '生成修复预览', 'done');
    } catch (error) {
      progress('preview', '生成修复预览失败', 'error');
      await runLog.error(`fix preview failed: ${error?.message ?? error}`);
    }

  }

  let effectiveSymptomStatus = symptomStatus;
  let symptomMethod = 'manual';
  let symptomObserved = null;
  let symptomReason = null;
  let symptomSignature = null;
  let replayInfo = null;
  let replayFixtureData = null;
  const filesChanged = (agentResult.fixes?.length ?? 0) > 0
    || (agentResult.workspaceSession?.changedFiles?.length ?? 0) > 0
    || (agentResult.sandbox?.changedFiles?.length ?? 0) > 0
    || (toolMode === 'full' && wroteWorkspace);
  const canReplayAfterFix = (inPlaceUsed || sandboxUsed || toolMode === 'full') && filesChanged;
  if (symptomStatus === 'pending' && !element && canReplayAfterFix && agentResult.verification?.status !== 'failed') {
    const fixtureResult = buildReplayFixture({ fired, workspace, scenario });
    if (!fixtureResult.ok) {
      symptomReason = fixtureResult.reason;
      replayInfo = { attempted: false, reason: fixtureResult.reason };
    } else {
      replayFixtureData = fixtureResult.fixture;
      symptomMethod = 'replay';
      progress('replay', '重放原始请求，验证症状是否消失', 'start');
      const before = responseSignature(fired.response ?? {});
      const replay = await replayFixture(fixtureResult.fixture, {
        fetchImpl: replayFetch ?? globalThis.fetch,
        timeoutMs: workspace.replay?.timeoutMs ?? 5000,
        extraHeaders: fixtureResult.credentialHeaders ?? {},
      });
      if (!replay.ok) {
        symptomReason = replay.reason;
        replayInfo = { attempted: true, reason: replay.reason, error: replay.error ?? null };
        progress('replay', '自动重放未能完成', 'error', replay.reason);
      } else {
        const after = responseSignature(replay.response);
        const comparison = compareSymptom(before, after);
        effectiveSymptomStatus = comparison.status;
        symptomReason = comparison.reason;
        symptomObserved = `HTTP ${after.httpStatus}${after.businessCode != null ? ` / code ${after.businessCode}` : ''}`;
        symptomSignature = { before, after };
        replayInfo = {
          attempted: true,
          credentials: fixtureResult.fixture.credentials ?? 'none',
          comparison,
          before,
          after,
        };
        progress(
          'replay',
          comparison.status === 'passed'
            ? '重放后症状已消失'
            : comparison.status === 'failed'
              ? '重放后症状仍存在'
              : '重放完成，但症状无法判定',
          comparison.status === 'passed' ? 'done' : comparison.status === 'failed' ? 'error' : 'done',
          comparison.reason,
        );
      }
      await runLog.info(`symptom replay status=${effectiveSymptomStatus} reason=${symptomReason ?? '-'}`);
    }
  }
  const symptomCheck = buildSymptomCheck({
    fired,
    element,
    scenario,
    status: effectiveSymptomStatus,
    method: symptomMethod,
    note: symptomNote,
    observed: symptomObserved,
    signature: symptomSignature,
    reason: symptomReason,
  });
  const gates = applySymptomToGates(
    applyVerificationGate(evaluateGates(fired, agentResult, elementContext, evidence), agentResult.verification),
    symptomCheck,
    agentResult.verification,
  );
  gates.remediation = {
    fixes: Array.isArray(agentResult.fixes) ? agentResult.fixes.length : 0,
    actions: Array.isArray(agentResult.actions) ? agentResult.actions.length : 0,
  };
  gates.actions = actionStatusCounts(agentResult.actions);
  const recheckInfo = recheck > 1
    ? (() => {
        const evaluation = evaluateRecheck(agentRuns, { responseStatus: fired.response?.status ?? null });
        return {
          runs: recheck,
          verdict: evaluation.verdict,
          checks: evaluation.checks,
          detail: evaluation.detail,
          conclusions: agentRuns.map((run) => run?.conclusion ?? ''),
          note: memoryNotes.length > 0
            ? '一致不等于正确；复检共享同一项目前提，一致性可能被放大'
            : '一致不等于正确',
        };
      })()
    : null;

  const endedAt = Date.now();
  let target;
  if (element) {
    target = {
      driver: 'element',
      selector: elementContext?.selector ?? element.selector ?? null,
      componentName: elementContext?.framework?.componentName ?? null,
      componentFile: elementContext?.framework?.componentFile
        ?? elementContext?.componentCandidates?.[0]?.file
        ?? null,
      pageUrl: elementContext?.page?.url ?? element.page?.url ?? null,
    };
  } else if (scenario.driverKind === 'browser') {
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

  // A query that fails mid-run only degrades the evidence, never the diagnosis.
  const failedDbQueries = toolsBundle.dbQueries.filter((query) => query.error);
  let finalDatabaseNotice = databaseNotice;
  if (failedDbQueries.length > 0) {
    const anySucceeded = toolsBundle.dbQueries.some((query) => !query.error);
    const reason = failedDbQueries[0].message || failedDbQueries[0].code || '未知错误';
    finalDatabaseNotice = anySucceeded
      ? `部分数据库查询失败（${reason}），未成功的部分已改用源码与日志分析。`
      : '数据库查询不可用，本次诊断仅通过源码与日志分析获得结论。';
    progress('database', '数据库查询失败，已降级', 'error', finalDatabaseNotice);
  }

  // Public connection labels only: passwords and resolved secrets must never
  // be written into a run artifact.
  const databaseLabels = databases.map((connection) => ({
    id: connection.id,
    name: connection.name,
    host: connection.host,
    port: connection.port,
    database: connection.database ?? '',
    allowWrite: Boolean(connection.allowWrite),
  }));

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
      triage: normalizedTriage,
      symptomStatus: symptomCheck.status,
      verificationLevel: gates.level,
      actionsCount: Array.isArray(agentResult.actions) ? agentResult.actions.length : 0,
      actionStatus: actionStatusCounts(agentResult.actions),
      runLog: 'run.log',
      incomplete: Boolean(agentResult.incomplete),
      incompleteReason: agentResult.incompleteReason ?? null,
      agentErrors: agentResult.errors ?? [],
      workspaceSessionStatus: agentResult.workspaceSession?.status ?? null,
      verificationStatus: agentResult.verification?.status ?? null,
      testStatus: agentResult.verification?.testStatus ?? null,
      testRequired: Boolean(agentResult.verification?.testRequired),
      testBlocking: Boolean(agentResult.verification?.testBlocking),
      workspaceNotice,
      memory: memoryContext
        ? {
            enabled: true,
            projectKey: memoryContext.project.key,
            projectName: memoryContext.project.name,
            noteCount: memoryNotes.length,
            used: memoryNotes.map((note) => ({
              id: note.id,
              kind: note.kind,
              source: note.source,
              text: note.text,
              runId: note.runId ?? null,
              lastSeenAt: note.lastSeenAt ?? null,
              pinned: Boolean(note.pinned),
            })),
            candidatesSaved: 0,
            candidatesUpdated: 0,
          }
        : {
            enabled: false,
            reason: memory?.reason ?? 'not-provided',
            noteCount: 0,
            used: [],
          },
      // Needed by 2b apply/undo to re-resolve fix files safely.
      fixRoots: {
        sourceRoot: paths.sourceRoot ?? null,
        frontendSourceRoot: frontendFixRoot,
        extraSourceRoots,
      },
      // Needed to rebuild read-only tools for follow-up turns.
      logContext: {
        logfiles: paths.logfiles,
        parser: scenario.parser,
        logEncoding: scenario.logEncoding,
        anchor: fired.firedAt,
        window: timeWindow,
        sourceRoot: paths.sourceRoot ?? null,
        frontendSourceRoot: frontendFixRoot,
        extraSourceRoots,
        databases: databaseLabels,
        activeDatabaseId,
        databaseNotice: finalDatabaseNotice,
      },
    },
    target,
    ...(element ? { element: evidence.element } : {}),
    request: { ...evidence.request, headers: redactHeaders(evidence.request?.headers) },
    response: { ...evidence.response, headers: redactHeaders(evidence.response?.headers) },
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
    databases: {
      activeId: activeDatabaseId,
      connections: databaseLabels,
      notice: finalDatabaseNotice,
    },
    // Query metadata points at <run>/db-queries/*.json. Removing the run
    // directory is therefore enough to remove every stored result.
    databaseQueries: toolsBundle.dbQueries,
    agent: agentResult,
    gates,
    symptomCheck,
    ...(replayFixtureData ? { replayFixture: replayFixtureData } : {}),
    ...(replayInfo ? { replay: replayInfo } : {}),
    recheck: recheckInfo,
  };

  const memoryCandidates = memoryProject ? buildMemoryCandidates(result) : [];
  if (memoryProject && typeof onMemory === 'function' && memoryCandidates.length > 0) {
    try {
      const saved = await onMemory({
        project: memoryProject,
        candidates: memoryCandidates,
        runId,
      });
      result.meta.memory.candidatesSaved = saved?.saved ?? 0;
      result.meta.memory.candidatesUpdated = saved?.updated ?? 0;
    } catch (error) {
      result.meta.memory.saveError = error?.message ?? String(error);
      await runLog.warn(`diagnosis memory save failed: ${error?.message ?? error}`);
    }
  }

  const report = buildReport(result);
  await writeFile(path.join(runDir, 'result.json'), JSON.stringify(result, null, 2), 'utf8');
  await writeFile(path.join(runDir, 'report.md'), renderMarkdown(report), 'utf8');
  // The preflight snapshot may hold decrypted connection objects; persist only
  // public labels so meta.json never contains database secrets.
  const safePreflight = preflight
    ? { ...preflight, databases: databaseLabels }
    : preflight;
  await writeFile(
    path.join(runDir, 'meta.json'),
    JSON.stringify({ ...result.meta, preflight: safePreflight }, null, 2),
    'utf8',
  );
  await runLog.info(`done durationMs=${Date.now() - startedAt} result=${runDir}`);
  progress('done', '诊断完成', 'done');

  return {
    result,
    runDir,
    runId,
    report,
    workspaceSession: inPlaceUsed ? sandboxContext : null,
  };
}

export async function runDiagnosis(scenario, options = {}) {
  const {
    runId = newRunId(),
    runsDir = path.resolve('runs'),
    question = '',
    triage = null,
    symptomStatus = 'pending',
    symptomNote = null,
    replayFetch = null,
    agent = createMockAgent(),
    recheck = 1,
    markerTimeoutMs = DEFAULT_MARKER_TIMEOUT_MS,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    driverContext = {},
    window,
    preflight: preflightOverride,
    databases = [],
    activeDatabaseId = null,
    approveWrite = null,
    databaseConnect,
    verifyCommand = '',
    workspace = {},
    sandbox = false,
    memory = null,
    onMemory = null,
    onProgress = () => {},
  } = options;

  const startedAt = Date.now();
  const preflight = preflightOverride ?? (await runPreflight(scenario, { databases }));
  if (!preflight.ok) {
    const failed = preflight.checks.filter((check) => !check.ok && check.severity === 'error');
    throw new AppError(
      'PREFLIGHT_FAILED',
      `Preflight failed: ${failed.map((check) => `${check.name}(${check.detail})`).join('; ')}`,
      { exitCode: 3, details: { checks: preflight.checks } },
    );
  }
  // Only connections that answered SELECT 1 are exposed to the agent. An
  // unreachable test database must not turn into a stream of tool failures.
  const reachableDatabases = preflight.databases ?? databases;
  const databaseNotice = buildDatabaseNotice(databases, reachableDatabases);

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
    triage,
    symptomStatus,
    symptomNote,
    replayFetch,
    agent,
    recheck,
    markerTimeoutMs,
    pollIntervalMs,
    preflight,
    startedAt,
    databases: reachableDatabases,
    activeDatabaseId,
    approveWrite,
    databaseConnect,
    databaseNotice,
    verifyCommand,
    workspace,
    sandbox,
    memory,
    onMemory,
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
    triage = null,
    symptomStatus = 'pending',
    symptomNote = null,
    replayFetch = null,
    agent = createMockAgent(),
    recheck = 1,
    markerTimeoutMs = DEFAULT_MARKER_TIMEOUT_MS,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    window,
    preflight: preflightOverride,
    allowExtraSources = false,
    databases = [],
    activeDatabaseId = null,
    approveWrite = null,
    databaseConnect,
    verifyCommand = '',
    sandbox = false,
    memory = null,
    onMemory = null,
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

  const preflight = preflightOverride ?? (await runCapturePreflight({ logfiles, sourceRoot, databases }));
  if (!preflight.ok) {
    const failed = preflight.checks.filter((check) => !check.ok && check.severity === 'error');
    throw new AppError(
      'PREFLIGHT_FAILED',
      `Preflight failed: ${failed.map((check) => `${check.name}(${check.detail})`).join('; ')}`,
      { exitCode: 3, details: { checks: preflight.checks } },
    );
  }
  const reachableDatabases = preflight.databases ?? databases;
  const databaseNotice = buildDatabaseNotice(databases, reachableDatabases);

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
    triage,
    symptomStatus,
    symptomNote,
    replayFetch,
    agent,
    recheck,
    markerTimeoutMs,
    pollIntervalMs,
    preflight,
    startedAt,
    databases: reachableDatabases,
    activeDatabaseId,
    approveWrite,
    databaseConnect,
    databaseNotice,
    verifyCommand,
    workspace,
    sandbox,
    memory,
    onMemory,
    onProgress,
  });
}

/**
 * Diagnose a UI element (display/style/data symptom) without replaying a request.
 * Reuses the capture pipeline but replaces request/response gates with element gates.
 *
 * @param {any} element element snapshot that came from the page picker
 * @param {any} [options]
 */
export async function runElementDiagnosis(element, options = {}) {
  const {
    workspace = {},
    root = process.cwd(),
    runId = newRunId(),
    runsDir = path.resolve('runs'),
    question = '',
    triage = null,
    symptomStatus = 'pending',
    symptomNote = null,
    replayFetch = null,
    agent = createMockAgent(),
    recheck = 1,
    markerTimeoutMs = DEFAULT_MARKER_TIMEOUT_MS,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    window,
    preflight: preflightOverride,
    allowExtraSources = false,
    databases = [],
    activeDatabaseId = null,
    approveWrite = null,
    databaseConnect,
    verifyCommand = '',
    sandbox = false,
    memory = null,
    onMemory = null,
    onProgress = () => {},
  } = options;

  if (!element || typeof element !== 'object') {
    throw new AppError('ELEMENT_REQUIRED', '缺少元素信息', { exitCode: 2 });
  }

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
  const frontendSourceRoot = configuredFrontendSourceRoot ?? frontendProjectRoot;
  const label = String(
    element.framework?.componentName
      || element.framework?.componentFile
      || element.selector
      || 'element',
  ).slice(0, 80);
  const scenario = {
    name: `element-${label}`,
    driverKind: 'element',
    logfiles,
    source: sourceRoot ? { root: sourceRoot } : undefined,
    extraSourceRoots: authorizedExtraRoots,
    extraSourcesConfigured: configuredExtraRoots.map(({ id, label: name }) => ({ id, label: name })),
    frontendSourceRoot,
    frontendProjectRoot,
    parser: { preset: workspace.logParser || 'auto' },
    logEncoding: 'auto',
    marker: { mode: 'none', header: 'X-DC-Probe' },
    window: window ?? workspace.window ?? { beforeMs: 3000, afterMs: 2000 },
    filePath: undefined,
    dir: root,
  };

  const preflight = preflightOverride ?? (await runCapturePreflight({ logfiles, sourceRoot, databases }));
  if (!preflight.ok) {
    const failed = preflight.checks.filter((check) => !check.ok && check.severity === 'error');
    throw new AppError(
      'PREFLIGHT_FAILED',
      `Preflight failed: ${failed.map((check) => `${check.name}(${check.detail})`).join('; ')}`,
      { exitCode: 3, details: { checks: preflight.checks } },
    );
  }
  const reachableDatabases = preflight.databases ?? databases;
  const databaseNotice = buildDatabaseNotice(databases, reachableDatabases);

  const runDir = path.resolve(runsDir, runId);
  await mkdir(runDir, { recursive: true });
  let elementForRun = element;
  if (element.screenshotDataUrl) {
    const match = /^data:image\/png;base64,(.+)$/s.exec(String(element.screenshotDataUrl));
    if (match) {
      try {
        const evidenceDir = path.join(runDir, 'evidence');
        await mkdir(evidenceDir, { recursive: true });
        await writeFile(path.join(evidenceDir, 'element.png'), Buffer.from(match[1], 'base64'));
      } catch (error) {
        await writeFile(path.join(runDir, 'run.log'), `screenshot save failed: ${error?.message ?? error}\n`, { flag: 'a' }).catch(() => {});
      }
    }
    const { screenshotDataUrl: _dataUrl, ...rest } = element;
    elementForRun = {
      ...rest,
      screenshot: match ? 'evidence/element.png' : null,
    };
  }
  const paths = resolveScenarioPaths(scenario);
  const timeWindow = scenario.window;
  const fired = {
    request: null,
    response: null,
    firedAt: Number(element.capturedAt) || startedAt,
    marker: { mode: 'none', injected: false, value: null, targets: { header: false, body: false } },
    consoleErrors: [],
  };

  return diagnoseWithFired({
    fired,
    scenario,
    paths,
    timeWindow,
    runId,
    runDir,
    question,
    triage,
    symptomStatus,
    symptomNote,
    replayFetch,
    agent,
    recheck,
    markerTimeoutMs,
    pollIntervalMs,
    preflight,
    startedAt,
    databases: reachableDatabases,
    activeDatabaseId,
    approveWrite,
    databaseConnect,
    databaseNotice,
    verifyCommand,
    workspace,
    sandbox,
    memory,
    onMemory,
    element: elementForRun,
    onProgress,
  });
}
