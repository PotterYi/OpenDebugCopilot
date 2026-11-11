import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { runCaptureDiagnosis } from '../../src/diagnose/run.mjs';
import { tempDir } from './tmp.mjs';

const TMP = tempDir('fix-self-check');

test('readonly diagnosis never applies suggested fixes to the real tree', async (t) => {
  await rm(TMP, { recursive: true, force: true });
  const sourceRoot = path.join(TMP, 'backend');
  const file = path.join(sourceRoot, 'com/demo/OrderService.java');
  const original = [
    'package com.demo;',
    '',
    'public class OrderService {',
    '    public void create(Order order) {',
    '        if (order.getQty() <= 0) {',
    '            throw new IllegalArgumentException("qty must be positive");',
    '        }',
    '    }',
    '}',
    '',
  ].join('\n');
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, original, 'utf8');
  t.after(async () => { await rm(TMP, { recursive: true, force: true }); });

  const agent = {
    id: 'fix-agent',
    async diagnose() {
      return {
        conclusion: '库存校验缺少空值保护',
        evidenceRefs: [{ type: 'request', ref: 'request' }],
        confidence: 0.8,
        needsMoreInfo: [],
        fixes: [{
          summary: '防御空数量',
          root: 'backend',
          file: 'com/demo/OrderService.java',
          search: '        if (order.getQty() <= 0) {',
          replace: '        if (order.getQty() == null || order.getQty() <= 0) {',
          risk: 'low',
        }],
      };
    },
  };

  const { result } = await runCaptureDiagnosis({
    request: { method: 'POST', url: 'http://localhost/api/order', headers: {}, body: '{}', startedAt: Date.now() },
    response: { status: 500, statusText: 'Error', ok: false, headers: {}, body: '{}', durationMs: 1 },
    firedAt: Date.now(),
  }, {
    workspace: { sourceRoot, logfiles: [], window: { beforeMs: 1000, afterMs: 1000 } },
    root: TMP,
    runsDir: path.join(TMP, 'runs'),
    agent,
    // If validation still touched the real tree, this command would leave a
    // marker file behind (and then fail).
    verifyCommand: 'node -e "require(\'fs\').writeFileSync(\'written-by-check\',\'x\');process.exit(1)"',
  });

  assert.equal(result.agent.fixesValidation, undefined);
  assert.equal(result.agent.verification, undefined);
  assert.equal(result.agent.fixes.length, 1);
  assert.equal(result.agent.fixes[0].preview.status, 'ready');
  assert.equal(await readFile(file, 'utf8'), original);
  await assert.rejects(access(path.join(sourceRoot, 'written-by-check')));
});
