import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_PAGE_OFFSET,
  MAX_TOTAL_ITEMS,
  listEnvelope,
  pageArgs,
  pageItems,
} from '../../src/core/list-result.mjs';

test('the last reachable page is always actually reachable', () => {
  const items = Array.from({ length: MAX_TOTAL_ITEMS }, (_, index) => index);
  const last = pageItems(items, { offset: MAX_TOTAL_ITEMS - 200, limit: 200 });
  assert.equal(last.items.length, 200);
  assert.equal(last.nextOffset, null);
  assert.equal(last.capped, false);
  assert.equal(pageArgs({ offset: MAX_PAGE_OFFSET, limit: 200 }).error, undefined);
  assert.ok(pageArgs({ offset: MAX_PAGE_OFFSET + 1, limit: 200 }).error);
});

test('lists over the total limit are capped explicitly', () => {
  const items = Array.from({ length: MAX_TOTAL_ITEMS + 25 }, (_, index) => index);
  const page = pageItems(items, { offset: MAX_TOTAL_ITEMS - 200, limit: 200 });
  assert.equal(page.total, MAX_TOTAL_ITEMS);
  assert.equal(page.capped, true);
  assert.equal(page.droppedCount, 25);
  assert.equal(page.nextOffset, null);

  const envelope = listEnvelope({ field: 'items', items, offset: 0, limit: 50 });
  assert.equal(envelope.capped, true);
  assert.equal(envelope.droppedCount, 25);
  assert.equal(envelope.totalCount, MAX_TOTAL_ITEMS);
});
