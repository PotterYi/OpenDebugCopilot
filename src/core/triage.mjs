/**
 * Pre-diagnosis triage: 2-3 questions that narrow the hypothesis space before
 * the agent starts. Answers are user priors, not verified evidence.
 */

export const TRIAGE_OPTIONS = {
  environment: [
    { value: 'unknown', label: '不确定 / 尚未验证' },
    { value: 'local-only', label: '仅本机复现' },
    { value: 'deploy-only', label: '仅部署环境复现' },
    { value: 'both', label: '本机与部署都复现' },
  ],
  scope: [
    { value: 'unknown', label: '不确定' },
    { value: 'endpoint', label: '仅当前接口/页面' },
    { value: 'module', label: '同模块多个接口' },
    { value: 'service', label: '整个服务/多个模块' },
  ],
  change: [
    { value: 'unknown', label: '不确定' },
    { value: 'dependency', label: '依赖或版本升级' },
    { value: 'config', label: '配置/环境变量/部署脚本' },
    { value: 'code', label: '业务代码' },
    { value: 'none', label: '没有明显变更' },
  ],
};

export const TRIAGE_FIELDS = [
  { key: 'environment', label: '复现环境' },
  { key: 'scope', label: '影响范围' },
  { key: 'change', label: '最近变更' },
];

const VALID_VALUES = new Map(
  Object.entries(TRIAGE_OPTIONS).map(([key, options]) => [
    key,
    new Map(options.map((option) => [option.value, option.label])),
  ]),
);

/**
 * Sanitize a triage payload. Unknown keys/values are discarded so arbitrary
 * text from a client cannot change the prompt contract.
 *
 * @param {any} input
 * @returns {{ asked: boolean, skipped: boolean, answers: Record<string,string>, labels: Record<string,string>, note: string|null, askedAt: string } | null}
 */
export function normalizeTriage(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const source = input.answers && typeof input.answers === 'object' ? input.answers : input;
  const answers = {};
  const labels = {};
  for (const field of TRIAGE_FIELDS) {
    const value = source[field.key];
    const label = VALID_VALUES.get(field.key)?.get(value);
    if (label) {
      answers[field.key] = value;
      labels[field.key] = label;
    }
  }
  const note = typeof input.note === 'string' && input.note.trim()
    ? input.note.trim().slice(0, 300)
    : null;
  const skipped = input.skipped === true;
  if (!skipped && Object.keys(answers).length === 0 && !note) return null;
  const askedAt = typeof input.askedAt === 'string' && !Number.isNaN(Date.parse(input.askedAt))
    ? new Date(input.askedAt).toISOString()
    : new Date().toISOString();
  return { asked: input.asked !== false, skipped, answers, labels, note, askedAt };
}

export function triagePromptLines(triage) {
  const normalized = normalizeTriage(triage);
  if (!normalized) return ['（未提供；诊断前未收集）'];
  if (normalized.skipped && Object.keys(normalized.labels).length === 0 && !normalized.note) {
    return ['（用户跳过诊断前确认）'];
  }
  const lines = TRIAGE_FIELDS
    .filter((field) => normalized.labels[field.key])
    .map((field) => `- ${field.label}：${normalized.labels[field.key]}`);
  if (normalized.note) lines.push(`- 备注：${normalized.note}`);
  return lines.length > 0 ? lines : ['（未提供有效答案）'];
}

export function triageSummary(triage) {
  const normalized = normalizeTriage(triage);
  if (!normalized) return '未提供（诊断前已跳过）';
  if (normalized.skipped && Object.keys(normalized.labels).length === 0 && !normalized.note) {
    return '未提供（诊断前已跳过）';
  }
  const parts = TRIAGE_FIELDS
    .filter((field) => normalized.labels[field.key])
    .map((field) => normalized.labels[field.key]);
  if (normalized.note) parts.push(`备注：${normalized.note}`);
  return parts.length > 0 ? parts.join(' / ') : '未提供有效答案';
}
