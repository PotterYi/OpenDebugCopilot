/**
 * Pretty-print JSON bodies for display. Non-JSON, invalid/truncated JSON and
 * very large payloads are returned unchanged.
 *
 * @param {unknown} text
 * @param {string} [mimeType]
 * @returns {unknown}
 */
export function formatBodyText(text, mimeType = '') {
  if (typeof text !== 'string') return text;
  const trimmed = text.trim();
  if (!trimmed) return text;
  const looksJson = /json/i.test(mimeType) || trimmed.startsWith('{') || trimmed.startsWith('[');
  if (!looksJson || trimmed.length > 256 * 1024) return text;
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch {
    return text;
  }
}
