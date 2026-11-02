#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../core/config.mjs';
import { loadScenario, resolveScenarioPaths } from '../core/scenario.mjs';
import { selectDriver } from '../driver/index.mjs';
import { NotImplementedError, UsageError, toErrorPayload } from '../core/errors.mjs';
import { runDiagnosis } from '../diagnose/run.mjs';
import { createMockAgent } from '../agent/mock.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const CONFIG_PATH = path.join(ROOT, 'configs', 'default.json');

const HELP = `DebugCopilot CLI

Usage:
  node src/app/cli.mjs run <scenario.json> [options]

Options:
  --check           Validate the scenario and stop (no request is fired)
  --mock            Run with the deterministic mock diagnoser
  --recheck <n>     Run consistency recheck n times (default: 1)
  -q, --question    Symptom description used by the diagnoser
  --runs-dir <dir>  Directory for run artifacts (default: runs)
  --json            Print the result as JSON
  -h, --help        Show this help
  -v, --version     Show version

Exit codes:
  0  success
  1  internal error
  2  usage error
  3  scenario or preflight error
  4  feature not implemented yet`;

async function readVersion(root) {
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  return pkg.version ?? '0.0.0';
}

function parseArgv(argv) {
  const command = argv[0];
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    return { command: 'help' };
  }
  if (command === 'version' || command === '--version' || command === '-v') {
    return { command: 'version' };
  }
  if (command !== 'run') {
    throw new UsageError(`Unknown command: ${command}`);
  }

  const opts = { command: 'run', scenarioPath: undefined, mock: false, check: false, recheck: 1, json: false, question: '', runsDir: undefined };
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') return { command: 'help' };
    if (arg === '--mock') {
      opts.mock = true;
    } else if (arg === '--check') {
      opts.check = true;
    } else if (arg === '--json') {
      opts.json = true;
    } else if (arg === '--question' || arg === '-q') {
      const value = argv[i + 1];
      if (value === undefined) throw new UsageError('--question requires a value');
      i += 1;
      opts.question = value;
    } else if (arg.startsWith('--question=')) {
      opts.question = arg.slice('--question='.length);
    } else if (arg === '--runs-dir') {
      const value = argv[i + 1];
      if (value === undefined) throw new UsageError('--runs-dir requires a value');
      i += 1;
      opts.runsDir = value;
    } else if (arg.startsWith('--runs-dir=')) {
      opts.runsDir = arg.slice('--runs-dir='.length);
      opts.json = true;
    } else if (arg === '--recheck') {
      const value = argv[i + 1];
      if (value === undefined) throw new UsageError('--recheck requires a value');
      i += 1;
      opts.recheck = parseRecheck(value);
    } else if (arg.startsWith('--recheck=')) {
      opts.recheck = parseRecheck(arg.slice('--recheck='.length));
    } else if (arg.startsWith('-')) {
      throw new UsageError(`Unknown option: ${arg}`);
    } else if (opts.scenarioPath === undefined) {
      opts.scenarioPath = arg;
    } else {
      throw new UsageError(`Unexpected argument: ${arg}`);
    }
  }

  if (!opts.scenarioPath) {
    throw new UsageError('Missing scenario path. Usage: run <scenario.json> [options]');
  }
  return opts;
}

function parseRecheck(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 10) {
    throw new UsageError('--recheck must be an integer between 1 and 10');
  }
  return n;
}

function buildSummary(scenario, driver, opts) {
  const paths = resolveScenarioPaths(scenario);
  return {
    name: scenario.name,
    driver: driver.kind,
    baseUrl: scenario.baseUrl ?? null,
    logfiles: paths.logfiles,
    sourceRoot: paths.sourceRoot,
    parser: scenario.parser,
    marker: scenario.marker,
    window: scenario.window,
    mode: 'check',
    recheck: opts.recheck,
    status: 'validated',
    note: 'validated; no request fired',
  };
}

function formatMarker(marker) {
  if (marker.mode === 'none') return 'none';
  const target = marker.mode === 'header' ? marker.header : marker.bodyField;
  return `${marker.mode}(${target})`;
}

function printDiagnosis(result, runDir, root) {
  const relative = path.relative(root, runDir).split(path.sep).join('/');
  const logs = result.logs;
  const lines = [
    'DebugCopilot · diagnosis',
    `  Run ID     : ${result.meta.runId}`,
    `  Scenario   : ${result.meta.scenario} (${result.target.driver})`,
    `  Question   : ${result.meta.question || '(none)'}`,
    `  Status     : ${result.gates.ok ? 'gates ok' : 'gates failed'}`,
    `  Conclusion : ${result.agent.conclusion}`,
    `  Logs       : ${logs.count} record(s), marker ${logs.markerMatched ? 'matched' : `not matched (${logs.waitedMs}ms)`}`,
    `  Recheck    : ${result.recheck ? `${result.recheck.verdict} (${result.recheck.runs} runs, 一致不等于正确)` : 'off'}`,
    `  Result     : ${relative}/result.json`,
  ];
  console.log(lines.join('\n'));
}

function printHuman(summary) {
  const lines = [
    'DebugCopilot · scenario check',
    `  Scenario : ${summary.name}`,
    `  Driver   : ${summary.driver}`,
    `  Base URL : ${summary.baseUrl ?? '(none)'}`,
    `  Logfiles : ${summary.logfiles.length ? summary.logfiles.join(', ') : '(none)'}`,
    `  Source   : ${summary.sourceRoot ?? '(none)'}`,
    `  Parser   : ${summary.parser.preset ?? summary.parser.regex}`,
    `  Marker   : ${formatMarker(summary.marker)}`,
    `  Window   : -${summary.window.beforeMs}ms / +${summary.window.afterMs}ms`,
    `  Mode     : ${summary.mode}`,
    `  Recheck  : ${summary.recheck}`,
    `  Status   : ${summary.status} — ${summary.note}`,
  ];
  console.log(lines.join('\n'));
}

/**
 * @param {string[]} argv
 * @param {{ root?: string }} [options]
 * @returns {Promise<number>} exit code
 */
export async function main(argv = process.argv.slice(2), { root = ROOT } = {}) {
  try {
    const parsed = parseArgv(argv);
    if (parsed.command === 'help') {
      console.log(HELP);
      return 0;
    }
    if (parsed.command === 'version') {
      console.log(await readVersion(root));
      return 0;
    }

    const config = await loadConfig(path.join(root, 'configs', 'default.json'));
    const scenario = await loadScenario(parsed.scenarioPath, { config });
    const driver = selectDriver(scenario);

    if (parsed.check) {
      const summary = buildSummary(scenario, driver, parsed);
      if (parsed.json) {
        console.log(JSON.stringify(summary, null, 2));
      } else {
        printHuman(summary);
      }
      return 0;
    }

    if (!parsed.mock) {
      throw new NotImplementedError(
        'LIVE_AGENT_NOT_IMPLEMENTED',
        'Live Claude agent will be wired in S5; re-run with --mock or use --check',
      );
    }

    const { result, runDir } = await runDiagnosis(scenario, {
      runsDir: parsed.runsDir ? path.resolve(parsed.runsDir) : path.resolve(root, config.runsDir ?? 'runs'),
      question: parsed.question,
      recheck: parsed.recheck,
      agent: createMockAgent(),
    });

    if (parsed.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      printDiagnosis(result, runDir, root);
    }
    return 0;
  } catch (err) {
    const payload = toErrorPayload(err);
    if (process.env.DC_DEBUG) console.error(err);
    console.error(`[${payload.code}] ${payload.message}`);
    return payload.exitCode;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
