import { normalizeFixList } from '../core/fixes.mjs';
import { redactSecrets } from '../core/redact.mjs';
import { TRIAGE_FIELDS, triageSummary } from '../core/triage.mjs';
import { actionTypeLabel, actionVerificationLabel } from '../core/actions.mjs';

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
  const triage = result.meta?.triage ?? null;
  return {
    target: {
      scenario: result.meta?.scenario ?? '(unknown)',
      driver: result.target?.driver ?? '(unknown)',
    },
    symptom: scrubText(result.meta?.question?.trim() ? result.meta.question : '(未提供描述)'),
    triage: {
      summary: scrubText(redactSecrets(triageSummary(triage))),
      entries: TRIAGE_FIELDS
        .filter((field) => triage?.labels?.[field.key])
        .map((field) => ({ label: field.label, value: scrubText(triage.labels[field.key]) })),
      note: triage?.note ? scrubText(redactSecrets(triage.note)) : null,
      skipped: !triage || Boolean(triage.skipped),
    },
    symptomCheck: result.symptomCheck
      ? {
          status: result.symptomCheck.status ?? 'pending',
          method: result.symptomCheck.method ?? 'manual',
          steps: (result.symptomCheck.steps ?? []).map((step) => scrubText(step)),
          expected: result.symptomCheck.expected ? scrubText(result.symptomCheck.expected) : null,
          observed: result.symptomCheck.observed ? scrubText(result.symptomCheck.observed) : null,
          note: result.symptomCheck.note ? scrubText(result.symptomCheck.note) : null,
          reason: result.symptomCheck.reason ? scrubText(result.symptomCheck.reason) : null,
          markedAt: result.symptomCheck.markedAt ?? null,
        }
      : null,
    verificationLevel: result.gates?.level ?? null,
    element: result.element
      ? {
          pageUrl: scrubText(result.element.page?.url ?? ''),
          route: scrubText(result.element.page?.route ?? ''),
          selector: scrubText(result.element.selector ?? ''),
          tag: result.element.tag ?? '',
          text: scrubText(result.element.text ?? ''),
          componentName: result.element.framework?.componentName ?? '',
          componentFile: scrubText(result.element.framework?.componentFile ?? ''),
          screenshot: result.element.screenshot ?? null,
          styles: result.element.styles ?? {},
        }
      : null,
    durationMs: result.meta?.durationMs ?? 0,
    conclusion: scrubText(agent.conclusion ?? ''),
    rejectedHypotheses: (Array.isArray(agent.rejectedHypotheses) ? agent.rejectedHypotheses : [])
      .slice(0, 5)
      .map((item) => ({
        hypothesis: scrubText(item.hypothesis ?? ''),
        reason: scrubText(item.reason ?? ''),
        refutedBy: (Array.isArray(item.refutedBy) ? item.refutedBy : []).slice(0, 3).map((ref) => ({
          type: ref.type ?? '',
          ref: scrubText(ref.ref ?? ''),
          note: ref.note ? scrubText(ref.note) : null,
        })),
      })),
    noRejectedHypothesesReason: agent.noRejectedHypothesesReason
      ? scrubText(agent.noRejectedHypothesesReason)
      : null,
    databaseNotice: result.databases?.notice ? scrubText(result.databases.notice) : null,
    fixValidation: agent.fixesValidation
      ? {
          status: agent.fixesValidation.status ?? 'unknown',
          error: scrubText(agent.fixesValidation.error ?? ''),
          reason: scrubText(agent.fixesValidation.reason ?? ''),
          commands: (agent.fixesValidation.commands ?? []).map((entry) => entry.command).filter(Boolean),
        }
      : null,
    verification: agent.verification
      ? {
          status: agent.verification.status ?? 'unknown',
          mode: agent.verification.mode ?? null,
          scope: agent.verification.scope ?? null,
          error: scrubText(agent.verification.error ?? ''),
          reason: scrubText(agent.verification.reason ?? ''),
          durationMs: agent.verification.durationMs ?? null,
          commands: (agent.verification.commands ?? []).map((entry) => entry.command).filter(Boolean),
          repair: agent.verification.repair
            ? {
                attempted: Boolean(agent.verification.repair.attempted),
                finalStatus: agent.verification.repair.finalStatus ?? null,
                skippedReason: agent.verification.repair.skippedReason ?? null,
                error: scrubText(agent.verification.repair.error ?? ''),
                failure: agent.verification.repair.failure
                  ? {
                      error: scrubText(agent.verification.repair.failure.error ?? ''),
                      errorLines: (agent.verification.repair.failure.errorLines ?? []).map((line) => scrubText(line)),
                      commands: (agent.verification.repair.failure.commands ?? []).map((entry) => scrubText(entry.command)),
                    }
                  : null,
                budget: agent.verification.repair.budget ?? null,
                usage: agent.verification.repair.usage
                  ? {
                      numTurns: agent.verification.repair.usage.numTurns ?? null,
                      costUsd: agent.verification.repair.usage.costUsd ?? null,
                    }
                  : null,
              }
            : null,
        }
      : null,
    fixes: normalizeFixList(agent.fixes).map((fix) => scrubText(formatFix(fix))),
    actions: (Array.isArray(agent.actions) ? agent.actions : []).map((action) => ({
      id: action.id ?? null,
      type: action.type ?? 'environment',
      typeLabel: actionTypeLabel(action.type),
      summary: scrubText(action.summary ?? ''),
      reason: action.reason ? scrubText(action.reason) : null,
      requires: (action.requires ?? []).map((item) => scrubText(item)),
      steps: (action.steps ?? []).map((item) => scrubText(item)),
      commands: (action.commands ?? []).map((command) => ({
        label: scrubText(command.label ?? '执行'),
        command: scrubText(command.command ?? ''),
        risk: command.risk ?? null,
      })),
      verification: action.verification
        ? {
            kind: action.verification.kind ?? 'symptom',
            kindLabel: actionVerificationLabel(action.verification.kind),
            description: scrubText(action.verification.description ?? ''),
            command: action.verification.command ? scrubText(action.verification.command) : null,
            expected: action.verification.expected ? scrubText(action.verification.expected) : null,
          }
        : null,
      risk: action.risk ?? null,
      reversible: action.reversible ?? null,
      confirmationRequired: Boolean(action.confirmationRequired),
    })),
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
      rejectedHypotheses: Array.isArray(agent.rejectedHypotheses) ? agent.rejectedHypotheses.length : 0,
      toolCalls: agent.toolCalls?.length ?? 0,
      turns: agent.usage?.numTurns ?? null,
      tokens: agent.usage?.totalTokens ?? null,
      cacheReadTokens: agent.usage?.cacheReadInputTokens ?? null,
      cacheCreationTokens: agent.usage?.cacheCreationInputTokens ?? null,
      provider: agent.usage?.provider ?? null,
      canonicalModel: agent.usage?.canonicalModel ?? null,
      costBasis: agent.usage?.costBasis ?? null,
      costEstimated: agent.usage?.costEstimated ?? null,
      costUsd: agent.usage?.costUsd ?? null,
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
function symptomStatusLabel(check) {
  if (!check) return '未生成';
  const labels = {
    pending: '待人工确认',
    passed: '已确认症状消失',
    failed: '仍存在',
    skipped: '无法验证',
  };
  return labels[check.status] ?? check.status;
}

function verificationLevelLabel(level) {
  return {
    verified: '已验证（编译/测试通过 + 症状确认）',
    'symptom-verified': '症状已确认（编译/测试未执行）',
    unverified: '待确认（编译/测试通过，症状未确认）',
    failed: '验证失败',
  }[level] ?? '未提供';
}

export function renderMarkdown(report) {
  const lines = [
    '# DebugCopilot 诊断报告',
    '',
    `- 场景：${report.target.scenario}（${report.target.driver}）`,
    `- 症状：${report.symptom}`,
    `- 验证：${verificationLevelLabel(report.verificationLevel)}`,
    `- 耗时：${report.durationMs} ms`,
    `- Run ID：${report.meta.runId ?? '(unknown)'}`,
    ...(report.element
      ? [
          `- 元素：${report.element.selector || '(unknown)'}`,
          `- 页面：${report.element.pageUrl || '(unknown)'}`,
          `- 组件：${report.element.componentFile || report.element.componentName || '(未解析)'}`,
        ]
      : []),
    ...(report.meta.incomplete
      ? [`- 状态：未完成（${report.meta.incompleteReason ?? 'unknown'}）`]
      : []),
    '',
    '## 诊断前提',
    '',
    ...(report.triage.entries.length > 0
      ? report.triage.entries.map((entry) => `- ${entry.label}：${entry.value}`)
      : ['- 前提信息：未提供（诊断前已跳过）']),
    ...(report.triage.note ? [`- 备注：${report.triage.note}`] : []),
    '',
    '## 症状验证',
    '',
    `- 状态：${symptomStatusLabel(report.symptomCheck)}`,
    ...(report.symptomCheck?.method ? [`- 方式：${report.symptomCheck.method === 'replay' ? '自动重放' : '人工确认'}`] : []),
    ...(report.symptomCheck?.steps?.length
      ? ['- 复现步骤：', ...report.symptomCheck.steps.map((step) => `  - ${step}`)]
      : []),
    ...(report.symptomCheck?.expected ? [`- 预期结果：${report.symptomCheck.expected}`] : []),
    ...(report.symptomCheck?.observed ? [`- 实际观察：${report.symptomCheck.observed}`] : []),
    ...(report.symptomCheck?.reason ? [`- 说明：${report.symptomCheck.reason}`] : []),
    ...(report.symptomCheck?.note ? [`- 备注：${report.symptomCheck.note}`] : []),
    ...(report.rejectedHypotheses?.length
      ? [
          '',
          '## 排除的假设',
          '',
          ...report.rejectedHypotheses.flatMap((item, index) => [
            `### ${index + 1}. ${item.hypothesis || '(未命名假设)'}`,
            '',
            `- 理由：${item.reason || '（未提供）'}`,
            ...item.refutedBy.map(
              (ref) => `- 否定证据：[${ref.type}] ${ref.ref}${ref.note ? ` — ${ref.note}` : ''}`,
            ),
            '',
          ]),
        ]
      : (report.noRejectedHypothesesReason
          ? ['', '## 排除的假设', '', `- 未形成可排除假设：${report.noRejectedHypothesesReason}`, '']
          : [])),
    '',
    '## 结论',
    '',
    report.conclusion || '(无结论)',
    ...(report.databaseNotice ? ['', `> ⚠ ${report.databaseNotice}`] : []),
  ];

  if (report.actions.length > 0) {
    lines.push('', '## 非代码修复动作', '');
    if (report.fixes.length === 0) {
      lines.push('本次结论不需要修改代码，请按以下动作处理。', '');
    }
    report.actions.forEach((action, index) => {
      lines.push(`### ${index + 1}. [${action.typeLabel}] ${action.summary}`);
      if (action.reason) lines.push('', `- 原因：${action.reason}`);
      if (action.requires.length > 0) lines.push('', '- 前置条件：', ...action.requires.map((item) => `  - ${item}`));
      lines.push('', '- 执行步骤：', ...action.steps.map((item) => `  - ${item}`));
      if (action.commands.length > 0) {
        lines.push('', '- 命令：', ...action.commands.map((command) => `  - ${command.label}：\`${command.command}\`${command.risk ? `（风险：${command.risk}）` : ''}`));
      }
      if (action.verification) {
        lines.push('', `- 验证（${action.verification.kindLabel}）：${action.verification.description}`);
        if (action.verification.expected) lines.push(`  - 预期：${action.verification.expected}`);
        if (action.verification.command) lines.push(`  - 验证命令：\`${action.verification.command}\``);
      }
      if (action.risk) lines.push(`- 风险：${action.risk}${action.reversible === true ? '；可逆' : action.reversible === false ? '；不可逆' : ''}`);
      lines.push('');
    });
  }
  if (report.fixes.length > 0) {
    lines.push('', '## 修复建议', '', ...report.fixes.map((fix) => `- ${fix}`));
  }
  if (report.needsMoreInfo.length > 0) {
    lines.push('', '## 待补充信息', '', ...report.needsMoreInfo.map((item) => `- ${item}`));
  }
  if (report.fixValidation) {
    const validation = report.fixValidation;
    const statusText = validation.status === 'passed'
      ? '通过'
      : validation.status === 'failed'
        ? '失败（修改建议已隐藏）'
        : `未执行（${validation.reason || '无编译命令'}）`;
    lines.push(
      '',
      '## 修改自测',
      '',
      `- 状态：${statusText}`,
      ...(validation.commands.length ? [`- 命令：${validation.commands.join('；')}`] : []),
      ...(validation.error ? [`- 错误：${validation.error}`] : []),
    );
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
    ...(report.summary.turns != null ? [`- 轮次：${report.summary.turns}`] : []),
    ...(report.summary.tokens != null ? [`- 消耗 Token：${report.summary.tokens}`] : []),
    ...(report.summary.cacheReadTokens != null
      ? [`- 缓存读/写：${report.summary.cacheReadTokens} / ${report.summary.cacheCreationTokens ?? 0}`]
      : []),
    ...(report.summary.provider || report.summary.canonicalModel
      ? [`- 模型/供应商：${report.summary.canonicalModel || '—'} / ${report.summary.provider || '—'}`]
      : []),
    ...(report.summary.costUsd != null
      ? [`- 成本：$${Number(report.summary.costUsd).toFixed(4)}${report.summary.costEstimated ? '（估算）' : ''}`]
      : []),
    ...(report.summary.frontendErrors
      ? [`- 前端错误：${report.summary.frontendErrors} 条（源码片段 ${report.summary.frontendSources} 处）`]
      : []),
    '',
    '## 自检',
    '',
    ...report.selfCheck.map((check) => `- ${check.name}：${yesNo(check.ok)}`),
  );

  if (report.verification) {
    const verification = report.verification;
    const statusLabel = verification.status === 'passed'
      ? '通过'
      : verification.status === 'failed'
        ? '失败'
        : '未执行';
    lines.push(
      '',
      '## 编译/测试验证',
      '',
      `- 状态：${statusLabel}${verification.mode ? `（${verification.mode}）` : ''}`,
      ...(verification.commands?.length ? [`- 命令：${verification.commands.join('；')}`] : []),
      ...(verification.durationMs ? [`- 耗时：${verification.durationMs} ms`] : []),
      ...(verification.error ? [`- 错误：${verification.error}`] : []),
      ...(verification.reason ? [`- 说明：${verification.reason}`] : []),
    );
    if (verification.repair) {
      const repair = verification.repair;
      const repairStatus = repair.attempted
        ? (repair.finalStatus === 'passed' ? '重试后通过' : '重试后仍失败')
        : `未执行（${repair.skippedReason ?? '不满足条件'}）`;
      lines.push(
        '',
        '## 修复重试',
        '',
        `- 状态：${repairStatus}`,
        ...(repair.failure?.commands?.length ? [`- 失败命令：${repair.failure.commands.join('；')}`] : []),
        ...(repair.failure?.errorLines?.length
          ? ['- 错误摘要：', ...repair.failure.errorLines.map((line) => `  - ${line}`)]
          : []),
        ...(repair.budget
          ? [`- 预算：${repair.budget.maxRounds ?? '?'} 轮 / $${repair.budget.maxBudgetUsd ?? '?'} / ${repair.budget.timeoutMs ?? '?'}ms`]
          : []),
        ...(repair.usage?.costUsd != null
          ? [`- 用量：${repair.usage.numTurns ?? '?'} 轮 / $${Number(repair.usage.costUsd).toFixed(4)}`]
          : []),
      );
    }
  }

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
