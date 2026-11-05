import { normalizeFixList } from '../core/fixes.mjs';

/**
 * Whitelist projection + Markdown rendering for the redacted report.
 * The report deliberately excludes: absolute paths, header values, log/source raw text.
 */

const REDACTIONS = [
  [/[A-Za-z]:\\[^\s"'`<>|，。；：、！？,;:)\]}]+/g, '<path>'],
  [/\/(?:Users|home|var|opt|tmp|mnt|g)\/[^\s"'`<>|，。；：、！？,;:)\]}]*/g, '<path>'],
  [/\bBearer\s+[A-Za-z0-9._-]+/gi, 'Bearer <redacted>'],
  [/\b(?:sk-ant-|ghp_|github_pat_)[A-Za-z0-9_-]+/g, '<redacted>'],
];

function scrubText(value) {
  if (typeof value !== 'string') return value;
  return REDACTIONS.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), value);
}

function formatFix(fix) {
  const parts = [fix.summary];
  const fileLabel = fix.root === 'extra' && fix.extraRoot ? `${fix.extraRoot}/${fix.file}` : fix.file;
  if (fileLabel) parts.push(`文件：${fileLabel}`);
  if (fix.risk) parts.push(`风险：${fix.risk}`);
  if (fix.verification) parts.push(`验证：${fix.verification}`);
  return parts.join('；');
}

function requestPath(url) {
  if (!url) return '(unknown)';
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return '(unknown)';
  }
}

/**
 * @param {any} result DiagnosisResult
 */
export function buildReport(result) {
  const logs = result.logs ?? {};
  const agent = result.agent ?? {};
  return {
    target: {
      scenario: result.meta?.scenario ?? '(unknown)',
      driver: result.target?.driver ?? '(unknown)',
    },
    symptom: scrubText(result.meta?.question?.trim() ? result.meta.question : '(未提供描述)'),
    durationMs: result.meta?.durationMs ?? 0,
    conclusion: scrubText(agent.conclusion ?? ''),
    fixes: normalizeFixList(agent.fixes).map((fix) => scrubText(formatFix(fix))),
    needsMoreInfo: (agent.needsMoreInfo ?? []).map((item) => scrubText(item)),
    request: {
      method: result.request?.method ?? null,
      path: requestPath(result.request?.url),
      status: result.response?.status ?? null,
      durationMs: result.response?.durationMs ?? null,
    },
    summary: {
      logs: logs.count ?? 0,
      markerMatched: Boolean(logs.markerMatched),
      markerInjected: Boolean(result.marker?.injected),
      threads: result.threads?.total ?? 0,
      sourceFiles: result.source?.files?.length ?? 0,
      toolCalls: agent.toolCalls?.length ?? 0,
      confidence: agent.confidence ?? null,
      correlation: result.logs?.correlation?.strategy ?? null,
      correlationId: result.logs?.correlation?.matchedId ?? null,
      frontendErrors: result.frontend?.errors?.length ?? 0,
      frontendSources: result.frontend?.files?.length ?? 0,
    },
    selfCheck: (result.gates?.checks ?? []).map((check) => ({ name: check.name, ok: check.ok })),
    recheck: result.recheck
      ? {
          verdict: result.recheck.verdict,
          runs: result.recheck.runs,
          note: result.recheck.note,
          checks: result.recheck.checks ?? [],
          detail: result.recheck.detail ?? '',
        }
      : null,
    meta: {
      runId: result.meta?.runId ?? null,
      agent: result.meta?.agent ?? null,
      mode: result.meta?.mode ?? null,
      incomplete: Boolean(result.meta?.incomplete),
      incompleteReason: result.meta?.incompleteReason ?? null,
      startedAt: result.meta?.startedAt ?? null,
      endedAt: result.meta?.endedAt ?? null,
    },
  };
}

function yesNo(value) {
  return value ? '通过' : '失败';
}

function correlationText(report) {
  const strategy = report.summary.correlation;
  const id = report.summary.correlationId;
  if (!strategy || strategy === 'none') return '未匹配到日志';
  const labels = {
    marker: 'marker',
    'business-id': 'business-id',
    'trace-id': 'trace-id',
    'window-thread': '时间窗 + 线程',
    'time-window': '时间窗兜底（可能混入其他请求）',
  };
  return `${labels[strategy] ?? strategy}${id ? `（${id}）` : ''}`;
}

/**
 * @param {ReturnType<typeof buildReport>} report
 * @returns {string}
 */
export function renderMarkdown(report) {
  const lines = [
    '# DebugCopilot 诊断报告',
    '',
    `- 场景：${report.target.scenario}（${report.target.driver}）`,
    `- 症状：${report.symptom}`,
    `- 耗时：${report.durationMs} ms`,
    `- Run ID：${report.meta.runId ?? '(unknown)'}`,
    ...(report.meta.incomplete
      ? [`- 状态：未完成（${report.meta.incompleteReason ?? 'unknown'}）`]
      : []),
    '',
    '## 结论',
    '',
    report.conclusion || '(无结论)',
  ];

  if (report.fixes.length > 0) {
    lines.push('', '## 修复建议', '', ...report.fixes.map((fix) => `- ${fix}`));
  }
  if (report.needsMoreInfo.length > 0) {
    lines.push('', '## 待补充信息', '', ...report.needsMoreInfo.map((item) => `- ${item}`));
  }

  lines.push(
    '',
    '## 请求摘要',
    '',
    `- 方法：${report.request.method ?? '(unknown)'}`,
    `- 路径：${report.request.path}`,
    `- 状态码：${report.request.status ?? '(no response)'}`,
    `- 响应耗时：${report.request.durationMs ?? '-'} ms`,
    '',
    '## 证据摘要',
    '',
    `- 日志命中：${report.summary.logs} 条`,
    `- 日志关联：${correlationText(report)}`,
    ...(report.summary.markerInjected
      ? [`- marker：${report.summary.markerMatched ? '已匹配' : '已注入但未匹配'}`]
      : []),
    `- 线程数：${report.summary.threads}`,
    `- 源码片段：${report.summary.sourceFiles} 处`,
    `- 工具调用：${report.summary.toolCalls} 次`,
    ...(report.summary.frontendErrors
      ? [`- 前端错误：${report.summary.frontendErrors} 条（源码片段 ${report.summary.frontendSources} 处）`]
      : []),
    '',
    '## 自检',
    '',
    ...report.selfCheck.map((check) => `- ${check.name}：${yesNo(check.ok)}`),
  );

  if (report.recheck) {
    lines.push(
      '',
      '## 多次复核',
      '',
      `- 运行次数：${report.recheck.runs}`,
      `- 判定：${report.recheck.verdict}`,
      ...(report.recheck.checks ?? []).map(
        (check) => `- 检查 ${check.name}：${check.ok ? '通过' : '不一致'}（${check.detail}）`,
      ),
      `- 说明：${report.recheck.note}`,
    );
  }

  lines.push(
    '',
    '---',
    '',
    '> 本报告经过白名单投影：不包含绝对路径、请求头值、日志与源码原文。',
    '',
  );
  return lines.join('\n');
}
