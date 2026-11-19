import test from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzeVerifyOutput,
  createVerifyOutputScanner,
  inferVerifyPhase,
} from '../../src/core/verify-output.mjs';

test('flags strong build failure text on a successful command', () => {
  const result = analyzeVerifyOutput({
    phase: 'build',
    command: 'mvn compile',
    output: '[INFO] compiling\nBUILD FAILURE\n',
  });
  assert.equal(result.suspicions.length, 1);
  assert.equal(result.suspicions[0].code, 'build-failure-text');
  assert.match(result.suspicions[0].line, /BUILD FAILURE/);
});

test('does not treat a generic ERROR line as a build failure', () => {
  const result = analyzeVerifyOutput({
    phase: 'build',
    command: 'mvn compile',
    output: '[ERROR] this is an expected validation log\nERROR example in source\n',
  });
  assert.equal(result.suspicions.length, 0);
});

test('parses test failure counts and zero tests', () => {
  const failed = analyzeVerifyOutput({
    phase: 'test',
    command: 'mvn test',
    output: '[INFO] Tests run: 3, Failures: 1, Errors: 0, Skipped: 0\n',
  });
  assert.equal(failed.testSummary.tests, 3);
  assert.equal(failed.testSummary.failures, 1);
  assert.ok(failed.suspicions.some((item) => item.code === 'test-failure-count'));

  const zero = analyzeVerifyOutput({
    phase: 'test',
    command: 'npm test',
    output: 'No tests found\n',
  });
  assert.ok(zero.suspicions.some((item) => item.code === 'zero-tests'));
});

test('flags offline skip only when the command asks for offline mode', () => {
  const offline = analyzeVerifyOutput({
    phase: 'build',
    command: 'mvn -o package',
    output: '[INFO] Skipping unavailable plugin (offline)\n',
  });
  assert.ok(offline.suspicions.some((item) => item.code === 'offline-skip'));

  const online = analyzeVerifyOutput({
    phase: 'build',
    command: 'mvn package',
    output: '[INFO] Skipping optional plugin\n',
  });
  assert.equal(online.suspicions.length, 0);
});

test('strips ANSI colors and scans chunks split across lines', () => {
  const scanner = createVerifyOutputScanner({ phase: 'test', command: 'mvn test' });
  const esc = String.fromCharCode(27);
  scanner.push(`${esc}[31mTests run: 0, Failures: 0, Errors: 0${esc}[0m`);
  scanner.push('\n');
  const result = scanner.finish();
  assert.ok(result.suspicions.some((item) => item.code === 'zero-tests'));
  assert.doesNotMatch(result.suspicions[0].line, new RegExp(esc));
});

test('infers test phase from common test commands', () => {
  assert.equal(inferVerifyPhase('mvn -q test'), 'test');
  assert.equal(inferVerifyPhase('npm test'), 'test');
  assert.equal(inferVerifyPhase('go test ./...'), 'test');
  assert.equal(inferVerifyPhase('mvn -q -DskipTests compile'), 'build');
});
