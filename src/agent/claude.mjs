import { AppError } from '../core/errors.mjs';

const DEFAULT_MAX_TURNS = 24;
const DEFAULT_TIMEOUT_MS = 180_000;
const MAX_TOOL_TEXT = 20_000;

const SYSTEM_PROMPT = `你是 DebugCopilot 的后端问题定位助手。你的任务是结合请求、响应、日志与源码证据，定位问题并给出可执行的结论。

规则：
1. 只能通过 debugcopilot 提供的只读工具获取证据，不要假设未读取的文件内容。
2. 每条结论都必须有证据支撑；evidenceRefs 的 ref 必须指向证据包中的条目（request / response / logs.records[i] / source.files[i] / threads）。
3. 证据不足时写入 needsMoreInfo，不要编造日志、堆栈或源码。
4. 工具调用轮次有限（最多 24 轮），没有新增证据就停止并给出阶段性结论。
5. 使用中文回答，结论要具体（涉及类名、日志关键行、HTTP 状态码）。
6. 不要输出密码、Token、Cookie 等敏感信息。`;

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
          type: { enum: ['request', 'response', 'log', 'source', 'thread'] },
          ref: { type: 'string' },
          note: { type: 'string' },
        },
      },
    },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    needsMoreInfo: { type: 'array', items: { type: 'string' } },
    fixes: { type: 'array', items: { type: 'string' } },
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
      stats: evidence.logs?.stats,
      records: (evidence.logs?.records ?? []).slice(0, 40),
    },
    threads: evidence.threads,
    source: evidence.source,
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
    fixes: Array.isArray(parsed.fixes) ? parsed.fixes : [],
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
 * Live diagnoser backed by the Claude Agent SDK.
 * In-process MCP tools are read-only; built-in Claude Code tools are disabled.
 *
 * @param {{ model?: string, maxTurns?: number, timeoutMs?: number, cwd?: string }} [options]
 */
export function createClaudeAgent({ model, maxTurns = DEFAULT_MAX_TURNS, timeoutMs = DEFAULT_TIMEOUT_MS, cwd, maxBudgetUsd } = {}) {
  return {
    id: 'claude',
    async diagnose({ question, evidence, tools, budget }) {
      const { query, tool, createSdkMcpServer } = await import('@anthropic-ai/claude-agent-sdk');
      const { z } = await import('zod');

      const shapes = {
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
          startLine: z.number().int().min(1).optional(),
          endLine: z.number().int().min(1).optional(),
        },
        search_source: {
          keyword: z.string(),
          limit: z.number().int().min(1).max(200).optional(),
        },
        read: {
          file: z.string(),
          startLine: z.number().int().min(1).optional(),
          endLine: z.number().int().min(1).optional(),
        },
      };

      const sdkTools = tools.specs.map((spec) =>
        tool(spec.name, spec.description, shapes[spec.name], async (args) => {
          const result = await tools.tools[spec.name](args);
          return {
            content: [{ type: 'text', text: toolResultText(result) }],
            isError: Boolean(result?.error),
          };
        }),
      );

      const server = createSdkMcpServer({
        name: 'debugcopilot',
        version: '0.1.0',
        tools: sdkTools,
        alwaysLoad: true,
      });
      const toolNames = tools.specs.map((spec) => `mcp__debugcopilot__${spec.name}`);

      const session = query({
        prompt: buildPrompt(question, evidence),
        options: {
          tools: [],
          mcpServers: { debugcopilot: server },
          strictMcpConfig: true,
          allowedTools: toolNames,
          permissionMode: 'dontAsk',
          maxTurns: budget?.maxRounds ?? maxTurns,
          ...(maxBudgetUsd ? { maxBudgetUsd } : {}),
          systemPrompt: SYSTEM_PROMPT,
          outputFormat: { type: 'json_schema', schema: RESULT_SCHEMA },
          ...(model ? { model } : {}),
          ...(cwd ? { cwd } : {}),
        },
      });

      let resultMessage = null;
      const timer = setTimeout(() => {
        try {
          session.close();
        } catch {
          // ignore close errors on timeout
        }
      }, timeoutMs);

      try {
        for await (const message of session) {
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
        throw new AppError(
          'AGENT_RUN_FAILED',
          `Agent failed: ${resultMessage.subtype ?? 'unknown'}`,
          { exitCode: 1, details: { result: resultMessage.result } },
        );
      }

      const parsed = parseStructured(resultMessage.result);
      return {
        ...parsed,
        toolCalls: tools.calls ?? [],
        usage: {
          numTurns: resultMessage.num_turns ?? null,
          costUsd: resultMessage.total_cost_usd ?? null,
          durationMs: resultMessage.duration_ms ?? null,
        },
      };
    },
  };
}
