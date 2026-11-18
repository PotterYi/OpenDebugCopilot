export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;
export const MAX_PAGE_OFFSET = 10_000;

export function pageArgs({ offset = 0, limit = DEFAULT_PAGE_SIZE } = {}) {
  const numericOffset = Number(offset ?? 0);
  const numericLimit = Number(limit ?? DEFAULT_PAGE_SIZE);
  if (!Number.isInteger(numericOffset) || numericOffset < 0 || numericOffset > MAX_PAGE_OFFSET) {
    return { error: 'offset must be an integer between 0 and 10000' };
  }
  if (!Number.isInteger(numericLimit) || numericLimit < 1 || numericLimit > MAX_PAGE_SIZE) {
    return { error: `limit must be an integer between 1 and ${MAX_PAGE_SIZE}` };
  }
  return { offset: numericOffset, limit: numericLimit };
}

export function pageItems(items, { offset = 0, limit = DEFAULT_PAGE_SIZE } = {}) {
  const list = Array.isArray(items) ? items : [];
  const start = Math.min(offset, list.length);
  const end = Math.min(start + limit, list.length);
  return {
    items: list.slice(start, end),
    total: list.length,
    offset: start,
    limit,
    nextOffset: end < list.length ? end : null,
    truncated: end < list.length,
  };
}

export function listEnvelope({
  field,
  items,
  offset,
  limit,
  meta = {},
  file = null,
  fields = [field],
} = {}) {
  const page = pageItems(items, { offset, limit });
  return {
    ...meta,
    [field]: page.items,
    totalCount: page.total,
    offset: page.offset,
    limit: page.limit,
    nextOffset: page.nextOffset,
    truncated: page.truncated,
    ...(file ? { file } : {}),
    fields,
  };
}
