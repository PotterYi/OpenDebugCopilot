import test from 'node:test';
import assert from 'node:assert/strict';
import { formatBodyText } from '../../src/ui/format-body.mjs';

test('pretty prints minified JSON', () => {
  const formatted = formatBodyText('{"code":200,"data":{"rows":[1,2]}}', 'application/json; charset=utf-8');
  assert.match(formatted, /\n  "code": 200,/);
  assert.match(formatted, /\n {4}"rows": \[/);
});

test('detects JSON by shape when mime is missing', () => {
  const formatted = formatBodyText('{"a":1}');
  assert.match(formatted, /\n  "a": 1/);
});

test('leaves non-JSON, invalid JSON and large payloads untouched', () => {
  assert.equal(formatBodyText('hello|world', 'text/plain'), 'hello|world');
  assert.equal(formatBodyText('{broken', 'application/json'), '{broken');
  const huge = `{"a":"${'x'.repeat(300 * 1024)}"}`;
  assert.equal(formatBodyText(huge, 'application/json'), huge);
});
