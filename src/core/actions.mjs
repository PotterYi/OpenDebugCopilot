import { redactSecrets } from './redact.mjs';

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

export function actionSummaryLine(action) {
  const label = actionTypeLabel(action.type);
  return `[${label}] ${action.summary}`;
}
