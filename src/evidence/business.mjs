/**
 * Detect RuoYi-style business errors: HTTP 200 with {"code":500,...}.
 * Returns null for non-JSON/valid payloads.
 *
 * @param {unknown} text
 * @returns {{ code: number, message: string } | null}
 */
export function detectBusinessError(text) {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    const parsed = JSON.parse(trimmed);
    const code = Number(parsed.code ?? parsed.status);
    if (Number.isFinite(code) && code >= 400) {
      return { code, message: String(parsed.msg ?? parsed.message ?? '') };
    }
  } catch {
    return null;
  }
  return null;
}
