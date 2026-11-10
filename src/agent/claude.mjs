import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { AppError } from '../core/errors.mjs';
import { normalizeFixList } from '../core/fixes.mjs';
import { summarizeToolCalls } from '../core/tool-calls.mjs';

export const READ_ONLY_BUILTIN_TOOLS = Object.freeze(['Read', 'Grep', 'Glob']);
export const SANDBOX_BUILTIN_TOOLS = Object.freeze(['Read', 'Grep', 'Glob', 'Edit', 'Write']);
export const FULL_BUILTIN_TOOLS = Object.freeze(['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash']);

const SENSITIVE_NAME = /^(?:\.env(?:\..*)?|.*\.(?:pem|key|p12|pfx)|id_(?:rsa|dsa|ecdsa|ed25519).*|\.npmrc|\.pypirc|credentials|secrets?)$/i;
const SENSITIVE_PATH = /(?:^|[\\/])\.git[\\/]config$|(?:^|[\\/])\.ssh[\\/]|(?:^|[\\/])\.aws[\\/]|(?:^|[\\/])\.kube[\\/]|(?:^|[\\/])\.docker[\\/]config\.json$/i;

function inside(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function isSensitive(target) {
  const normalized = target.replace(/\\/g, '/');
  return SENSITIVE_NAME.test(path.basename(normalized)) || SENSITIVE_PATH.test(normalized);
}

/**
 * Permission policy for the built-in tools.
 *
 * - Read/Grep/Glob are allowed only inside the configured roots.
 * - Edit/Write are allowed only in sandbox mode, still inside the roots.
 * - Bash/NotebookEdit and unknown built-ins are always denied.
 * - Secrets, VCS credentials and paths outside the roots are denied.
 * - Our own MCP evidence tools stay allowed.
 */
export function createToolPermission(allowedRoots = [], {
  cwd = process.cwd(),
  allowWrite = false,
  allowBash = false,
  approve = null,
  requireApproval = false,
} = {}) {
  const roots = [...new Set((allowedRoots.length > 0 ? allowedRoots : [cwd])
    .map((root) => path.resolve(root)))];

  async function resolveTarget(raw) {
    const resolved = path.resolve(cwd, raw || '.');
    return realpath(resolved).catch(() => resolved);
  }

  async function insideAny(target) {
    const realTarget = await realpath(target).catch(() => target);
    for (const root of roots) {
      const realRoot = await realpath(root).catch(() => root);
      if (inside(realRoot, realTarget)) return true;
    }
    return false;
  }

  async function askApproval(toolName, input) {
    if (typeof approve !== 'function') {
      return { behavior: 'deny', message: `${toolName} 需要用户确认，但当前没有确认回调。` };
    }
    const allowed = await approve({ toolName, input });
    return allowed
      ? { behavior: 'allow', updatedInput: input }
      : { behavior: 'deny', message: `用户拒绝了 ${toolName} 操作。` };
  }

  return async function canUseTool(toolName, input = {}) {
    if (String(toolName).startsWith('mcp__debugcopilot__')) {
      return { behavior: 'allow', updatedInput: input };
    }
    const isWrite = toolName === 'Edit' || toolName === 'Write';
    const allowedTools = [
      ...(allowWrite ? SANDBOX_BUILTIN_TOOLS : READ_ONLY_BUILTIN_TOOLS),
      ...(allowBash ? ['Bash'] : []),
    ];
    if (!allowedTools.includes(toolName)) {
      return {
        behavior: 'deny',
        message: `工具 ${toolName} 未授权；当前模式不允许该工具。`,
      };
    }
    if (toolName === 'Bash') {
      const command = String(input.command ?? '').trim();
      if (!command) return { behavior: 'deny', message: 'Bash 命令为空。' };
      return askApproval('Bash', input);
    }
    if (toolName === 'Glob') {
      const pattern = String(input.pattern ?? '');
      if (path.isAbsolute(pattern) || pattern.includes('..') || pattern.startsWith('~')) {
        return { behavior: 'deny', message: 'Glob 只允许在授权目录内搜索，禁止绝对路径、~ 或 .. 越界。' };
      }
    }
    const rawPath = toolName === 'Read' || isWrite ? input.file_path : input.path;
    const target = await resolveTarget(rawPath);
    if (!await insideAny(target)) {
      return { behavior: 'deny', message: `路径不在授权目录内：${target}` };
    }
    if (isSensitive(target)) {
      return { behavior: 'deny', message: `拒绝访问敏感文件：${target}` };
    }
    if (isWrite && (requireApproval || typeof approve === 'function')) {
      return askApproval(toolName, input);
    }
    return { behavior: 'allow', updatedInput: input };
  };
}

export function createReadOnlyToolPermission(allowedRoots = [], { cwd = process.cwd() } = {}) {
  return createToolPermission(allowedRoots, { cwd, allowWrite: false });
}

const DEFAULT_TIMEOUT_MS = 600_000;
const MAX_TOOL_TEXT = 20_000;

const SYSTEM_PROMPT = `你是 DebugCopilot 的后端问题定位助手。你的任务是结合请求、响应、日志与源码证据，定位问题并给出可执行的结论。

规则：
1. 可以在授权源码目录内使用内置 Read/Grep/Glob 查看完整文件、搜索方法/字段/引用；日志、数据库和证据切片使用 debugcopilot 工具。不要假设未读取的内容，不要访问源码目录之外的文件。
2. 每条结论都必须有证据支撑；evidenceRefs 的 ref 必须指向证据包中的条目（request / response / logs.records[i] / source.files[i] / threads / element）。
3. 证据不足时写入 needsMoreInfo，不要编造日志、堆栈或源码。
4. 工具调用应有节制；没有新增证据就停止并给出阶段性结论。
5. 使用中文回答，结论要具体（涉及类名、日志关键行、HTTP 状态码）。
6. 不要输出密码、Token、Cookie 等敏感信息。
7. 修复建议放在 fixes 中，只能修改已读取过的文件（内置 Read 或 read_source）；file 使用源码根下的相对路径，root 标明 backend 或 frontend。读取前端源码时给 read_source/search_source 传 root=frontend，内置 Read/Grep/Glob 可直接使用前端目录的绝对路径。
8. 代码修改必须提供可唯一定位的 search（文件中的精确原文，出现次数必须为 1）和 replace；无法给出精确修改时，只写 summary，不要编造 search/replace。
9. 不要直接修改文件；本阶段只生成修复建议和 diff 预览，由用户确认。
10. 证据包的 extraSources 里可能列出已配置但未授权的其他后端源码根；不要假设其内容。若判断需要这些代码，写入 needsMoreInfo，提示用户勾选「同时扫描其他后端源码」后重新诊断。
11. 已授权时，读取/搜索其他后端源码使用 root=extra 和 extraRoot=<id>；修改建议同时带 root=extra 与 extraRoot=<id>。
12. 数据库工具不可用或返回 DB_* 错误时，不要中断诊断：继续使用日志和源码工具分析，并在 conclusion 或 needsMoreInfo 中明确说明「数据库查询不可用，本次结论仅基于源码与日志分析」。
13. [静态兜底] 新增日志时必须在同一条 replace 中补齐 logger 的 import/声明（Java 常见为 @Slf4j + import lombok.extern.slf4j.Slf4j，或使用文件中已有的 Logger 字段）；不要只添加 log.xxx 而遗漏 logger 定义。若本轮能运行编译/测试，以编译结果为准。
14. [静态兜底] 修改只能调用项目中已存在的方法，或在同一条修改中同时新增该方法实现；不要凭空调用不存在的 Service、工具类或业务方法。若本轮能运行编译/测试，以编译结果为准。`;

const FOLLOWUP_SYSTEM_PROMPT = `你是 DebugCopilot 的诊断助手，正在和用户继续讨论一条已有诊断。

规则：
1. 基于上一轮结论、证据和修复建议回答，不要编造未提供的日志、堆栈或源码。
2. 用户可能在评估方案，要求先给修复方案、解释风险，或对当前方案不满意并要求调整。
3. 输出 JSON Schema：conclusion 是本轮回复；fixes 是本轮建议，会覆盖上一轮展示。
4. 如果用户只想先看方案，不要给 search/replace 具体代码；要求具体修改时再给可唯一定位的 search/replace。
5. 可以在授权源码目录内使用内置 Read/Grep/Glob 查看完整文件和引用，也可用 debugcopilot 工具补充日志、线程、源码切片或数据库证据；不要假设未读取的内容。
6. 数据库工具不可用或返回 DB_* 错误时，不要中断：继续用日志与源码分析，并明确说明「数据库查询不可用，本次结论仅基于源码与日志分析」。
7. 新增日志时必须同时补齐 logger 的 import/声明（如 @Slf4j 与 import，或使用文件已有的 Logger 字段），不要只添加 log.xxx。
8. 只能调用项目中已存在的方法，或在同一条修改中新增该方法实现；不要凭空调用不存在的 Service、工具类或业务方法。
9. 不要直接修改文件。使用中文回答。`;

function turnLimitNote(turnLimit) {
  return Number.isFinite(turnLimit) && turnLimit > 0
    ? `\n\n补充：本轮最多 ${Math.floor(turnLimit)} 轮模型/工具交互。`
    : '\n\n补充：本轮不设固定轮次上限；不要重复调用没有新增证据的工具。';
}

const RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['conclusion', 'evidenceRefs', 'confidence', 'needsMoreInfo'],
  properties: {
    conclusion: { type: 'string' },
    evidenceRefs: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['type', 'ref'],
        properties: {
          type: { enum: ['request', 'response', 'log', 'source', 'thread', 'element'] },
          ref: { type: 'string' },
          note: { type: 'string' },
        },
      },
    },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    needsMoreInfo: { type: 'array', items: { type: 'string' } },
    fixes: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['summary', 'risk'],
        properties: {
          summary: { type: 'string' },
          root: { enum: ['backend', 'frontend', 'extra'] },
          extraRoot: { type: 'string' },
          file: { type: 'string' },
          search: { type: 'string' },
          replace: { type: 'string' },
          risk: { enum: ['low', 'medium', 'high'] },
          verification: { type: 'string' },
          note: { type: 'string' },
        },
      },
    },
  },
};

const SENSITIVE_HEADERS = new Set([
  'authorization', 'cookie', 'set-cookie', 'x-api-key', 'proxy-authorization', 'x-auth-token',
]);

function redactHeaders(headers = {}) {
  const out = {};
  for (const [key, value] of Object.entries(headers)) {
    out[key] = SENSITIVE_HEADERS.has(key.toLowerCase()) ? '<redacted>' : value;
  }
  return out;
}

function sanitizeEvidence(evidence) {
  return {
    symptom: evidence.symptom,
    request: {
      method: evidence.request?.method,
      url: evidence.request?.url,
      headers: redactHeaders(evidence.request?.headers),
      body: evidence.request?.body,
    },
    response: {
      status: evidence.response?.status,
      statusText: evidence.response?.statusText,
      ok: evidence.response?.ok,
      headers: redactHeaders(evidence.response?.headers),
      body: evidence.response?.body,
      error: evidence.response?.error,
    },
    marker: evidence.marker,
    logs: {
      count: evidence.logs?.count,
      markerMatched: evidence.logs?.markerMatched,
      waitedMs: evidence.logs?.waitedMs,
      parser: evidence.logs?.parser,
      parserFallback: evidence.logs?.parserFallback,
      parserWarning: evidence.logs?.parserWarning,
      stats: evidence.logs?.stats,
      records: (evidence.logs?.records ?? []).slice(0, 40),
    },
    threads: evidence.threads,
    source: evidence.source,
    frontend: evidence.frontend,
    extraSources: evidence.extraSources,
    element: evidence.element,
  };
}

function buildPrompt(question, evidence) {
  const pack = JSON.stringify(sanitizeEvidence(evidence), null, 2);
  return [
    '# 用户描述的症状',
    question?.trim() || '(用户未提供描述，请从证据中推断现象)',
    '',
    '# 已采集的证据包',
    '```json',
    pack.length > 60_000 ? `${pack.slice(0, 60_000)}\n… (evidence truncated)` : pack,
    '```',
    '',
    '# 任务',
    '定位问题根因。必要时调用工具补充日志、线程或源码证据，然后输出符合 JSON Schema 的结论。',
    '若证据包含 element，请结合元素所在组件、样式、附近请求和后端接口分析显示样式或数据不合理的原因。',
  ].join('\n');
}

function clip(value, max) {
  const text = String(value ?? '');
  return text.length > max ? `${text.slice(0, max)}\n… (truncated)` : text;
}

function compactWithheldFixes(fixes = []) {
  return fixes.slice(0, 5).map((fix) => (typeof fix === 'string'
    ? { summary: fix }
    : {
        summary: fix?.summary,
        root: fix?.root,
        extraRoot: fix?.extraRoot,
        file: fix?.file,
        risk: fix?.risk,
        preview: fix?.preview
          ? {
              status: fix.preview.status,
              message: fix.preview.message,
              line: fix.preview.line,
              patch: clip(fix.preview.patch, 4000),
            }
          : null,
      }));
}

export function buildFollowUpPrompt(question, previous = {}) {
  const agent = previous.agent ?? {};
  const fixes = (agent.fixes ?? []).slice(0, 10).map((fix) => (
    typeof fix === 'string'
      ? { summary: fix }
      : {
          summary: fix.summary,
          root: fix.root,
          extraRoot: fix.extraRoot,
          file: fix.file,
          search: fix.search,
          replace: fix.replace,
          risk: fix.risk,
          verification: fix.verification,
          note: fix.note,
          applied: fix.applied
            ? { applied: true, reverted: Boolean(fix.applied.revertedAt) }
            : undefined,
        }
  ));
  const snapshot = {
    originalQuestion: previous.meta?.question ?? '',
    conclusion: agent.conclusion ?? '',
    fixes,
    fixesWithheld: compactWithheldFixes(agent.fixesWithheld ?? []),
    fixesValidation: agent.fixesValidation
      ? {
          status: agent.fixesValidation.status,
          ok: agent.fixesValidation.ok,
          error: agent.fixesValidation.error,
          reason: agent.fixesValidation.reason,
          durationMs: agent.fixesValidation.durationMs,
          commands: (agent.fixesValidation.commands ?? []).slice(0, 5).map((entry) => ({
            command: entry.command,
            ok: entry.ok,
            exitCode: entry.exitCode,
            timedOut: entry.timedOut,
          })),
          output: clip(agent.fixesValidation.output, 6000),
        }
      : null,
    sandbox: agent.sandbox
      ? {
          changedFiles: (agent.sandbox.changedFiles ?? []).slice(0, 20),
          skipped: (agent.sandbox.skipped ?? []).slice(0, 20).map((entry) => ({
            file: entry.file,
            reason: entry.reason,
          })),
        }
      : null,
    toolCalls: summarizeToolCalls(agent.toolCalls),
    evidenceRefs: agent.evidenceRefs ?? [],
    needsMoreInfo: agent.needsMoreInfo ?? [],
    request: {
      method: previous.request?.method,
      url: previous.request?.url,
      headers: redactHeaders(previous.request?.headers),
      body: typeof previous.request?.body === 'string' ? previous.request.body.slice(0, 4000) : previous.request?.body,
    },
    response: {
      status: previous.response?.status,
      statusText: previous.response?.statusText,
      headers: redactHeaders(previous.response?.headers),
      body: typeof previous.response?.body === 'string' ? previous.response.body.slice(0, 4000) : previous.response?.body,
      error: previous.response?.error,
    },
    logs: {
      count: previous.logs?.count ?? 0,
      parser: previous.logs?.parser,
      parserFallback: previous.logs?.parserFallback,
      parserWarning: previous.logs?.parserWarning,
      records: (previous.logs?.records ?? []).slice(0, 20),
    },
    threads: previous.threads,
    source: previous.source,
    frontend: previous.frontend,
    extraSources: previous.extraSources,
    element: previous.element
      ? {
          page: previous.element.page,
          selector: previous.element.selector,
          text: previous.element.text,
          attributes: previous.element.attributes,
          styles: previous.element.styles,
          framework: previous.element.framework,
          source: previous.element.source,
          nearbyRequests: (previous.element.nearbyRequests ?? []).slice(0, 10),
        }
      : null,
  };
  const pack = JSON.stringify(snapshot, null, 2);
  return [
    '# 上一轮诊断',
    '```json',
    pack.length > 60_000 ? `${pack.slice(0, 60_000)}\n… (truncated)` : pack,
    '```',
    '',
    '# 用户追问',
    question?.trim() || '(用户未填写内容)',
    '',
    '# 任务',
    '在上一轮诊断基础上继续回答，输出更新后的结论与本轮修复建议。',
  ].join('\n');
}

function toolResultText(value) {
  const text = JSON.stringify(value, null, 2);
  if (text.length <= MAX_TOOL_TEXT) return text;
  return `${text.slice(0, MAX_TOOL_TEXT)}\n… (tool result truncated)`;
}

function normalizeAgentResult(parsed) {
  return {
    conclusion: String(parsed.conclusion ?? ''),
    evidenceRefs: Array.isArray(parsed.evidenceRefs) ? parsed.evidenceRefs : [],
    confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0,
    needsMoreInfo: Array.isArray(parsed.needsMoreInfo) ? parsed.needsMoreInfo : [],
    fixes: normalizeFixList(parsed.fixes),
  };
}

function parseStructured(text) {
  const raw = String(text ?? '').trim();
  const candidates = [raw];
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) candidates.push(fenced[1].trim());
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return normalizeAgentResult(parsed);
      }
    } catch {
      // try next candidate
    }
  }
  return {
    conclusion: raw,
    evidenceRefs: [],
    confidence: 0,
    needsMoreInfo: ['模型未返回结构化结果'],
    fixes: [],
  };
}

/**
 * Zod shapes for the in-process MCP tools. Keep this in sync with toolSpecs();
 * a missing shape makes SDK tool registration fail before the first model turn.
 *
 * @param {any} z zod namespace
 */
export function buildToolShapes(z) {
  return {
    get_logs: {
      marker: z.string().optional(),
      keyword: z.string().optional(),
      thread: z.string().optional(),
      level: z.string().optional(),
      minLevel: z.string().optional(),
      limit: z.number().int().min(1).max(500).optional(),
    },
    list_threads: {},
    search_log: {
      keyword: z.string(),
      limit: z.number().int().min(1).max(500).optional(),
    },
    read_source: {
      target: z.string(),
      root: z.enum(['backend', 'frontend', 'extra']).optional(),
      extraRoot: z.string().optional(),
      startLine: z.number().int().min(1).optional(),
      endLine: z.number().int().min(1).optional(),
    },
    search_source: {
      keyword: z.string(),
      root: z.enum(['backend', 'frontend', 'extra']).optional(),
      extraRoot: z.string().optional(),
      limit: z.number().int().min(1).max(200).optional(),
    },
    read: {
      file: z.string(),
      startLine: z.number().int().min(1).optional(),
      endLine: z.number().int().min(1).optional(),
    },
    query_db: {
      connection: z.string().optional(),
      sql: z.string(),
      limit: z.number().int().min(1).max(1000).optional(),
    },
    write_db: {
      connection: z.string().optional(),
      sql: z.string(),
    },
    run_command: {
      command: z.string(),
      cwd: z.string().optional(),
    },
  };
}

/**
 * Build only the SDK tools that have a schema. A future tool without a shape
 * is skipped (and reported to stderr) instead of aborting the diagnosis.
 */
function buildSdkTools(toolFn, specs, shapes, tools) {
  const supported = specs.filter((spec) => {
    if (shapes[spec.name]) return true;
    console.error(`[agent] tool ${spec.name} has no schema and is skipped`);
    return false;
  });
  const sdkTools = supported.map((spec) => toolFn(spec.name, spec.description, shapes[spec.name], async (args) => {
    const result = await tools.tools[spec.name](args);
    return {
      content: [{ type: 'text', text: toolResultText(result) }],
      isError: Boolean(result?.error),
    };
  }));
  return {
    sdkTools,
    names: supported.map((spec) => `mcp__debugcopilot__${spec.name}`),
  };
}

/**
 * Normalize SDK token accounting. `modelUsage` is the billing-grade source;
 * `usage` is the fallback for older SDK results.
 */
export function usageFromResult(resultMessage) {
  const models = Object.values(resultMessage?.modelUsage ?? {});
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadInputTokens = 0;
  let cacheCreationInputTokens = 0;
  if (models.length > 0) {
    for (const model of models) {
      inputTokens += Number(model?.inputTokens) || 0;
      outputTokens += Number(model?.outputTokens) || 0;
      cacheReadInputTokens += Number(model?.cacheReadInputTokens) || 0;
      cacheCreationInputTokens += Number(model?.cacheCreationInputTokens) || 0;
    }
  } else {
    const usage = resultMessage?.usage ?? {};
    inputTokens = Number(usage.input_tokens ?? usage.inputTokens) || 0;
    outputTokens = Number(usage.output_tokens ?? usage.outputTokens) || 0;
    cacheReadInputTokens = Number(usage.cache_read_input_tokens ?? usage.cacheReadInputTokens) || 0;
    cacheCreationInputTokens = Number(usage.cache_creation_input_tokens ?? usage.cacheCreationInputTokens) || 0;
  }
  const totalInputTokens = inputTokens + cacheReadInputTokens + cacheCreationInputTokens;
  return {
    numTurns: resultMessage?.num_turns ?? null,
    costUsd: resultMessage?.total_cost_usd ?? null,
    durationMs: resultMessage?.duration_ms ?? null,
    inputTokens,
    outputTokens,
    cacheReadInputTokens,
    cacheCreationInputTokens,
    totalInputTokens,
    totalTokens: totalInputTokens + outputTokens,
  };
}

/**
 * Live diagnoser backed by the Claude Agent SDK.
 * In-process MCP tools are read-only; built-in Claude Code tools are disabled.
 *
 * @param {{ model?: string, maxTurns?: number | null, timeoutMs?: number, cwd?: string }} [options]
 * `maxTurns` omitted/null means no turn limit; callers should still provide a budget/timeout.
 */
export const FULL_MODE_PROMPT = `

# 完全权限模式
你可以直接修改真实项目文件并执行 Bash 命令，但每次 Edit/Write/Bash 都会请求用户确认。
- 修改前先读取文件和引用，尽量给出最小、可编译的改动。
- 直接修改并验证完成后，不要再把同样的修改重复写进 fixes；只有未直接修改的方案才放进 fixes。
- 执行 Bash 时只运行必要的编译/测试命令，避免安装依赖、部署、推送、长时间运行或破坏性操作。
- 用户拒绝的操作不要重复尝试。`;

export function validationStrategyPrompt(toolMode = 'readonly') {
  if (toolMode === 'sandbox' || toolMode === 'full') {
    return `

# 验证策略（编译优先）
- 修改后必须尝试运行编译/测试（run_command 或 Bash）；失败就读取输出继续修改，直到通过为止，不要停在第一次尝试。
- logger/方法是否存在的静态规则只是兜底。编译/测试已经通过时，不要仅因为静态启发式疑似问题而放弃有效修复。
- 如果确实无法运行编译/测试，再严格遵守规则 13/14 的静态兜底要求。`;
  }
  return `

# 验证策略（静态兜底）
本轮不能直接运行编译/测试，必须严格遵守规则 13/14：
- 新增 log 必须补齐 import/logger 定义。
- 只能调用项目已有方法，或在同一条修改中新增方法实现。`;
}

export function createClaudeAgent({
  model,
  maxTurns = null,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  cwd,
  maxBudgetUsd,
  allowedRoots = [],
  toolMode = 'readonly',
  approval = null,
} = {}) {
  let scope = {
    cwd: cwd ?? process.cwd(),
    allowedRoots: [...allowedRoots],
    toolMode,
    approval,
    systemPromptSuffix: '',
  };
  const configureScope = (next = {}) => {
    scope = {
      ...scope,
      ...next,
      allowedRoots: next.allowedRoots ? [...next.allowedRoots] : scope.allowedRoots,
    };
  };

  return {
    id: 'claude',
    configureScope,
    async diagnose({ question, evidence, tools, budget, onToolUse = null }) {
      const { query, tool, createSdkMcpServer } = await import('@anthropic-ai/claude-agent-sdk');
      const { z } = await import('zod');
      const permission = createToolPermission(scope.allowedRoots, {
        cwd: scope.cwd,
        allowWrite: scope.toolMode !== 'readonly',
        allowBash: scope.toolMode === 'full',
        approve: scope.toolMode === 'full' ? (scope.approval ?? (async () => false)) : null,
        requireApproval: scope.toolMode === 'full',
      });
      const builtinTools = scope.toolMode === 'full'
        ? FULL_BUILTIN_TOOLS
        : scope.toolMode === 'sandbox'
          ? SANDBOX_BUILTIN_TOOLS
          : READ_ONLY_BUILTIN_TOOLS;
      const baseCwd = path.resolve(scope.cwd);
      const additionalDirectories = [...new Set(scope.allowedRoots.map((root) => path.resolve(root)))]
        .filter((root) => root !== baseCwd);
      const modeSuffix = scope.toolMode === 'full' ? FULL_MODE_PROMPT : '';

      const shapes = buildToolShapes(z);
      const built = buildSdkTools(tool, tools.specs, shapes, tools);
      const sdkTools = built.sdkTools;
      const toolNames = built.names;

      const server = createSdkMcpServer({
        name: 'debugcopilot',
        version: '0.1.0',
        tools: sdkTools,
        alwaysLoad: true,
      });

      const turnLimit = budget?.maxRounds ?? maxTurns;
      const session = query({
        prompt: buildPrompt(question, evidence),
        options: {
          tools: builtinTools,
          mcpServers: { debugcopilot: server },
          strictMcpConfig: true,
          allowedTools: toolNames,
          permissionMode: 'default',
          canUseTool: permission,
          settingSources: [],
          ...(additionalDirectories.length > 0 ? { additionalDirectories } : {}),
          ...(Number.isFinite(turnLimit) && turnLimit > 0 ? { maxTurns: Math.floor(turnLimit) } : {}),
          ...(maxBudgetUsd ? { maxBudgetUsd } : {}),
          systemPrompt: `${SYSTEM_PROMPT}${turnLimitNote(turnLimit)}${scope.systemPromptSuffix}${modeSuffix}${validationStrategyPrompt(scope.toolMode)}`,
          outputFormat: { type: 'json_schema', schema: RESULT_SCHEMA },
          ...(model ? { model } : {}),
          cwd: scope.cwd,
        },
      });

      let resultMessage = null;
      let partialText = '';
      const timer = setTimeout(() => {
        try {
          session.close();
        } catch {
          // ignore close errors on timeout
        }
      }, timeoutMs);

      try {
        for await (const message of session) {
          if (message.type === 'assistant') {
            for (const block of message.message?.content ?? []) {
              if (block?.type === 'text' && block.text) partialText += block.text;
              if (block?.type === 'tool_use' && onToolUse) {
                onToolUse({ stage: 'start', id: block.id, name: block.name, input: block.input });
              }
            }
          }
          if (message.type === 'user' && onToolUse) {
            for (const block of message.message?.content ?? []) {
              if (block?.type === 'tool_result') {
                onToolUse({ stage: 'done', id: block.tool_use_id, isError: Boolean(block.is_error) });
              }
            }
          }
          if (message.type === 'result') resultMessage = message;
        }
      } finally {
        clearTimeout(timer);
      }

      if (!resultMessage) {
        throw new AppError('AGENT_NO_RESULT', `Agent produced no result within ${timeoutMs}ms`, {
          exitCode: 1,
        });
      }
      if (resultMessage.subtype !== 'success' || resultMessage.is_error) {
        const reason = resultMessage.subtype === 'error_max_turns'
          ? '达到最大轮次'
          : resultMessage.subtype === 'error_max_budget_usd'
            ? '达到费用上限'
            : resultMessage.subtype === 'error_max_structured_output_retries'
              ? '结构化输出重试次数用尽'
              : `Agent 未完成（${resultMessage.subtype ?? 'unknown'}）`;
        const parsed = parseStructured(resultMessage.result ?? partialText);
        return {
          ...parsed,
          conclusion: parsed.conclusion?.trim() ? parsed.conclusion : `诊断未完成：${reason}`,
          evidenceRefs: parsed.evidenceRefs ?? [],
          needsMoreInfo: [...(parsed.needsMoreInfo ?? []), `诊断未完成：${reason}`],
          fixes: normalizeFixList(parsed.fixes),
          toolCalls: tools.calls ?? [],
          usage: usageFromResult(resultMessage),
          incomplete: true,
          incompleteReason: resultMessage.subtype ?? 'error',
          errors: Array.isArray(resultMessage.errors) ? resultMessage.errors : [],
        };
      }

      const parsed = parseStructured(resultMessage.result);
      return {
        ...parsed,
        toolCalls: tools.calls ?? [],
        usage: usageFromResult(resultMessage),
      };
    },

    async followUp({ question, previous, tools, budget, onToolUse = null }) {
      const { query } = await import('@anthropic-ai/claude-agent-sdk');
      const permission = createToolPermission(scope.allowedRoots, {
        cwd: scope.cwd,
        allowWrite: scope.toolMode !== 'readonly',
        allowBash: scope.toolMode === 'full',
        approve: scope.toolMode === 'full' ? (scope.approval ?? (async () => false)) : null,
        requireApproval: scope.toolMode === 'full',
      });
      const builtinTools = scope.toolMode === 'full'
        ? FULL_BUILTIN_TOOLS
        : scope.toolMode === 'sandbox'
          ? SANDBOX_BUILTIN_TOOLS
          : READ_ONLY_BUILTIN_TOOLS;
      const baseCwd = path.resolve(scope.cwd);
      const additionalDirectories = [...new Set(scope.allowedRoots.map((root) => path.resolve(root)))]
        .filter((root) => root !== baseCwd);
      const modeSuffix = scope.toolMode === 'full' ? FULL_MODE_PROMPT : '';
      let sdkTools = [];
      let server = null;
      let toolNames = [];
      if (tools?.specs?.length) {
        const { tool, createSdkMcpServer } = await import('@anthropic-ai/claude-agent-sdk');
        const { z } = await import('zod');
        const shapes = buildToolShapes(z);
        const built = buildSdkTools(tool, tools.specs, shapes, tools);
        sdkTools = built.sdkTools;
        toolNames = built.names;
        server = createSdkMcpServer({
          name: 'debugcopilot',
          version: '0.1.0',
          tools: sdkTools,
          alwaysLoad: true,
        });
      }
      const followUpTurnLimit = budget?.maxRounds ?? maxTurns;
      const session = query({
        prompt: buildFollowUpPrompt(question, previous),
        options: {
          tools: builtinTools,
          ...(server
            ? { mcpServers: { debugcopilot: server }, strictMcpConfig: true, allowedTools: toolNames }
            : { mcpServers: {}, strictMcpConfig: true, allowedTools: [] }),
          permissionMode: 'default',
          canUseTool: permission,
          settingSources: [],
          ...(additionalDirectories.length > 0 ? { additionalDirectories } : {}),
          ...(Number.isFinite(followUpTurnLimit) && followUpTurnLimit > 0
            ? { maxTurns: Math.floor(followUpTurnLimit) }
            : {}),
          ...(maxBudgetUsd ? { maxBudgetUsd } : {}),
          systemPrompt: `${FOLLOWUP_SYSTEM_PROMPT}${turnLimitNote(followUpTurnLimit)}${scope.systemPromptSuffix}${modeSuffix}${validationStrategyPrompt(scope.toolMode)}`,
          outputFormat: { type: 'json_schema', schema: RESULT_SCHEMA },
          ...(model ? { model } : {}),
          cwd: scope.cwd,
        },
      });

      let resultMessage = null;
      let partialText = '';
      const timer = setTimeout(() => {
        try {
          session.close();
        } catch {
          // ignore close errors on timeout
        }
      }, timeoutMs);

      try {
        for await (const message of session) {
          if (message.type === 'assistant') {
            for (const block of message.message?.content ?? []) {
              if (block?.type === 'text' && block.text) partialText += block.text;
              if (block?.type === 'tool_use' && onToolUse) {
                onToolUse({ stage: 'start', id: block.id, name: block.name, input: block.input });
              }
            }
          }
          if (message.type === 'user' && onToolUse) {
            for (const block of message.message?.content ?? []) {
              if (block?.type === 'tool_result') {
                onToolUse({ stage: 'done', id: block.tool_use_id, isError: Boolean(block.is_error) });
              }
            }
          }
          if (message.type === 'result') resultMessage = message;
        }
      } finally {
        clearTimeout(timer);
      }

      if (!resultMessage) {
        throw new AppError('AGENT_NO_RESULT', `Agent produced no result within ${timeoutMs}ms`, {
          exitCode: 1,
        });
      }
      if (resultMessage.subtype !== 'success' || resultMessage.is_error) {
        const reason = resultMessage.subtype === 'error_max_turns'
          ? '达到最大轮次'
          : resultMessage.subtype === 'error_max_budget_usd'
            ? '达到费用上限'
            : `继续诊断未完成（${resultMessage.subtype ?? 'unknown'}）`;
        const parsed = parseStructured(resultMessage.result ?? partialText);
        return {
          ...parsed,
          conclusion: parsed.conclusion?.trim() ? parsed.conclusion : `继续诊断未完成：${reason}`,
          needsMoreInfo: [...(parsed.needsMoreInfo ?? []), `继续诊断未完成：${reason}`],
          fixes: normalizeFixList(parsed.fixes),
          toolCalls: tools?.calls ?? [],
          usage: usageFromResult(resultMessage),
          incomplete: true,
          incompleteReason: resultMessage.subtype ?? 'error',
          errors: Array.isArray(resultMessage.errors) ? resultMessage.errors : [],
        };
      }

      const parsed = parseStructured(resultMessage.result);
      return {
        ...parsed,
        toolCalls: tools?.calls ?? [],
        usage: usageFromResult(resultMessage),
      };
    },
  };
}
