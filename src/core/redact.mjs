const PATTERNS = [
  [/(sk-ant-[A-Za-z0-9_-]{16,})/g, 'sk-ant-<redacted>'],
  [/\b(sk-[A-Za-z0-9_-]{20,})\b/g, 'sk-<redacted>'],
  [/\b(ghp_[A-Za-z0-9]{20,})\b/g, 'ghp_<redacted>'],
  [/\b(github_pat_[A-Za-z0-9_]{20,})\b/g, 'github_pat_<redacted>'],
  [/\b(AKIA[0-9A-Z]{16})\b/g, 'AKIA<redacted>'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '<redacted-jwt>'],
  [/(Bearer\s+)[A-Za-z0-9._~+/=-]{16,}/gi, '$1<redacted>'],
  [/(Basic\s+)[A-Za-z0-9+/=]{8,}/gi, '$1<redacted>'],
  [/((?:password|passwd|pwd|secret|client[_-]?secret|token|auth[_-]?token|api[_-]?key|access[_-]?key|private[_-]?key)\s*[:=]\s*['"])([^'"\s]{6,})(['"])/gi, '$1<redacted>$3'],
  [/((?:password|passwd|pwd|secret|client[_-]?secret|token|auth[_-]?token|api[_-]?key|access[_-]?key|private[_-]?key)\s*[:=]\s*)([^\s'",;}]{6,})/gi, '$1<redacted>'],
  [/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, '-----BEGIN PRIVATE KEY-----\n<redacted>\n-----END PRIVATE KEY-----'],
  [/(\/\/[^:\/\s]+:)([^@\/\s]+)(@)/g, '$1<redacted>$3'],
];

// Object keys whose value is a credential regardless of its shape (database
// rows, JSON API bodies, headers). Anchored so fields such as tokenCount survive.
const SENSITIVE_KEY = /^(?:password|passwd|pwd|secret|client[_-]?secret|secret[_-]?key|token|auth[_-]?token|access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|access[_-]?key|private[_-]?key|authorization|cookie|set-cookie|x-api-key|credentials)$/i;

export function redactSecrets(text) {
  let out = String(text ?? '');
  for (const [pattern, replacement] of PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

export function redactValue(value, depth = 0) {
  if (typeof value === 'string') return redactSecrets(value);
  if (value === null || value === undefined) return value;
  if (depth > 8) return '<redacted:depth>';
  if (Array.isArray(value)) return value.map((item) => redactValue(item, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = SENSITIVE_KEY.test(key) ? '<redacted>' : redactValue(item, depth + 1);
    }
    return out;
  }
  return value;
}
