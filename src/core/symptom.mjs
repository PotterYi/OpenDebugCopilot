import { redactSecrets } from './redact.mjs';

export const SYMPTOM_STATUSES = new Set(['pending', 'passed', 'failed', 'skipped']);

function requestPath(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return String(url ?? '');
  }
}

export function buildSymptomSteps({ fired = null, element = null, scenario = null } = {}) {
  if (element) {
    return [
      `打开页面：${element.page?.url ?? '(unknown)'}`,
      `定位元素：${element.selector ?? '(unknown)'}`,
      '重新触发同一操作，观察该元素的显示/数据是否恢复正常',
    ].map((step) => redactSecrets(step));
  }
  if (fired?.request) {
    const method = fired.request.method ?? 'GET';
    const path = requestPath(fired.request.url);
    return [
      `重新触发请求：${method} ${path}`,
      fired.request.body ? '使用与本次捕获相同的请求体' : '使用与本次捕获相同的请求参数',
      '确认响应状态、业务错误码与页面提示是否恢复正常',
    ].map((step) => redactSecrets(step));
  }
  if (scenario) {
    return [
      `按场景重新操作：${scenario.name ?? 'original scenario'}`,
      '确认原症状是否再次出现',
    ].map((step) => redactSecrets(step));
  }
  return ['重新执行原始操作，确认原症状是否再次出现'].map((step) => redactSecrets(step));
}

export function buildSymptomCheck({
  fired = null,
  element = null,
  scenario = null,
  status = 'pending',
  method = 'manual',
  note = null,
  observed = null,
  signature = null,
  reason = null,
} = {}) {
  const normalizedStatus = SYMPTOM_STATUSES.has(status) ? status : 'pending';
  return {
    status: normalizedStatus,
    method: method === 'replay' ? 'replay' : 'manual',
    steps: buildSymptomSteps({ fired, element, scenario }),
    expected: '原始症状不再出现：同一请求/页面操作返回正常结果，且相关错误提示消失。',
    observed: observed ? redactSecrets(String(observed)).slice(0, 500) : null,
    note: note ? redactSecrets(String(note)).slice(0, 300) : null,
    reason: reason ? redactSecrets(String(reason)).slice(0, 300) : null,
    signature: signature ?? null,
    markedAt: normalizedStatus === 'pending' ? null : new Date().toISOString(),
  };
}

export function normalizeSymptomCheck(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  return {
    status: SYMPTOM_STATUSES.has(input.status) ? input.status : 'pending',
    method: input.method === 'replay' ? 'replay' : 'manual',
    steps: Array.isArray(input.steps) ? input.steps.filter((step) => typeof step === 'string').slice(0, 10) : [],
    expected: input.expected ? String(input.expected).slice(0, 500) : null,
    observed: input.observed ? String(input.observed).slice(0, 500) : null,
    note: input.note ? String(input.note).slice(0, 300) : null,
    reason: input.reason ? String(input.reason).slice(0, 300) : null,
    signature: input.signature ?? null,
    markedAt: typeof input.markedAt === 'string' ? input.markedAt : null,
  };
}

export function verificationLevel({ verification, symptomCheck } = {}) {
  if (verification?.status === 'failed') return 'failed';
  if (symptomCheck?.status === 'failed') return 'failed';
  if (symptomCheck?.status === 'passed') {
    return verification?.status === 'passed' ? 'verified' : 'symptom-verified';
  }
  return 'unverified';
}

export function applySymptomToGates(gates, symptomCheck, verification = null) {
  if (!gates) return gates;
  const level = verificationLevel({ verification, symptomCheck });
  gates.symptom = symptomCheck
    ? { status: symptomCheck.status, method: symptomCheck.method }
    : { status: 'pending', method: 'manual' };
  gates.level = level;
  return gates;
}
