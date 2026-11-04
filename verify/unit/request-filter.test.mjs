import test from 'node:test';
import assert from 'node:assert/strict';
import { REQUEST_FILTERS, matchesRequestFilter } from '../../src/ui/request-filter.mjs';

const items = [
  { resourceType: 'XHR' },
  { resourceType: 'Fetch' },
  { resourceType: 'Script' },
  { resourceType: 'Document' },
  { resourceType: null },
];

test('exposes all/backend/script filters', () => {
  assert.deepEqual(REQUEST_FILTERS.map((item) => item.id), ['all', 'backend', 'script']);
});

test('backend filter matches XHR and Fetch only', () => {
  const matched = items.filter((item) => matchesRequestFilter(item, 'backend'));
  assert.deepEqual(matched.map((item) => item.resourceType), ['XHR', 'Fetch']);
});

test('script filter matches frontend scripts only', () => {
  const matched = items.filter((item) => matchesRequestFilter(item, 'script'));
  assert.deepEqual(matched.map((item) => item.resourceType), ['Script']);
});

test('unknown and default filters keep everything', () => {
  assert.equal(items.filter((item) => matchesRequestFilter(item)).length, items.length);
  assert.equal(items.filter((item) => matchesRequestFilter(item, 'all')).length, items.length);
  assert.equal(items.filter((item) => matchesRequestFilter(item, 'other')).length, items.length);
});
