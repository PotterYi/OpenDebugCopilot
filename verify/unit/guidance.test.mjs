import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BOUNDARY_CODES,
  boundaryGuidance,
  createDenialTracker,
} from '../../src/tools/guidance.mjs';

test('returns structured usage for capability boundary errors', () => {
  const toolchain = boundaryGuidance({
    tool: 'run_command',
    code: 'COMMAND_DENIED',
    details: { reason: 'toolchain', examples: ['mvn -q -DskipTests compile', '/usr/bin/mvn test'] },
  });
  assert.match(toolchain.hint, /构建\/测试/);
  assert.ok(toolchain.usage.includes('mvn -q -DskipTests compile'));
  assert.equal(toolchain.usage.includes('/usr/bin/mvn test'), false);
  assert.ok(toolchain.usage.includes('npm test'));
  assert.ok(toolchain.usage.length <= 6);

  const shell = boundaryGuidance({
    tool: 'run_command',
    code: 'COMMAND_DENIED',
    details: { reason: 'shell-syntax' },
  });
  assert.match(shell.hint, /一条命令/);

  const read = boundaryGuidance({ tool: 'read', code: 'READ_OUT_OF_SCOPE' });
  assert.match(read.hint, /evidence/);
  assert.ok(read.usage.some((item) => item.includes('read_source')));
  assert.ok(read.usage.some((item) => item.includes('list_dir')));

  const path = boundaryGuidance({ tool: 'stat_file', code: 'PATH_OUT_OF_SCOPE' });
  assert.match(path.hint, /backend/);
  assert.ok(path.usage.some((item) => item.includes('list_dir')));

  const cwd = boundaryGuidance({
    tool: 'run_command',
    code: 'COMMAND_CWD_DENIED',
    details: { reason: 'cwd', roots: ['backend', 'frontend'] },
  });
  assert.match(cwd.hint, /省略 cwd/);
  assert.match(cwd.hint, /backend/);
  assert.ok(cwd.usage.includes('省略 cwd，使用默认构建目录'));

  assert.equal(boundaryGuidance({ tool: 'query_db', code: 'DB_CONNECTION_FAILED' }), null);
  assert.ok(BOUNDARY_CODES.has('READ_OUT_OF_SCOPE'));
});

test('tracks repeated boundary failures per tool and code', () => {
  const tracker = createDenialTracker();
  assert.equal(tracker.recordFailure({ tool: 'run_command', code: 'DB_CONNECTION_FAILED' }), null);

  assert.equal(tracker.recordFailure({ tool: 'run_command', code: 'COMMAND_DENIED' }).repeated, 1);
  assert.equal(tracker.recordFailure({ tool: 'run_command', code: 'COMMAND_DENIED' }).repeated, 2);
  assert.equal(tracker.recordFailure({ tool: 'run_command', code: 'COMMAND_DENIED' }).repeated, 3);
  assert.equal(tracker.recordFailure({ tool: 'read', code: 'READ_OUT_OF_SCOPE' }).repeated, 1);

  tracker.recordSuccess('run_command');
  assert.equal(tracker.recordFailure({ tool: 'run_command', code: 'COMMAND_DENIED' }).repeated, 1);
});
