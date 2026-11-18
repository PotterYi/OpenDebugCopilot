import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { listEnvelope, pageArgs, pageItems } from '../../src/core/list-result.mjs';
import { createTools } from '../../src/tools/index.mjs';
import { parseScenario } from '../../src/core/scenario.mjs';
import { tempDir } from './tmp.mjs';

test('pages lists with stable bounds', () => {
  assert.equal(pageArgs({ offset: 0, limit: 50 }).limit, 50);
  assert.match(pageArgs({ offset: -1 }).error, /offset/);
  assert.match(pageArgs({ limit: 201 }).error, /limit/);
  const page = pageItems([1, 2, 3], { offset: 1, limit: 5 });
  assert.deepEqual(page.items, [2, 3]);
  assert.equal(page.total, 3);
  assert.equal(page.nextOffset, null);
  const envelope = listEnvelope({ field: 'items', items: [1, 2], offset: 0, limit: 1 });
  assert.deepEqual(envelope.items, [1]);
  assert.equal(envelope.nextOffset, 1);
});

test('query_result pages and filters a spilled JSON result', async (t) => {
  const runDir = tempDir('query-result-test');
  await rm(runDir, { recursive: true, force: true });
  await mkdir(path.join(runDir, 'evidence'), { recursive: true });
  const file = 'evidence/tool-001-demo.json';
  await writeFile(path.join(runDir, file), JSON.stringify({
    dependencies: Array.from({ length: 120 }, (_, index) => ({
      artifact: index % 2 === 0 ? 'alpha' : 'beta',
      version: `1.0.${index}`,
    })),
  }));
  t.after(async () => { await rm(runDir, { recursive: true, force: true }); });
  const scenario = parseScenario({ name: 'pagination', baseUrl: 'http://127.0.0.1:1', method: 'GET', path: '/' });
  const { tools } = createTools({ scenario, anchor: Date.now(), runDir });

  const page = await tools.query_result({ file, field: 'dependencies', offset: 100, limit: 50 });
  assert.equal(page.total, 120);
  assert.equal(page.items.length, 20);
  assert.equal(page.nextOffset, null);

  const filtered = await tools.query_result({ file, field: 'dependencies', filter: 'alpha', offset: 0, limit: 10 });
  assert.equal(filtered.total, 60);
  assert.equal(filtered.items.length, 10);
  assert.ok(filtered.items.every((item) => item.artifact === 'alpha'));

  const missing = await tools.query_result({ file, field: 'missing' });
  assert.equal(missing.code, 'FIELD_NOT_FOUND');
  const outside = await tools.query_result({ file: '../../etc/passwd' });
  assert.equal(outside.code, 'READ_OUT_OF_SCOPE');
});
