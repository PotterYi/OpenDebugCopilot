import iconv from 'iconv-lite';

/**
 * Decode source/config text with a strict UTF-8 pass and a GBK fallback.
 * Log files already use streaming encoding detection; source files use this
 * helper so Chinese GBK projects are searchable too.
 */
export function decodeTextBuffer(value) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value ?? '');
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    return { text: text.replace(/^﻿/, ''), encoding: 'utf8' };
  } catch {
    return { text: iconv.decode(buffer, 'gbk').replace(/^﻿/, ''), encoding: 'gbk' };
  }
}
