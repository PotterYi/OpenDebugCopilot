import { redactSecrets } from './redact.mjs';
import { isSafeBashCommand } from './bash-policy.mjs';

export const ACTION_TYPES = Object.freeze({
  config: '配置',
  build: '构建',
  dependency: '依赖',
  runtime: '运行实例',
  data: '数据',
  deployment: '部署',
  environment: '环境',
});

export const ACTION_VERIFICATION_KINDS = Object.freeze({
  symptom: '重新确认症状',
  command: '命令/退出码',
  inspection: '人工检查',
  log: '日志检查',
  runtime: '运行态检查',
});

const RISKS = new Set(['low', 'medium', 'high']);
export const ACTION_EXECUTION_STATUSES = Object.freeze([
  'pending', 'confirmed', 'passed', 'failed', 'skipped', 'not-applicable',
]);
const MAX_ACTIONS = 5;

function text(value, max = 500) {
  return redactSecrets(String(value ?? '')).trim().slice(0, max);
}

function textList(value, maxItems, maxLength = 500) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => text(item, maxLength))
    .filter(Boolean)
    .slice(0, maxItems);
}

export function normalizeActionExecution(value = {}) {
  const raw = value && typeof value === 'object' ? value : {};
  return {
    status: ACTION_EXECUTION_STATUSES.includes(raw.status) ? raw.status : 'pending',
    method: ['command', 'symptom', 'manual'].includes(raw.method) ? raw.method : null,
    confirmedAt: typeof raw.confirmedAt === 'string' ? raw.confirmedAt : null,
    note: raw.note ? text(raw.note, 300) : null,
    result: raw.result && typeof raw.result === 'object' ? raw.result : null,
  };
}

function normalizeVerification(value) {
  const raw = value && typeof value === 'object' ? value : {};
  const kind = ACTION_VERIFICATION_KINDS[raw.kind] ? raw.kind : 'symptom';
  const description = text(raw.description, 500)
    || text(raw.expected, 500)
    || '执行动作后重新确认原症状是否消失';
  return {
    kind,
    description,
    command: raw.command ? text(raw.command, 1000) : null,
    expected: raw.expected ? text(raw.expected, 500) : null,
  };
}

function normalizeCommand(value, risk) {
  if (typeof value === 'string') {
    const command = text(value, 1000);
    return command ? { label: '执行', command, risk } : null;
  }
  if (!value || typeof value !== 'object') return null;
  const command = text(value.command, 1000);
  if (!command) return null;
  return {
    label: text(value.label, 100) || '执行',
    command,
    risk: RISKS.has(value.risk) ? value.risk : risk,
  };
}

export function normalizeActionList(input, { limit = MAX_ACTIONS } = {}) {
  if (!Array.isArray(input)) return [];
  const output = [];
  const seen = new Set();
  for (const item of input.slice(0, 20)) {
    if (!item || typeof item !== 'object') continue;
    const summary = text(item.summary, 300);
    const steps = textList(item.steps, 10, 500);
    if (!summary || steps.length === 0) continue;
    const type = ACTION_TYPES[item.type] ? item.type : 'environment';
    const risk = RISKS.has(item.risk) ? item.risk : 'medium';
    const key = `${type}\0${summary.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const commands = (Array.isArray(item.commands) ? item.commands : [])
      .map((command) => normalizeCommand(command, risk))
      .filter(Boolean)
      .slice(0, 5);
    output.push({
      id: text(item.id, 80) || `act-${output.length + 1}`,
      type,
      summary,
      reason: item.reason ? text(item.reason, 500) : null,
      requires: textList(item.requires, 10, 300),
      steps,
      commands,
      verification: normalizeVerification(item.verification),
      risk,
      reversible: typeof item.reversible === 'boolean' ? item.reversible : null,
      confirmationRequired: typeof item.confirmationRequired === 'boolean'
        ? item.confirmationRequired
        : risk !== 'low',
      execution: normalizeActionExecution(item.execution),
    });
    if (output.length >= limit) break;
  }
  return output;
}

export function actionTypeLabel(type) {
  return ACTION_TYPES[type] ?? type ?? '动作';
}

export function actionVerificationLabel(kind) {
  return ACTION_VERIFICATION_KINDS[kind] ?? kind ?? '验证';
}

export function actionExecutionLabel(status) {
  return {
    pending: '待执行',
    confirmed: '已执行（未验证）',
    passed: '验证通过',
    failed: '验证失败',
    skipped: '已跳过',
    'not-applicable': '不适用',
  }[status] ?? status ?? '待执行';
}

export function actionStatusCounts(actions = []) {
  const counts = { pending: 0, confirmed: 0, passed: 0, failed: 0, skipped: 0, 'not-applicable': 0 };
  for (const action of Array.isArray(actions) ? actions : []) {
    const status = ACTION_EXECUTION_STATUSES.includes(action?.execution?.status)
      ? action.execution.status
      : 'pending';
    counts[status] += 1;
  }
  return counts;
}

export function actionCommandAllowed(command) {
  return isSafeBashCommand(command);
}

export function actionSummaryLine(action) {
  const label = actionTypeLabel(action.type);
  return `[${label}] ${action.summary}`;
}
