import { redactSecrets } from './redact.mjs';

const ENV_FAILURE = /(?:Could not resolve dependencies|Non-resolvable parent POM|Could not transfer|Connection (?:refused|timed out)|UnknownHost|Temporary failure in name resolution|No such file or directory|not recognized as an internal|command not found|ENOTFOUND|EACCES|EPERM|OutOfMemory)/i;
const TEST_FAILURE = /(?:Tests run:|AssertionError|FAILED|expected:|but was:)/i;
const ERROR_LINE = /(?:error:|\[ERROR\]|FAILURE|Tests run:|AssertionError|Exception|cannot find symbol|COMPILATION ERROR)/i;

export function extractErrorLines(output, limit = 20) {
  const lines = String(output ?? '')
    .replace(/\x1b\[[0-9;]*m/g, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && ERROR_LINE.test(line));
  return [...new Set(lines)].slice(0, limit).map((line) => redactSecrets(line).slice(0, 300));
}

function normalizeChangedFile(entry) {
  if (typeof entry === 'string') return entry;
  return entry?.file ?? entry?.relative ?? entry?.path ?? null;
}

export function buildRepairFailure({
  verification,
  phase,
  changedFiles = [],
  previousFixes = [],
  attempt = 1,
} = {}) {
  const output = String(verification?.output ?? '');
  return {
    attempt,
    phase,
    status: 'failed',
    error: redactSecrets(verification?.error ?? '编译/测试验证失败'),
    commands: (verification?.commands ?? []).map((entry) => ({
      command: redactSecrets(entry.command ?? ''),
      exitCode: entry.exitCode ?? null,
      timedOut: Boolean(entry.timedOut),
      durationMs: entry.durationMs ?? null,
    })),
    errorLines: extractErrorLines(output),
    outputTail: redactSecrets(output.slice(-4000)),
    changedFiles: changedFiles.map(normalizeChangedFile).filter(Boolean).slice(0, 50),
    previousFixSummaries: previousFixes
      .map((fix) => (typeof fix === 'string' ? fix : fix?.summary ?? fix?.file))
      .filter(Boolean)
      .slice(0, 10),
    instruction: '只修复本次失败；不要重复相同修改；不要删除/跳过测试；环境/依赖问题请停止并说明。',
  };
}

export function shouldAutoRepair({
  verification,
  changedFiles = [],
  recheck = 1,
  enabled = true,
  allowUnknownFiles = false,
} = {}) {
  if (!enabled) return { ok: false, reason: 'disabled' };
  if (recheck > 1) return { ok: false, reason: 'recheck' };
  if (verification?.status !== 'failed') return { ok: false, reason: 'not-failed' };
  if (verification?.detectionError) return { ok: false, reason: 'command-detection' };
  if ((verification?.commands ?? []).some((entry) => entry.timedOut)) {
    return { ok: false, reason: 'timeout' };
  }
  const files = changedFiles.map(normalizeChangedFile).filter(Boolean);
  if (files.length === 0 && !allowUnknownFiles) return { ok: false, reason: 'no-changed-files' };
  const output = String(verification?.output ?? '');
  if (ENV_FAILURE.test(output)) return { ok: false, reason: 'environment' };
  if (allowUnknownFiles && files.length === 0) return { ok: true };
  const text = output.toLowerCase();
  const related = files.some((file) => {
    const base = String(file).split('/').pop() ?? '';
    if (!base) return false;
    const stem = base.replace(/\.[^.]+$/, '');
    return text.includes(base.toLowerCase())
      || (stem.length >= 4 && text.includes(stem.toLowerCase()));
  });
  if (!related && !TEST_FAILURE.test(output)) {
    return { ok: false, reason: 'unrelated-failure' };
  }
  return { ok: true };
}

export function planRepairBudget({ workspace = {}, usage = null, config = null } = {}) {
  const retry = config ?? workspace.agent?.repairRetry ?? {};
  if (retry.enabled === false) return { ok: false, reason: 'disabled' };
  const maxTurns = Math.max(1, Math.min(12, Number(retry.maxTurns ?? 6) || 6));
  const maxBudgetUsd = Math.max(0.01, Number(retry.maxBudgetUsd ?? 1) || 1);
  const timeoutMs = Math.max(10_000, Math.min(600_000, Number(retry.timeoutMs ?? 120_000) || 120_000));
  const globalMax = Number(workspace.agent?.maxBudgetUsd);
  const spent = Number(usage?.costUsd ?? 0) || 0;
  const remaining = Number.isFinite(globalMax) && globalMax > 0
    ? globalMax - spent
    : maxBudgetUsd;
  const budgetUsd = Math.min(maxBudgetUsd, remaining);
  if (!Number.isFinite(budgetUsd) || budgetUsd <= 0.01) {
    return { ok: false, reason: 'budget', remaining: Number.isFinite(remaining) ? remaining : 0 };
  }
  return {
    ok: true,
    budget: {
      maxRounds: maxTurns,
      maxBudgetUsd: Number(budgetUsd.toFixed(4)),
      timeoutMs,
    },
  };
}

const SUM_KEYS = [
  'numTurns',
  'costUsd',
  'durationMs',
  'inputTokens',
  'outputTokens',
  'thinkingTokens',
  'cacheReadInputTokens',
  'cacheCreationInputTokens',
  'cacheCreationEphemeral5mInputTokens',
  'cacheCreationEphemeral1hInputTokens',
  'totalInputTokens',
  'totalTokens',
];

export function mergeUsage(base, extra) {
  if (!base) return extra;
  if (!extra) return base;
  const merged = { ...base };
  for (const key of SUM_KEYS) {
    const a = Number(base[key]);
    const b = Number(extra[key]);
    if (Number.isFinite(a) || Number.isFinite(b)) {
      merged[key] = (Number.isFinite(a) ? a : 0) + (Number.isFinite(b) ? b : 0);
    }
  }
  merged.provider = extra.provider ?? base.provider ?? null;
  merged.canonicalModel = extra.canonicalModel ?? base.canonicalModel ?? null;
  merged.costBasis = extra.costBasis ?? base.costBasis ?? null;
  merged.costEstimated = Boolean(base.costEstimated || extra.costEstimated);
  merged.models = [...(base.models ?? []), ...(extra.models ?? [])];
  merged.perTurn = [
    ...(base.perTurn ?? []),
    ...(extra.perTurn ?? []).map((turn) => ({ ...turn, attempt: 2 })),
  ];
  return merged;
}
