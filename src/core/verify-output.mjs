/**
 * Lightweight, conservative text checks for verification command output.
 * Exit code/timeout remain the hard judgment; these only mark "suspicious"
 * when a successful command's output strongly contradicts success.
 */

const MAX_LINE = 300;
const MAX_SUSPICIONS = 5;
const MAX_PENDING = 32 * 1024;
const ESC = String.fromCharCode(27);
const ANSI = new RegExp(ESC + '[[]' + '[0-?]*[ -/]*[@-~]', 'g');
const NEWLINE = String.fromCharCode(10);

const BUILD_PATTERNS = [
  [/BUILD FAILURE/i, 'build-failure-text', '检测到 BUILD FAILURE'],
  [/FAILURE:[ ]*Build failed with an exception/i, 'build-failure-text', '检测到 Gradle 构建失败'],
  [/\[ERROR\][ ]+Failed to execute goal/i, 'maven-goal-failure', '检测到 Maven goal 执行失败'],
  [/npm ERR!/i, 'npm-error', '检测到 npm ERR!'],
  [/error TS[0-9]+/i, 'typescript-error', '检测到 TypeScript 编译错误'],
  [/Compilation failed/i, 'compilation-failed', '检测到 Compilation failed'],
];

const TEST_PATTERNS = [
  [/Tests run:[ ]*[0-9]+,[ ]*Failures:[ ]*[1-9]/i, 'test-failure-count', '检测到测试失败计数'],
  [/Tests run:[ ]*[0-9]+,[ ]*Failures:[ ]*0,[ ]*Errors:[ ]*[1-9]/i, 'test-error-count', '检测到测试错误计数'],
  [/Test Suites:[ ]*[0-9]+[ ]+failed/i, 'jest-suite-failed', '检测到 Jest 测试套件失败'],
  [/Tests:[ ]*[0-9]+[ ]+failed/i, 'jest-test-failed', '检测到 Jest 测试失败'],
  [/^[ ]*FAILED(?:[^A-Za-z0-9_]|$)/, 'pytest-failed', '检测到 FAILED 测试'],
  [/^[ ]*--- FAIL:/, 'go-test-failed', '检测到 Go 测试失败'],
  [/(?:^|[^A-Za-z0-9_])[1-9][0-9]*[ ]+failed/i, 'test-failure-count', '检测到测试失败计数'],
];

const ZERO_TEST_PATTERNS = [
  [/Tests run:[ ]*0,[ ]*Failures:[ ]*0,[ ]*Errors:[ ]*0/i, 'zero-tests', '测试命令执行了 0 个用例'],
  [/No tests (?:were )?(?:found|executed|to run)/i, 'zero-tests', '测试命令未执行任何用例'],
  [/no test files/i, 'zero-tests', '未找到测试文件'],
  [/(?:^|[^A-Za-z0-9_])0[ ]+(?:tests?|passing)/i, 'zero-tests', '测试命令执行了 0 个用例'],
  [/Tests:[ ]*0[ ]+total/i, 'zero-tests', '测试命令执行了 0 个用例'],
  [/Test Suites:[ ]*0[ ]+total/i, 'zero-tests', '测试命令执行了 0 个用例'],
  [/collected 0 items/i, 'zero-tests', 'pytest 收集到 0 个用例'],
  [/no tests ran/i, 'zero-tests', '测试命令未运行任何用例'],
];

function stripAnsi(value) {
  return String(value ?? '').replace(ANSI, '');
}

function cleanLine(value) {
  return stripAnsi(value).trimEnd().slice(0, MAX_LINE);
}

function parseSummary(line) {
  let match = line.match(/Tests run:[ ]*([0-9]+),[ ]*Failures:[ ]*([0-9]+),[ ]*Errors:[ ]*([0-9]+)(?:,[ ]*Skipped:[ ]*([0-9]+))?/i);
  if (match) {
    return {
      tests: Number(match[1]),
      failures: Number(match[2]),
      errors: Number(match[3]),
      skipped: Number(match[4] ?? 0),
      source: 'maven',
    };
  }
  match = line.match(/Tests:[ ]*([0-9]+)[ ]+failed,[ ]*([0-9]+)[ ]+passed,[ ]*([0-9]+)[ ]+total/i);
  if (match) {
    return {
      tests: Number(match[3]),
      failures: Number(match[1]),
      errors: 0,
      passed: Number(match[2]),
      source: 'jest',
    };
  }
  match = line.match(/Tests[ ]+([0-9]+)[ ]+failed[ ]*\|[ ]*([0-9]+)[ ]+passed/i);
  if (match) {
    return {
      tests: Number(match[1]) + Number(match[2]),
      failures: Number(match[1]),
      errors: 0,
      passed: Number(match[2]),
      source: 'vitest',
    };
  }
  match = line.match(/([0-9]+)[ ]+failed,[ ]*([0-9]+)[ ]+passed/i);
  if (match) {
    return {
      tests: Number(match[1]) + Number(match[2]),
      failures: Number(match[1]),
      errors: 0,
      passed: Number(match[2]),
      source: 'text',
    };
  }
  match = line.match(/(?:^|[^A-Za-z0-9_])([0-9]+)[ ]+passed(?:[^A-Za-z0-9_]|$)/i);
  if (match) {
    return { tests: Number(match[1]), failures: 0, errors: 0, passed: Number(match[1]), source: 'text' };
  }
  return null;
}

function offlineCommand(command) {
  return /(?:^|[ ])(?:--offline|-o)(?:[ ]|$)/i.test(String(command ?? ''));
}

export function inferVerifyPhase(command) {
  const text = String(command ?? '').toLowerCase();
  if (/-dskiptests|--exclude-task[ ]+test|-x[ ]+test|compilejava|npm run build|pnpm run build|yarn build|vite build|tsc|compileall|go build/.test(text)) {
    return 'build';
  }
  if (/(?:mvn|mvnw).*(?:test|verify)/.test(text)
    || /(?:npm|pnpm|yarn)[ ]+(?:run[ ]+)?test/.test(text)
    || /(?:pytest|py[.]test|unittest|jest|vitest)/.test(text)
    || /go[ ]+test/.test(text)
    || /gradlew?[ ]+.*test/.test(text)) {
    return 'test';
  }
  return 'build';
}

/**
 * Streaming scanner: analyze every chunk before the stored output is truncated,
 * so an early BUILD FAILURE is not lost just because the tail is noise.
 */
export function createVerifyOutputScanner({ phase = null, command = '' } = {}) {
  const resolvedPhase = phase === 'test' ? 'test' : (phase === 'build' ? 'build' : inferVerifyPhase(command));
  let pending = '';
  let testSummary = null;
  const suspicions = [];
  const seen = new Set();

  const add = (code, message, line) => {
    if (suspicions.length >= MAX_SUSPICIONS) return;
    const cleaned = cleanLine(line);
    const key = `${resolvedPhase}|${cleaned}`;
    if (seen.has(key)) return;
    seen.add(key);
    suspicions.push({ phase: resolvedPhase, code, message, line: cleaned });
  };

  const processLine = (raw) => {
    const line = cleanLine(raw);
    if (!line.trim()) return;
    if (resolvedPhase === 'test') {
      const summary = parseSummary(line);
      if (summary) {
        testSummary = summary;
        if (summary.tests === 0) add('zero-tests', '测试命令执行了 0 个用例', line);
        else if (summary.failures > 0 || summary.errors > 0) {
          add('test-failure-count', '输出显示测试失败/错误计数', line);
        }
      }
      for (const [pattern, code, message] of TEST_PATTERNS) {
        if (pattern.test(line)) {
          add(code, message, line);
          break;
        }
      }
      if (!testSummary) {
        for (const [pattern, code, message] of ZERO_TEST_PATTERNS) {
          if (pattern.test(line)) {
            add(code, message, line);
            break;
          }
        }
      }
    } else {
      for (const [pattern, code, message] of BUILD_PATTERNS) {
        if (pattern.test(line)) {
          add(code, message, line);
          break;
        }
      }
    }
    if (offlineCommand(command) && /offline|skipping/i.test(line)) {
      add('offline-skip', '离线模式可能跳过了部分构建/测试步骤', line);
    }
  };

  return {
    push(chunk) {
      pending += String(chunk ?? '');
      let index = pending.indexOf(NEWLINE);
      while (index >= 0) {
        processLine(pending.slice(0, index));
        pending = pending.slice(index + 1);
        index = pending.indexOf(NEWLINE);
      }
      if (pending.length > MAX_PENDING) {
        processLine(pending.slice(0, MAX_PENDING));
        pending = pending.slice(MAX_PENDING);
      }
    },
    finish() {
      if (pending) processLine(pending);
      pending = '';
      return { suspicions, testSummary };
    },
  };
}

export function analyzeVerifyOutput({ phase = null, command = '', output = '' } = {}) {
  const scanner = createVerifyOutputScanner({ phase, command });
  scanner.push(output);
  return scanner.finish();
}
