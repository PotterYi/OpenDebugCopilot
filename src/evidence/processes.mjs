import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import iconv from 'iconv-lite';
import { AppError } from '../core/errors.mjs';
import { redactCommand } from '../core/redact.mjs';
import { findPortPids } from './jvm.mjs';

const exec = promisify(execFile);
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const MAX_COMMAND_CHARS = 300;
const TIMEOUT_MS = 5000;
const MAX_BUFFER = 16 * 1024 * 1024;
const MAX_FILTER_CHARS = 200;

const SCAN_MARKER = 'DEBUGCOPILOT_PROCESS_SCAN';
const WINDOWS_SCRIPT = `
# ${SCAN_MARKER}
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$sid = (Get-Process -Id $PID).SessionId
Get-CimInstance Win32_Process | Where-Object { $_.SessionId -eq $sid } | ForEach-Object {
  $created = $null
  if ($_.CreationDate) { $created = $_.CreationDate.ToUniversalTime().ToString('o') }
  [pscustomobject]@{
    pid = [int]$_.ProcessId
    ppid = [int]$_.ParentProcessId
    name = $_.Name
    startedAt = $created
    command = $_.CommandLine
  }
} | ConvertTo-Json -Compress
`;

function decodeOutput(buffer) {
  if (!Buffer.isBuffer(buffer)) return String(buffer ?? '');
  const utf8 = buffer.toString('utf8');
  if (!utf8.includes('�')) return utf8;
  if (process.platform === 'win32') return iconv.decode(buffer, 'gbk');
  return utf8;
}

async function execText(command, args, options = {}) {
  const result = await exec(command, args, {
    timeout: options.timeout ?? TIMEOUT_MS,
    windowsHide: true,
    maxBuffer: options.maxBuffer ?? MAX_BUFFER,
    encoding: 'buffer',
  });
  return decodeOutput(result.stdout);
}

function truncateCommand(command) {
  if (!command) return null;
  const redacted = redactCommand(command);
  return redacted.length > MAX_COMMAND_CHARS
    ? `${redacted.slice(0, MAX_COMMAND_CHARS)}…`
    : redacted;
}

export function parseEtime(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  const match = text.match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
  if (!match) return null;
  const days = Number(match[1] ?? 0);
  const hours = Number(match[2] ?? 0);
  const minutes = Number(match[3] ?? 0);
  const seconds = Number(match[4] ?? 0);
  const total = (((days * 24) + hours) * 60 + minutes) * 60 + seconds;
  return Number.isFinite(total) && total >= 0 ? total : null;
}

export function parsePsOutput(text) {
  const rows = [];
  const now = Date.now();
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
    if (!match) continue;
    const pid = Number(match[2]);
    const ppid = Number(match[3]);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    const args = match[5].trim();
    const firstToken = args.split(/\s+/)[0].replace(/^"(.*)"$/, '$1');
    const name = firstToken ? path.basename(firstToken.replace(/\\/g, '/')) : null;
    const elapsed = parseEtime(match[4]);
    rows.push({
      uid: Number(match[1]),
      pid,
      ppid: Number.isInteger(ppid) ? ppid : null,
      name,
      startedAt: elapsed === null ? null : new Date(now - elapsed * 1000).toISOString(),
      command: args || null,
    });
  }
  return rows;
}

export function parseWindowsProcessJson(text) {
  const trimmed = String(text ?? '').replace(/^﻿/, '').trim();
  if (!trimmed) return [];
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return [];
  }
  const list = Array.isArray(parsed) ? parsed : [parsed];
  return list
    .map((item) => ({
      pid: Number(item?.pid ?? item?.ProcessId),
      ppid: Number(item?.ppid ?? item?.ParentProcessId),
      name: item?.name ?? item?.Name ?? null,
      startedAt: item?.startedAt ?? item?.CreationDate ?? null,
      command: item?.command ?? item?.CommandLine ?? null,
    }))
    .filter((item) => Number.isInteger(item.pid) && item.pid > 0);
}

function parseWmicDate(value) {
  const text = String(value ?? '').trim();
  const match = text.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\.(\d+)([+-]\d+)?$/);
  if (!match) return null;
  const [, year, month, day, hour, minute, second, fraction, offset] = match;
  const millis = Number(`0.${fraction}`) * 1000;
  const utc = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second), millis);
  const offsetMinutes = offset ? Number(offset) : 0;
  const date = new Date(utc - offsetMinutes * 60 * 1000);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function parseWmicList(text) {
  const rows = [];
  let current = {};
  const flush = () => {
    if (current.ProcessId) {
      rows.push({
        pid: Number(current.ProcessId),
        ppid: Number(current.ParentProcessId),
        name: current.Name || null,
        startedAt: parseWmicDate(current.CreationDate),
        command: current.CommandLine || null,
      });
    }
    current = {};
  };
  for (const line of String(text ?? '').split(/\r?\n/)) {
    if (!line.trim()) {
      flush();
      continue;
    }
    const index = line.indexOf('=');
    if (index <= 0) continue;
    current[line.slice(0, index).trim()] = line.slice(index + 1);
  }
  flush();
  return rows.filter((row) => Number.isInteger(row.pid) && row.pid > 0);
}

function withoutHelperProcesses(rows) {
  const helperPids = new Set(
    rows
      .filter((row) => String(row.command ?? '').includes(SCAN_MARKER))
      .map((row) => row.pid),
  );
  return rows.filter((row) => {
    if (helperPids.has(row.pid) || helperPids.has(row.ppid)) return false;
    return !(String(row.name ?? '').toLowerCase() === 'wmic.exe'
      && String(row.command ?? '').includes('ProcessId'));
  });
}

async function collectWindowsProcesses() {
  const failures = [];
  for (const exe of ['powershell.exe', 'pwsh']) {
    try {
      const stdout = await execText(exe, [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        WINDOWS_SCRIPT,
      ]);
      const rows = withoutHelperProcesses(parseWindowsProcessJson(stdout));
      if (rows.length > 0) {
        return { rows, source: 'windows-cim', note: null };
      }
      failures.push(`${exe}: empty output`);
    } catch (error) {
      failures.push(`${exe}: ${error?.code ?? error?.name ?? 'failed'}`);
    }
  }
  try {
    const stdout = await execText('wmic', [
      'process',
      'get',
      'ProcessId,ParentProcessId,Name,CreationDate,CommandLine',
      '/FORMAT:LIST',
    ]);
    const rows = withoutHelperProcesses(parseWmicList(stdout));
    if (rows.length > 0) {
      return {
        rows,
        source: 'windows-wmic',
        note: 'PowerShell CIM 不可用，已降级到 wmic；startedAt/command 可能不完整',
      };
    }
    failures.push('wmic: empty output');
  } catch (error) {
    failures.push(`wmic: ${error?.code ?? error?.name ?? 'failed'}`);
  }
  throw new AppError(
    'PROCESS_LIST_UNAVAILABLE',
    `无法读取本地进程清单（${failures.join('; ')}）`,
    { exitCode: 3 },
  );
}

async function collectPosixProcesses() {
  let stdout;
  try {
    stdout = await execText('ps', ['-ww', '-eo', 'uid=,pid=,ppid=,etime=,args=']);
  } catch {
    stdout = await execText('ps', ['-eo', 'uid=,pid=,ppid=,etime=,args=']);
  }
  return { rows: parsePsOutput(stdout), source: 'posix-ps', note: null };
}

export function isJavaProcess(entry) {
  const name = String(entry?.name ?? '').toLowerCase();
  if (/^(java|javaw)(\.exe)?$/.test(name)) return true;
  const command = String(entry?.command ?? '').trim();
  const first = command.split(/\s+/)[0].replace(/^"(.*)"$/, '$1');
  return /(^|[\\/])(java|javaw)(\.exe)?$/i.test(first);
}

function normalizeStartedAt(value) {
  if (value === null || value === undefined || value === '') return null;
  const text = String(value).replace(/(\.\d{3})\d+/, '$1');
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function normalizeProcess(row) {
  const pid = Number(row.pid);
  const ppid = Number(row.ppid);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  return {
    pid,
    ppid: Number.isInteger(ppid) && ppid >= 0 ? ppid : null,
    name: row.name ? String(row.name) : null,
    startedAt: normalizeStartedAt(row.startedAt),
    command: row.command ? String(row.command) : null,
    _uid: row.uid ?? null,
    _rawCommand: row.command ? String(row.command) : null,
  };
}

function activeProcess(row) {
  return {
    pid: row.pid,
    ppid: row.ppid,
    name: row.name,
    startedAt: row.startedAt,
    command: truncateCommand(row._rawCommand),
  };
}

function validateFilters({ pid, port, limit, name, commandContains }) {
  if (pid !== null && pid !== undefined && pid !== '' && (!Number.isInteger(Number(pid)) || Number(pid) <= 0)) {
    throw new AppError('INVALID_PID', 'pid must be a positive integer', { exitCode: 2 });
  }
  if (port !== null && port !== undefined && port !== '') {
    const numeric = Number(port);
    if (!Number.isInteger(numeric) || numeric < 1 || numeric > 65535) {
      throw new AppError('INVALID_PORT', 'port must be an integer between 1 and 65535', { exitCode: 2 });
    }
  }
  const numericLimit = Number(limit ?? DEFAULT_LIMIT);
  if (!Number.isInteger(numericLimit) || numericLimit < 1 || numericLimit > MAX_LIMIT) {
    throw new AppError('INVALID_LIMIT', `limit must be an integer between 1 and ${MAX_LIMIT}`, { exitCode: 2 });
  }
  for (const [key, value] of [['name', name], ['commandContains', commandContains]]) {
    if (value !== null && value !== undefined && String(value).length > MAX_FILTER_CHARS) {
      throw new AppError('INVALID_FILTER', `${key} is limited to ${MAX_FILTER_CHARS} characters`, { exitCode: 2 });
    }
  }
}

export async function listProcesses({
  pid = null,
  port = null,
  name = null,
  commandContains = null,
  javaOnly = false,
  limit = DEFAULT_LIMIT,
  includeAllUsers = false,
} = {}) {
  validateFilters({ pid, port, limit, name, commandContains });
  const collected = process.platform === 'win32'
    ? await collectWindowsProcesses()
    : await collectPosixProcesses();
  const limitations = [];
  if (collected.note) limitations.push(collected.note);
  if (!includeAllUsers) {
    limitations.push(process.platform === 'win32'
      ? '只列出当前 Windows 会话中的进程'
      : '只列出当前用户进程');
  }

  let rows = collected.rows.map(normalizeProcess).filter(Boolean);
  if (!includeAllUsers && process.platform !== 'win32' && typeof process.getuid === 'function') {
    const uid = process.getuid();
    rows = rows.filter((row) => row._uid === null || row._uid === uid);
  }

  const targetPid = pid === null || pid === undefined || pid === '' ? null : Number(pid);
  if (targetPid !== null) rows = rows.filter((row) => row.pid === targetPid);

  const targetPort = port === null || port === undefined || port === '' ? null : Number(port);
  if (targetPort !== null) {
    const pids = new Set(await findPortPids(targetPort));
    rows = rows.filter((row) => pids.has(row.pid));
  }

  const nameFilter = name === null || name === undefined || name === '' ? null : String(name).trim().toLowerCase();
  if (nameFilter) rows = rows.filter((row) => String(row.name ?? '').toLowerCase().includes(nameFilter));

  const commandFilter = commandContains === null || commandContains === undefined || commandContains === ''
    ? null
    : String(commandContains).trim().toLowerCase();
  if (commandFilter) {
    rows = rows.filter((row) => String(row._rawCommand ?? '').toLowerCase().includes(commandFilter));
  }
  if (javaOnly) rows = rows.filter((row) => isJavaProcess(row));

  const timeOf = (row) => (row.startedAt ? Date.parse(row.startedAt) : 0);
  rows.sort((a, b) => (timeOf(b) - timeOf(a)) || (a.pid - b.pid));

  const totalCount = rows.length;
  const limited = rows.slice(0, Number(limit ?? DEFAULT_LIMIT));
  const hiddenCommands = limited.filter((row) => !row._rawCommand).length;
  if (hiddenCommands > 0) {
    limitations.push(`${hiddenCommands} 个进程的 command 因权限或平台限制不可见`);
  }
  limitations.push('command 已脱敏并截断到 300 字符；脱敏为尽力而为');

  return {
    processes: limited.map(activeProcess),
    count: limited.length,
    totalCount,
    truncated: totalCount > limited.length,
    ...(targetPid === null ? {} : { pid: targetPid }),
    ...(targetPort === null ? {} : { port: targetPort }),
    source: collected.source,
    ...(targetPort !== null && totalCount === 0
      ? { reason: `没有发现监听端口 ${targetPort} 的进程` }
      : {}),
    limitations,
  };
}
