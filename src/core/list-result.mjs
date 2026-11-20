export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;
export const MAX_TOTAL_ITEMS = 20_000;
export const MAX_PAGE_OFFSET = MAX_TOTAL_ITEMS;

export function pageArgs({ offset = 0, limit = DEFAULT_PAGE_SIZE } = {}) {
  const numericOffset = Number(offset ?? 0);
  const numericLimit = Number(limit ?? DEFAULT_PAGE_SIZE);
  if (!Number.isInteger(numericOffset) || numericOffset < 0 || numericOffset > MAX_PAGE_OFFSET) {
    return { error: `offset must be an integer between 0 and ${MAX_PAGE_OFFSET}` };
  }
  if (!Number.isInteger(numericLimit) || numericLimit < 1 || numericLimit > MAX_PAGE_SIZE) {
    return { error: `limit must be an integer between 1 and ${MAX_PAGE_SIZE}` };
  }
  return { offset: numericOffset, limit: numericLimit };
}

export function pageItems(items, { offset = 0, limit = DEFAULT_PAGE_SIZE } = {}) {
  const source = Array.isArray(items) ? items : [];
  const capped = source.length > MAX_TOTAL_ITEMS;
  const droppedCount = capped ? source.length - MAX_TOTAL_ITEMS : 0;
  const list = capped ? source.slice(0, MAX_TOTAL_ITEMS) : source;
  const start = Math.min(offset, list.length);
  const end = Math.min(start + limit, list.length);
  return {
    items: list.slice(start, end),
    total: list.length,
    offset: start,
    limit,
    nextOffset: end < list.length ? end : null,
    truncated: end < list.length,
    capped,
    droppedCount,
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
    capped: Boolean(page.capped || meta.capped),
    droppedCount: page.droppedCount || Number(meta.droppedCount) || 0,
    ...(file ? { file } : {}),
    fields,
  };
}
