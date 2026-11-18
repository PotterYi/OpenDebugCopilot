import { realpath } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { AppError } from '../core/errors.mjs';
import { normalizeFixList } from '../core/fixes.mjs';
import { normalizeActionList } from '../core/actions.mjs';
import { summarizeToolCalls } from '../core/tool-calls.mjs';
import { redactHeaders, redactValue } from '../core/redact.mjs';
import { isSafeBashCommand } from '../core/bash-policy.mjs';
import { inside, isSensitivePath } from '../core/path-policy.mjs';
import { triagePromptLines } from '../core/triage.mjs';
import { boundaryGuidance, createDenialTracker } from '../tools/guidance.mjs';

// Never use []: SDK isolation mode drops the user's Claude Code settings,
// including auth env vars such as ANTHROPIC_AUTH_TOKEN/ANTHROPIC_BASE_URL.
export const CLAUDE_SETTING_SOURCES = Object.freeze(['user']);

/**
 * PostToolUse hook: built-in Read/Grep/Bash output bypasses our MCP tools, so
 * redact secrets before the content reaches the model (and later transcripts).
 */
export async function redactToolOutputHook(input = {}) {
  if (input?.hook_event_name !== 'PostToolUse') return { continue: true };
  return {
    continue: true,
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      updatedToolOutput: redactValue(input.tool_response),
    },
  };
}

const REDACT_TOOL_OUTPUT_HOOKS = Object.freeze({
  PostToolUse: [{ hooks: [redactToolOutputHook] }],
});

/**
 * Build the SDK auth-related options. `env` REPLACES the subprocess
 * environment, so always spread process.env. When the app supplies a custom
 * token we also stop loading user settings, otherwise ~/.claude/settings.json
 * could silently override the configured credential.
 */
export function sdkAuthOptions(auth = null) {
  const env = auth?.env && Object.keys(auth.env).length > 0 ? auth.env : null;
  const settingSources = Array.isArray(auth?.settingSources)
    ? auth.settingSources
    : [...CLAUDE_SETTING_SOURCES];
  return {
    settingSources: [...settingSources],
    ...(env ? { env: { ...process.env, ...env } } : {}),
  };
}

export const READ_ONLY_BUILTIN_TOOLS = Object.freeze(['Read', 'Grep', 'Glob']);
export const SANDBOX_BUILTIN_TOOLS = Object.freeze(['Read', 'Grep', 'Glob', 'Edit', 'Write']);
export const FULL_BUILTIN_TOOLS = Object.freeze(['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash']);

const WRITE_DENY_ANYWHERE = new Set(['.git', 'node_modules']);
const WRITE_OUTPUT_SEGMENTS = new Set([
  'target', 'dist', 'build', 'out', 'bin', 'obj', 'logs', 'runs',
  'coverage', '__pycache__', '.gradle', '.cache',
  '.next', '.nuxt', '.idea', '.vscode', 'vendor',
]);
const execFileAsync = promisify(execFile);

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
  writeRoots = null,
  allowBash = false,
  approve = null,
  requireApproval = false,
  bashApproval = null,
  onBeforeWrite = null,
} = {}) {
  const roots = [...new Set((allowedRoots.length > 0 ? allowedRoots : [cwd])
    .map((root) => path.resolve(root)))];
  const writableRoots = [...new Set(((writeRoots ?? allowedRoots).length > 0
    ? (writeRoots ?? allowedRoots)
    : [cwd]).map((root) => path.resolve(root)))];
  const bashDenials = createDenialTracker();

  function denyBash(message, details) {
    const guidance = boundaryGuidance({
      tool: 'Bash',
      code: 'COMMAND_DENIED',
      details,
      mode: allowBash ? 'full' : 'readonly',
    });
    const repetition = bashDenials.recordFailure({ tool: 'Bash', code: 'COMMAND_DENIED' });
    const lines = [message];
    if (guidance?.hint) lines.push(guidance.hint);
    if (guidance?.usage?.length) lines.push(`可用形式：${guidance.usage.join(' / ')}`);
    if (repetition?.repeated >= 2) {
      lines.push(`你已连续 ${repetition.repeated} 次触发同一 Bash 边界；停止试探，按上面的形式选择。`);
    }
    return { behavior: 'deny', message: lines.join('\n') };
  }

  async function resolveTarget(raw) {
    const resolved = path.resolve(cwd, raw || '.');
    return realpath(resolved).catch(() => resolved);
  }

  async function insideAny(target, rootList = roots) {
    const realTarget = await realpath(target).catch(() => target);
    for (const root of rootList) {
      const realRoot = await realpath(root).catch(() => root);
      if (inside(realRoot, realTarget)) return true;
    }
    return false;
  }

  async function writableRootFor(target) {
    const realTarget = await realpath(target).catch(() => target);
    let best = null;
    for (const root of writableRoots) {
      const realRoot = await realpath(root).catch(() => root);
      if (!inside(realRoot, realTarget)) continue;
      if (!best || realRoot.length > best.root.length) {
        best = { root: realRoot, relative: path.relative(realRoot, realTarget) };
      }
    }
    return best;
  }

  async function gitIgnoreStatus(root, relative) {
    try {
      await execFileAsync('git', ['-C', root, 'check-ignore', '-q', '--', relative], {
        windowsHide: true,
        timeout: 5000,
        maxBuffer: 1024 * 1024,
      });
      return 'ignored';
    } catch (error) {
      // git check-ignore exits 1 for "not ignored" and 128 when not a repo.
      return error?.code === 1 ? 'tracked' : 'no-repo';
    }
  }

  /**
   * Check the path relative to the writable root, not the absolute path.
   * Copy sandboxes live under runs/<runId>/sandbox, and projects may live under
   * a folder literally named "build" or "out"; both must not block every write.
   */
  async function isDeniedWritePath(target) {
    const match = await writableRootFor(target);
    if (!match) return false;
    const parts = match.relative.replace(/\\/g, '/').split('/').filter(Boolean);
    if (parts.some((segment) => WRITE_DENY_ANYWHERE.has(segment.toLowerCase()))) return true;
    if (parts.length === 0) return false;
    const hasOutputSegment = parts.some((segment) => WRITE_OUTPUT_SEGMENTS.has(segment.toLowerCase()));
    if (!hasOutputSegment) return false;
    // Git is the source of truth inside a repository: ignored build outputs are
    // denied, while tracked/legitimate folders named build/out stay writable.
    const status = await gitIgnoreStatus(match.root, parts.join('/'));
    if (status === 'ignored') return true;
    if (status === 'tracked') return false;
    // No Git (copy sandbox): only deny output names at the workspace root.
    return WRITE_OUTPUT_SEGMENTS.has(parts[0].toLowerCase());
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
      if (toolName === 'Bash') {
        return denyBash('当前模式不允许 Bash。', { reason: 'bash-disabled' });
      }
      return {
        behavior: 'deny',
        message: `工具 ${toolName} 未授权；当前模式不允许该工具。`,
      };
    }
    if (toolName === 'Bash') {
      const command = String(input.command ?? '').trim();
      if (!command) return denyBash('Bash 命令为空。', { reason: 'empty' });
      const safe = isSafeBashCommand(command);
      if (typeof bashApproval === 'function') {
        let allowed = false;
        try {
          allowed = await bashApproval({ command, safe });
        } catch {
          allowed = false;
        }
        if (!allowed) {
          return denyBash('危险 Bash 命令未获确认。', { reason: 'approval' });
        }
      } else if (!safe) {
        return denyBash('危险 Bash 命令未配置确认回调，已拒绝。', { reason: 'approval' });
      }
      if (requireApproval) {
        const result = await askApproval('Bash', input);
        if (result.behavior === 'deny') return denyBash(result.message, { reason: 'approval' });
        bashDenials.recordSuccess('Bash');
        return result;
      }
      bashDenials.recordSuccess('Bash');
      return { behavior: 'allow', updatedInput: input };
    }
    if (toolName === 'Glob') {
      const pattern = String(input.pattern ?? '');
      if (path.isAbsolute(pattern) || pattern.includes('..') || pattern.startsWith('~')) {
        return { behavior: 'deny', message: 'Glob 只允许在授权目录内搜索，禁止绝对路径、~ 或 .. 越界。' };
      }
    }
    const rawPath = toolName === 'Read' || isWrite ? input.file_path : input.path;
    const target = await resolveTarget(rawPath);
    if (!await insideAny(target, isWrite ? writableRoots : roots)) {
      return {
        behavior: 'deny',
        message: isWrite
          ? `路径不在可写源码目录内：${target}`
          : `路径不在授权目录内：${target}`,
      };
    }
    if (isSensitivePath(target)) {
      return { behavior: 'deny', message: `拒绝访问敏感文件：${target}` };
    }
    if (isWrite && await isDeniedWritePath(target)) {
      return {
        behavior: 'deny',
        message: `禁止修改构建产物、依赖或版本控制目录：${target}`,
      };
    }
    if (isWrite && typeof onBeforeWrite === 'function') {
      try {
        await onBeforeWrite({ toolName, input, filePath: target });
      } catch (error) {
        return {
          behavior: 'deny',
          message: `无法保存修改前快照：${error?.message ?? error}`,
        };
      }
    }
    if (isWrite && requireApproval) {
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
2. 每条结论都必须有证据支撑；evidenceRefs 的 ref 必须真实存在于证据包中（request / response / logs.records[i] / source.files[i] / threads / element），不要臆造索引或路径。系统会校验引用是否存在。
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
14. [静态兜底] 修改只能调用项目中已存在的方法，或在同一条修改中同时新增该方法实现；不要凭空调用不存在的 Service、工具类或业务方法。若本轮能运行编译/测试，以编译结果为准。
15. 遇到 NoClassDefFoundError / ClassNotFoundException / NoSuchMethodError / NoSuchFieldError / LinkageError 时，先用 list_processes（可按 port/name/commandContains 过滤）确认哪个实例在跑；需要 jar 级别差异时再用 runtime_classpath 对比声明侧 classpath（declaredFile 可用 mvn dependency:build-classpath -Dmdep.includeScope=runtime 生成）。拿不到运行侧或声明侧时写入 needsMoreInfo，不要臆测 jar 列表。
16. 本机可能同时存在 IDE 调试实例、解压部署目录和旧进程。不要默认选第一个 Java 进程；用 pid、监听端口、startedAt、command 与当前源码根/请求时间交叉确认，无法区分时先说明候选，不要对着未运行的对象下结论。使用 commandContains 时只传类名、jar 名、profile 等非敏感标识，不要把密码或 Token 作为过滤词。
17. 诊断前确认是用户先验，不是已验证事实；先按它调整假设优先级，再核对证据。不要重复询问已经回答的问题；只把未回答且无法从证据推断的信息写入 needsMoreInfo。若用户跳过确认，环境/范围问题应优先在 needsMoreInfo 中提出。
18. 查看最近代码变更用 git_status / git_log / git_diff；查看目录或文件时间用 list_dir / stat_file。不要用 run_command 执行 git、find 或 Python 脚本；read 只用于 evidence 溢写结果，目录和源码分别用 list_dir、read_source。
19. 需要 Maven 依赖树或声明 classpath 时优先用 maven_dependencies（includes/excludes 用数组），不要用 run_command 拼 -Dincludes；它返回的 declaredFile 可直接交给 runtime_classpath。run_command 结果标记 cached:true 时，如果期间没有修改文件，不要重复执行同一命令。
20. 编译/测试通过不等于症状消失。系统会生成「症状验证」待办；不要要求用户“手动确认症状”并把它写进 needsMoreInfo，needsMoreInfo 只写其他缺失信息。若判断需要人工复现，可简述复现步骤，但最终状态由症状验证待办记录。
21. 如果正确修法不是改代码（配置、构建刷新、补打包依赖、重启/换运行实例、数据修复、部署环境），用 actions 输出结构化动作，写明 type、summary、requires、steps、commands、verification、risk；不要塞进 conclusion 或 needsMoreInfo。能在仓库内用源码/配置补丁修复的仍用 fixes。
22. 列表工具返回 spilled/nextOffset/file 时，用 query_result 按 field/offset/limit/filter 取后续数据；不要反复调用同一个大列表工具，也不要要求用户提供完整 classpath/依赖树。
23. 判断 IDE/工程模型是否过期时用 inspect_build_model（POM 模块、modules.xml/iml、时间戳、staleHints）。构建探针根只读，只允许构建模型文件，不要读取同级其他源码或 .idea/workspace.xml。
24. 运行时事实用 runtime_facts；selectors 只传需要看的键/前缀/简单通配，comparePid 可比较两个实例。敏感值会被脱敏，通配只返回键名；不要要求输出全部系统属性或环境变量。
25. 源码与配置检索用 search_source：默认包含 POM/YAML/properties/JSON 等配置文件，可用 includeConfig=false 只看代码。需要正则时传 regex=true（≤200 字符，禁用反向引用/后顾/嵌套量词；在 worker 中执行，5 秒超时）。结果按 path+line 稳定排序，用 offset/nextOffset 翻页；标记 spilled/file 时用 query_result field=matches 取后续页，不要重复同一关键词。pom.xml、application-*.yml 等配置可直接用 read_source 按路径读取。
26. 结论必须可证伪：在 rejectedHypotheses 中列出本轮认真考虑后排除的备选假设（建议 1-3 条，最多 5 条），每条写清 hypothesis、refutedBy（至少 1 条真实存在的证据引用）和 reason（为什么该证据否定它）。只把“被正面证据否定”的假设列入；仅有证据缺失时不要声称已排除。若确实没有可排除的备选假设，rejectedHypotheses 留空，并在 noRejectedHypothesesReason 中说明原因；不要为了填字段编造假设或引用。

# 工具边界（先看这里，不要试探）
- run_command：只允许项目构建/测试工具链（mvn/gradle/npm/pnpm/yarn/npx/pytest/go/dotnet/cargo/python），一次一条；禁止 ; | && $()、install/publish/run/dev server。不要用 python -V、echo、print 试探能力。
- read：只读 evidence 溢写结果；源码和配置用 read_source，目录用 list_dir，文件时间用 stat_file。搜索代码与配置用 search_source；需要正则时显式 regex=true。
- Git 用 git_status / git_log / git_diff；进程用 list_processes；classpath 用 runtime_classpath。
- 工具拒绝时先阅读 error 的 hint/usage；不要重复同一种被拒绝的写法。`;

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
9. 遇到链接/类缺失类错误时，先用 list_processes 确认实际在跑的实例，再用 runtime_classpath 对比运行侧与声明侧 classpath；本机有多个实例时不要默认选第一个，拿不到证据时明确说明，不要臆测 jar 列表。
10. 上一轮已收集的诊断前提不要重复询问；用户修改前提时以最新回答为准。若回答与证据冲突，明确指出冲突。
11. 查看最近变更用 git_status / git_log / git_diff，查看目录/文件时间用 list_dir / stat_file；不要用 run_command 执行 git/find/Python。工具拒绝时先阅读 hint/usage，不要重复同一种被拒绝的写法。需要 Maven 依赖树时用 maven_dependencies，不要拼 -Dincludes；cached:true 时不要重复执行同一命令。
12. 编译/测试通过不等于症状消失；系统有独立的「症状验证」待办。不要把症状确认写入 needsMoreInfo。
13. 正确修法不是改代码时（配置/构建/依赖/运行实例/部署/数据），用 actions 输出结构化动作，不要塞进 needsMoreInfo；能在仓库内修改的仍用 fixes。
14. 列表结果标记 spilled/nextOffset/file 时用 query_result 分页/过滤，不要重复调用大列表工具。工程模型过期用 inspect_build_model，探针根只读，不读同级源码或 workspace.xml。运行时事实用 runtime_facts，按 selector 精确查询。源码/配置检索用 search_source（默认含配置，regex=true 走受控 worker），可按 offset/nextOffset 或 query_result field=matches 翻页。
15. 不要直接修改文件。使用中文回答。
16. 追问若重新定位了根因，必须同步更新 rejectedHypotheses（排除的备选假设 + 真实存在的否定证据 + 理由）；若只是解释、评估或修改建议，且没有重新定位根因，rejectedHypotheses 留空并在 noRejectedHypothesesReason 中说明“本轮为追问解释，未重新定位根因”。不要输出不存在的证据引用。`;

/** Build a system prompt array with a static cacheable prefix. */
export function buildCachedSystemPrompt(staticPrompt, dynamicSuffix, boundary = '__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__') {
  return [
    staticPrompt,
    boundary,
    dynamicSuffix,
  ].filter((part) => typeof part === 'string' && part.length > 0);
}

function turnLimitNote(turnLimit) {
  return Number.isFinite(turnLimit) && turnLimit > 0
    ? `\n\n补充：本轮最多 ${Math.floor(turnLimit)} 轮模型/工具交互。`
    : '\n\n补充：本轮不设固定轮次上限；不要重复调用没有新增证据的工具。';
}

const RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['conclusion', 'evidenceRefs', 'confidence', 'needsMoreInfo', 'rejectedHypotheses'],
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
    rejectedHypotheses: {
      type: 'array',
      maxItems: 5,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['hypothesis', 'refutedBy', 'reason'],
        properties: {
          hypothesis: { type: 'string' },
          refutedBy: {
            type: 'array',
            minItems: 1,
            maxItems: 3,
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
          reason: { type: 'string' },
        },
      },
    },
    noRejectedHypothesesReason: { type: 'string' },
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
    actions: {
      type: 'array',
      maxItems: 5,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['type', 'summary', 'steps', 'verification', 'risk'],
        properties: {
          type: { enum: ['config', 'build', 'dependency', 'runtime', 'data', 'deployment', 'environment'] },
          summary: { type: 'string' },
          reason: { type: 'string' },
          requires: { type: 'array', items: { type: 'string' } },
          steps: { type: 'array', minItems: 1, items: { type: 'string' } },
          commands: {
            type: 'array',
            items: {
              oneOf: [
                { type: 'string' },
                {
                  type: 'object',
                  additionalProperties: false,
                  required: ['command'],
                  properties: {
                    label: { type: 'string' },
                    command: { type: 'string' },
                    risk: { enum: ['low', 'medium', 'high'] },
                  },
                },
              ],
            },
          },
          verification: {
            type: 'object',
            additionalProperties: false,
            required: ['kind'],
            properties: {
              kind: { enum: ['symptom', 'command', 'inspection', 'log', 'runtime'] },
              description: { type: 'string' },
              command: { type: 'string' },
              expected: { type: 'string' },
            },
          },
          risk: { enum: ['low', 'medium', 'high'] },
          reversible: { type: 'boolean' },
          confirmationRequired: { type: 'boolean' },
        },
      },
    },
  },
};

function sanitizeEvidence(evidence) {
  return {
    symptom: evidence.symptom,
    triage: evidence.triage,
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

export function buildPrompt(question, evidence) {
  const pack = JSON.stringify(redactValue(sanitizeEvidence(evidence)), null, 2);
  return [
    '# 用户描述的症状',
    question?.trim() || '(用户未提供描述，请从证据中推断现象)',
    '',
    '# 诊断前确认（用户回答）',
    ...triagePromptLines(evidence.triage),
    '',
    '# 诊断前提使用规则',
    '- 这些是用户先验，不是已验证事实；与日志/源码/请求证据冲突时，明确指出冲突并请求确认。',
    '- 不要重复询问已经回答的问题；needsMoreInfo 只写未回答且无法从证据推断的信息。',
    '- 仅部署复现或仅本机复现时，优先比较配置、profile、classpath、依赖、数据和权限，不要直接改业务代码。',
    '- 仅当前接口/页面：优先路由、Controller、Service、页面组件；整个服务/多个模块：优先共享配置、数据库、网络和公共依赖。',
    '- 最近改依赖：优先使用 runtime_classpath 检查版本差异；改配置：检查 profile/env/端口/CORS/日志路径；改代码：结合近期 diff。',
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
    triage: previous.meta?.triage ?? null,
    conclusion: agent.conclusion ?? '',
    rejectedHypotheses: (Array.isArray(agent.rejectedHypotheses) ? agent.rejectedHypotheses : [])
      .slice(0, 5)
      .map((item) => ({
        hypothesis: item.hypothesis,
        refutedBy: (item.refutedBy ?? []).slice(0, 3),
        reason: item.reason,
      })),
    noRejectedHypothesesReason: agent.noRejectedHypothesesReason ?? '',
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
    workspaceSession: agent.workspaceSession
      ? {
          mode: agent.workspaceSession.mode,
          status: agent.workspaceSession.status,
          changedFiles: (agent.workspaceSession.changedFiles ?? []).slice(0, 20),
          conflicts: (agent.workspaceSession.conflicts ?? []).slice(0, 10),
          selfCheck: agent.workspaceSession.selfCheck
            ? {
                status: agent.workspaceSession.selfCheck.status,
                error: agent.workspaceSession.selfCheck.error,
                commands: (agent.workspaceSession.selfCheck.commands ?? []).slice(0, 5),
                output: clip(agent.workspaceSession.selfCheck.output, 4000),
              }
            : null,
        }
      : null,
    verification: agent.verification
      ? {
          status: agent.verification.status,
          mode: agent.verification.mode,
          error: agent.verification.error,
          reason: agent.verification.reason,
          commands: (agent.verification.commands ?? []).slice(0, 5).map((entry) => entry.command).filter(Boolean),
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
  const pack = JSON.stringify(redactValue(snapshot), null, 2);
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

export const REPAIR_SYSTEM_PROMPT = `你是 DebugCopilot 的自动修复助手，正在处理上一轮修改导致的编译/测试失败。

规则：
1. 可以在当前工作区继续修改并运行编译/测试；只修复失败输出中明确的问题。
2. 不要重复上一轮已经失败的同一种修改；不要删除、跳过或弱化测试来掩盖失败。
3. 如果判断是依赖、网络、权限或环境问题，不要继续尝试，在 needsMoreInfo 中说明需要什么。
4. 不要访问工作区之外的路径；输出仍使用 JSON Schema。
5. 修复完成后不要重复把同样的修改写进 fixes；只有未直接修改的方案才放进 fixes。`;

export function buildRepairPrompt(failure, previous = {}) {
  const agent = previous.agent ?? {};
  const changedFiles = agent.workspaceSession?.changedFiles
    ?? agent.sandbox?.changedFiles
    ?? [];
  const fixes = (agent.fixes ?? []).slice(0, 10).map((fix) => (
    typeof fix === 'string'
      ? { summary: fix }
      : {
          summary: fix.summary,
          root: fix.root,
          file: fix.file,
          risk: fix.risk,
        }
  ));
  const snapshot = {
    originalQuestion: previous.meta?.question ?? '',
    conclusion: agent.conclusion ?? '',
    changedFiles,
    fixes,
    request: previous.request
      ? { method: previous.request.method, url: previous.request.url }
      : null,
    response: previous.response
      ? { status: previous.response.status, durationMs: previous.response.durationMs }
      : null,
  };
  const failureText = JSON.stringify(redactValue(failure ?? {}), null, 2);
  const snapshotText = JSON.stringify(redactValue(snapshot), null, 2);
  return [
    '# 自动修复回合',
    '上一轮修改后编译/测试未通过。请基于下面的结构化失败输出继续修复。',
    '',
    '# 结构化失败',
    '```json',
    failureText.length > 12_000 ? `${failureText.slice(0, 12_000)}\n… (truncated)` : failureText,
    '```',
    '',
    '# 上一轮上下文',
    '```json',
    snapshotText.length > 20_000 ? `${snapshotText.slice(0, 20_000)}\n… (truncated)` : snapshotText,
    '```',
    '',
    '# 任务',
    '只修复失败输出中的问题，修改后重新运行编译/测试。若失败来自环境、依赖、网络或权限，停止并在 needsMoreInfo 中说明，不要重复尝试。',
  ].join('\n');
}

function toolResultText(value) {
  const text = JSON.stringify(redactValue(value), null, 2);
  if (text.length <= MAX_TOOL_TEXT) return text;
  return `${text.slice(0, MAX_TOOL_TEXT)}\n… (tool result truncated)`;
}

function normalizeRejectedHypotheses(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 5)
    .filter((item) => item && typeof item === 'object')
    .map((item) => ({
      hypothesis: String(item.hypothesis ?? '').trim(),
      refutedBy: (Array.isArray(item.refutedBy) ? item.refutedBy : []).slice(0, 3)
        .filter((ref) => ref && typeof ref === 'object')
        .map((ref) => ({
          type: String(ref.type ?? '').trim(),
          ref: String(ref.ref ?? '').trim(),
          ...(ref.note ? { note: String(ref.note).trim() } : {}),
        })),
      reason: String(item.reason ?? '').trim(),
    }));
}

function normalizeAgentResult(parsed) {
  return {
    conclusion: String(parsed.conclusion ?? ''),
    evidenceRefs: Array.isArray(parsed.evidenceRefs) ? parsed.evidenceRefs : [],
    confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0,
    needsMoreInfo: Array.isArray(parsed.needsMoreInfo) ? parsed.needsMoreInfo : [],
    rejectedHypotheses: normalizeRejectedHypotheses(parsed.rejectedHypotheses),
    noRejectedHypothesesReason: String(parsed.noRejectedHypothesesReason ?? '').trim(),
    fixes: normalizeFixList(parsed.fixes),
    actions: normalizeActionList(parsed.actions),
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
    rejectedHypotheses: [],
    noRejectedHypothesesReason: '模型未返回结构化结果',
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
      regex: z.boolean().optional(),
      caseSensitive: z.boolean().optional(),
      includeConfig: z.boolean().optional(),
      root: z.enum(['backend', 'frontend', 'extra']).optional(),
      extraRoot: z.string().optional(),
      offset: z.number().int().min(0).max(10000).optional(),
      limit: z.number().int().min(1).max(200).optional(),
    },
    read: {
      file: z.string(),
      startLine: z.number().int().min(1).optional(),
      endLine: z.number().int().min(1).optional(),
    },
    inspect_build_model: {
      root: z.enum(['backend']).optional(),
    },
    query_result: {
      file: z.string(),
      field: z.string().optional(),
      offset: z.number().int().min(0).max(10000).optional(),
      limit: z.number().int().min(1).max(200).optional(),
      filter: z.string().optional(),
    },
    list_java_processes: {
      port: z.number().int().min(1).max(65535).optional(),
    },
    list_processes: {
      pid: z.number().int().min(1).optional(),
      port: z.number().int().min(1).max(65535).optional(),
      name: z.string().optional(),
      commandContains: z.string().optional(),
      javaOnly: z.boolean().optional(),
      limit: z.number().int().min(1).max(200).optional(),
    },
    list_dir: {
      root: z.enum(['backend', 'frontend', 'extra']).optional(),
      extraRoot: z.string().optional(),
      path: z.string().optional(),
      depth: z.number().int().min(1).max(2).optional(),
      limit: z.number().int().min(1).max(500).optional(),
    },
    stat_file: {
      root: z.enum(['backend', 'frontend', 'extra']).optional(),
      extraRoot: z.string().optional(),
      path: z.string(),
    },
    git_status: {
      root: z.enum(['backend', 'frontend', 'extra']).optional(),
      extraRoot: z.string().optional(),
    },
    git_log: {
      root: z.enum(['backend', 'frontend', 'extra']).optional(),
      extraRoot: z.string().optional(),
      limit: z.number().int().min(1).max(50).optional(),
      since: z.string().optional(),
      path: z.string().optional(),
    },
    git_diff: {
      root: z.enum(['backend', 'frontend', 'extra']).optional(),
      extraRoot: z.string().optional(),
      path: z.string().optional(),
      staged: z.boolean().optional(),
      statOnly: z.boolean().optional(),
    },
    runtime_facts: {
      pid: z.number().int().min(1).optional(),
      port: z.number().int().min(1).max(65535).optional(),
      view: z.enum(['system_properties', 'classloader', 'flags', 'command_line']).optional(),
      selectors: z.array(z.string()).optional(),
      comparePid: z.number().int().min(1).optional(),
      declaredFile: z.string().optional(),
      offset: z.number().int().min(0).max(10000).optional(),
      limit: z.number().int().min(1).max(200).optional(),
    },
    runtime_classpath: {
      pid: z.number().int().min(1).optional(),
      port: z.number().int().min(1).max(65535).optional(),
      declaredFile: z.string(),
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
    maven_dependencies: {
      root: z.literal('backend').optional(),
      scope: z.enum(['runtime', 'compile', 'test', 'provided', 'all']).optional(),
      includes: z.array(z.string()).optional(),
      excludes: z.array(z.string()).optional(),
      includeClasspath: z.boolean().optional(),
      verbose: z.boolean().optional(),
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
export function usageFromResult(resultMessage, extra = {}) {
  const modelEntries = Object.entries(resultMessage?.modelUsage ?? {}).map(([model, usage]) => ({
    model,
    provider: usage?.provider ?? null,
    canonicalModel: usage?.canonicalModel ?? null,
    costBasis: usage?.costBasis ?? null,
    inputTokens: Number(usage?.inputTokens) || 0,
    outputTokens: Number(usage?.outputTokens) || 0,
    thinkingTokens: Number(usage?.thinkingTokens) || 0,
    cacheReadInputTokens: Number(usage?.cacheReadInputTokens) || 0,
    cacheCreationInputTokens: Number(usage?.cacheCreationInputTokens) || 0,
    cacheCreationEphemeral5mInputTokens: Number(usage?.cacheCreationEphemeral5mInputTokens) || 0,
    cacheCreationEphemeral1hInputTokens: Number(usage?.cacheCreationEphemeral1hInputTokens) || 0,
    webSearchRequests: Number(usage?.webSearchRequests) || 0,
    costUSD: Number(usage?.costUSD) || 0,
    contextWindow: Number(usage?.contextWindow) || null,
    maxOutputTokens: Number(usage?.maxOutputTokens) || null,
  }));
  if (modelEntries.length === 0) {
    const usage = resultMessage?.usage ?? {};
    modelEntries.push({
      model: null,
      provider: null,
      canonicalModel: null,
      costBasis: null,
      inputTokens: Number(usage.input_tokens ?? usage.inputTokens) || 0,
      outputTokens: Number(usage.output_tokens ?? usage.outputTokens) || 0,
      thinkingTokens: Number(usage.thinking_tokens ?? usage.thinkingTokens) || 0,
      cacheReadInputTokens: Number(usage.cache_read_input_tokens ?? usage.cacheReadInputTokens) || 0,
      cacheCreationInputTokens: Number(usage.cache_creation_input_tokens ?? usage.cacheCreationInputTokens) || 0,
      cacheCreationEphemeral5mInputTokens: Number(usage.cache_creation_ephemeral_5m_input_tokens ?? usage.cacheCreationEphemeral5mInputTokens) || 0,
      cacheCreationEphemeral1hInputTokens: Number(usage.cache_creation_ephemeral_1h_input_tokens ?? usage.cacheCreationEphemeral1hInputTokens) || 0,
      webSearchRequests: Number(usage.web_search_requests ?? usage.webSearchRequests) || 0,
      costUSD: Number(usage.cost_usd ?? usage.costUSD) || 0,
      contextWindow: Number(usage.context_window ?? usage.contextWindow) || null,
      maxOutputTokens: Number(usage.max_output_tokens ?? usage.maxOutputTokens) || null,
    });
  }
  const sum = (key) => modelEntries.reduce((total, entry) => total + (Number(entry[key]) || 0), 0);
  const inputTokens = sum('inputTokens');
  const outputTokens = sum('outputTokens');
  const cacheReadInputTokens = sum('cacheReadInputTokens');
  const cacheCreationInputTokens = sum('cacheCreationInputTokens');
  const totalInputTokens = inputTokens + cacheReadInputTokens + cacheCreationInputTokens;
  const primary = modelEntries[0];
  const costBasis = modelEntries.every((entry) => entry.costBasis === primary.costBasis)
    ? primary.costBasis
    : null;
  const costEstimated = modelEntries.length > 0 && modelEntries.some((entry) => (
    (entry.costBasis && entry.costBasis !== 'list')
    || (entry.provider && entry.provider !== 'firstParty')
  ));
  const perTurn = Array.isArray(extra.turns) ? extra.turns.slice(0, 100) : null;
  return {
    numTurns: resultMessage?.num_turns ?? null,
    costUsd: resultMessage?.total_cost_usd ?? null,
    durationMs: resultMessage?.duration_ms ?? null,
    inputTokens,
    outputTokens,
    thinkingTokens: sum('thinkingTokens'),
    cacheReadInputTokens,
    cacheCreationInputTokens,
    cacheCreationEphemeral5mInputTokens: sum('cacheCreationEphemeral5mInputTokens'),
    cacheCreationEphemeral1hInputTokens: sum('cacheCreationEphemeral1hInputTokens'),
    totalInputTokens,
    totalTokens: totalInputTokens + outputTokens,
    provider: primary.provider,
    canonicalModel: primary.canonicalModel,
    costBasis,
    costEstimated,
    models: modelEntries,
    ...(perTurn ? { perTurn } : {}),
  };
}

/** Extract one assistant turn's usage for cache diagnostics. */
export function turnUsageFromMessage(message) {
  const usage = message?.message?.usage ?? message?.usage;
  if (!usage) return null;
  const number = (...values) => Number(values.find((value) => value !== undefined && value !== null)) || 0;
  const creation = usage.cache_creation ?? {};
  return {
    id: message?.message?.id ?? message?.uuid ?? null,
    model: message?.message?.model ?? message?.model ?? null,
    inputTokens: number(usage.input_tokens, usage.inputTokens),
    outputTokens: number(usage.output_tokens, usage.outputTokens),
    cacheReadInputTokens: number(usage.cache_read_input_tokens, usage.cacheReadInputTokens),
    cacheCreationInputTokens: number(usage.cache_creation_input_tokens, usage.cacheCreationInputTokens),
    cacheCreationEphemeral5mInputTokens: number(
      usage.cache_creation_ephemeral_5m_input_tokens,
      usage.cacheCreationEphemeral5mInputTokens,
      creation.ephemeral_5m_input_tokens,
    ),
    cacheCreationEphemeral1hInputTokens: number(
      usage.cache_creation_ephemeral_1h_input_tokens,
      usage.cacheCreationEphemeral1hInputTokens,
      creation.ephemeral_1h_input_tokens,
    ),
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
你拥有最高权限：可以直接修改当前工作区文件并执行 Bash 命令，不再逐次请求用户确认。请谨慎操作，避免破坏性命令。
- 修改前先读取文件和引用，尽量给出最小、可编译的改动。
- 直接修改并验证完成后，不要再把同样的修改重复写进 fixes；只有未直接修改的方案才放进 fixes。
- Bash 仅在必要时用于编译/测试或环境检查；构建/测试工具链（mvn、npm、pytest 等）会直接执行，其他命令需要用户额外确认，非交互环境会被拒绝。
- 不要访问当前工作区之外的路径，避免安装依赖、部署、推送、长时间运行或破坏性操作；用户拒绝的操作不要重复尝试。`;

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
  writeRoots = null,
  toolMode = 'readonly',
  onBeforeWrite = null,
  onAfterWrite = null,
  bashApproval = null,
  auth = null,
} = {}) {
  let scope = {
    cwd: cwd ?? process.cwd(),
    allowedRoots: [...allowedRoots],
    writeRoots: writeRoots ? [...writeRoots] : null,
    toolMode,
    onBeforeWrite,
    onAfterWrite,
    bashApproval,
    auth,
    systemPromptSuffix: '',
  };
  const configureScope = (next = {}) => {
    scope = {
      ...scope,
      ...next,
      allowedRoots: next.allowedRoots ? [...next.allowedRoots] : scope.allowedRoots,
      writeRoots: next.writeRoots ? [...next.writeRoots] : scope.writeRoots,
    };
  };

  return {
    id: 'claude',
    configureScope,
    async diagnose({ question, evidence, tools, budget, onToolUse = null }) {
      const {
        query,
        tool,
        createSdkMcpServer,
        SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
      } = await import('@anthropic-ai/claude-agent-sdk');
      const { z } = await import('zod');
      const permission = createToolPermission(scope.allowedRoots, {
        cwd: scope.cwd,
        allowWrite: scope.toolMode !== 'readonly',
        writeRoots: scope.writeRoots,
        allowBash: scope.toolMode === 'full',
        bashApproval: scope.bashApproval,
        onBeforeWrite: scope.onBeforeWrite,
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
      const dynamicSystemSuffix = `${turnLimitNote(turnLimit)}${scope.systemPromptSuffix}${modeSuffix}${validationStrategyPrompt(scope.toolMode)}`;
      const systemPrompt = buildCachedSystemPrompt(
        SYSTEM_PROMPT,
        dynamicSystemSuffix,
        SYSTEM_PROMPT_DYNAMIC_BOUNDARY ?? '__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__',
      );
      const session = query({
        prompt: buildPrompt(question, evidence),
        options: {
          tools: builtinTools,
          mcpServers: { debugcopilot: server },
          strictMcpConfig: true,
          allowedTools: toolNames,
          // Default to loading the user's Claude Code settings. A configured
          // app credential injects env and may isolate user settings instead.
          ...sdkAuthOptions(scope.auth),
          hooks: REDACT_TOOL_OUTPUT_HOOKS,
          permissionMode: 'default',
          canUseTool: permission,
          ...(additionalDirectories.length > 0 ? { additionalDirectories } : {}),
          ...(Number.isFinite(turnLimit) && turnLimit > 0 ? { maxTurns: Math.floor(turnLimit) } : {}),
          ...(maxBudgetUsd ? { maxBudgetUsd } : {}),
          systemPrompt,
          outputFormat: { type: 'json_schema', schema: RESULT_SCHEMA },
          ...(model ? { model } : {}),
          cwd: scope.cwd,
        },
      });

      let resultMessage = null;
      let partialText = '';
      const toolUses = new Map();
      const turnUsage = new Map();
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
            const snapshot = turnUsageFromMessage(message);
            if (snapshot) turnUsage.set(snapshot.id ?? `turn-${turnUsage.size + 1}`, snapshot);
            for (const block of message.message?.content ?? []) {
              if (block?.type === 'text' && block.text) partialText += block.text;
              if (block?.type === 'tool_use') {
                toolUses.set(block.id, { name: block.name, input: block.input });
                if (onToolUse) {
                  onToolUse({ stage: 'start', id: block.id, name: block.name, input: block.input });
                }
              }
            }
          }
          if (message.type === 'user') {
            for (const block of message.message?.content ?? []) {
              if (block?.type !== 'tool_result') continue;
              const used = toolUses.get(block.tool_use_id);
              if (used && !block.is_error && typeof scope.onAfterWrite === 'function'
                && (used.name === 'Edit' || used.name === 'Write')) {
                try {
                  await scope.onAfterWrite({
                    toolName: used.name,
                    input: used.input,
                    filePath: used.input?.file_path
                      ? path.resolve(scope.cwd, String(used.input.file_path))
                      : undefined,
                  });
                } catch {
                  // after-write snapshot must not break the agent loop
                }
              }
              toolUses.delete(block.tool_use_id);
              if (onToolUse) {
                onToolUse({
                  stage: 'done',
                  id: block.tool_use_id,
                  name: used?.name,
                  isError: Boolean(block.is_error),
                });
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
          rejectedHypotheses: parsed.rejectedHypotheses ?? [],
          noRejectedHypothesesReason: parsed.noRejectedHypothesesReason || `诊断未完成：${reason}`,
          fixes: normalizeFixList(parsed.fixes),
          toolCalls: tools.calls ?? [],
          usage: usageFromResult(resultMessage, { turns: [...turnUsage.values()] }),
          incomplete: true,
          incompleteReason: resultMessage.subtype ?? 'error',
          errors: Array.isArray(resultMessage.errors) ? resultMessage.errors : [],
        };
      }

      const parsed = parseStructured(resultMessage.result);
      return {
        ...parsed,
        toolCalls: tools.calls ?? [],
        usage: usageFromResult(resultMessage, { turns: [...turnUsage.values()] }),
      };
    },

    async followUp({ question, previous, tools, budget, onToolUse = null, purpose = 'followup', failure = null }) {
      const { query, SYSTEM_PROMPT_DYNAMIC_BOUNDARY } = await import('@anthropic-ai/claude-agent-sdk');
      const permission = createToolPermission(scope.allowedRoots, {
        cwd: scope.cwd,
        allowWrite: scope.toolMode !== 'readonly',
        writeRoots: scope.writeRoots,
        allowBash: scope.toolMode === 'full',
        bashApproval: scope.bashApproval,
        onBeforeWrite: scope.onBeforeWrite,
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
      const followUpBudgetUsd = Number.isFinite(budget?.maxBudgetUsd) ? budget.maxBudgetUsd : maxBudgetUsd;
      const followUpTimeoutMs = Number.isFinite(budget?.timeoutMs)
        ? Math.max(1000, budget.timeoutMs)
        : timeoutMs;
      const repairMode = purpose === 'repair';
      const staticSystemPrompt = repairMode ? REPAIR_SYSTEM_PROMPT : FOLLOWUP_SYSTEM_PROMPT;
      const dynamicSystemSuffix = `${turnLimitNote(followUpTurnLimit)}${scope.systemPromptSuffix}${modeSuffix}${validationStrategyPrompt(scope.toolMode)}`;
      const systemPrompt = buildCachedSystemPrompt(
        staticSystemPrompt,
        dynamicSystemSuffix,
        SYSTEM_PROMPT_DYNAMIC_BOUNDARY ?? '__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__',
      );
      const session = query({
        prompt: repairMode ? buildRepairPrompt(failure, previous) : buildFollowUpPrompt(question, previous),
        options: {
          tools: builtinTools,
          ...(server
            ? { mcpServers: { debugcopilot: server }, strictMcpConfig: true, allowedTools: toolNames }
            : { mcpServers: {}, strictMcpConfig: true, allowedTools: [] }),
          // Same auth precedence as the initial diagnosis.
          ...sdkAuthOptions(scope.auth),
          hooks: REDACT_TOOL_OUTPUT_HOOKS,
          permissionMode: 'default',
          canUseTool: permission,
          ...(additionalDirectories.length > 0 ? { additionalDirectories } : {}),
          ...(Number.isFinite(followUpTurnLimit) && followUpTurnLimit > 0
            ? { maxTurns: Math.floor(followUpTurnLimit) }
            : {}),
          ...(followUpBudgetUsd ? { maxBudgetUsd: followUpBudgetUsd } : {}),
          systemPrompt,
          outputFormat: { type: 'json_schema', schema: RESULT_SCHEMA },
          ...(model ? { model } : {}),
          cwd: scope.cwd,
        },
      });

      let resultMessage = null;
      let partialText = '';
      const toolUses = new Map();
      const turnUsage = new Map();
      const timer = setTimeout(() => {
        try {
          session.close();
        } catch {
          // ignore close errors on timeout
        }
      }, followUpTimeoutMs);

      try {
        for await (const message of session) {
          if (message.type === 'assistant') {
            const snapshot = turnUsageFromMessage(message);
            if (snapshot) turnUsage.set(snapshot.id ?? `turn-${turnUsage.size + 1}`, snapshot);
            for (const block of message.message?.content ?? []) {
              if (block?.type === 'text' && block.text) partialText += block.text;
              if (block?.type === 'tool_use') {
                toolUses.set(block.id, { name: block.name, input: block.input });
                if (onToolUse) {
                  onToolUse({ stage: 'start', id: block.id, name: block.name, input: block.input });
                }
              }
            }
          }
          if (message.type === 'user') {
            for (const block of message.message?.content ?? []) {
              if (block?.type !== 'tool_result') continue;
              const used = toolUses.get(block.tool_use_id);
              if (used && !block.is_error && typeof scope.onAfterWrite === 'function'
                && (used.name === 'Edit' || used.name === 'Write')) {
                try {
                  await scope.onAfterWrite({
                    toolName: used.name,
                    input: used.input,
                    filePath: used.input?.file_path
                      ? path.resolve(scope.cwd, String(used.input.file_path))
                      : undefined,
                  });
                } catch {
                  // after-write snapshot must not break the agent loop
                }
              }
              toolUses.delete(block.tool_use_id);
              if (onToolUse) {
                onToolUse({
                  stage: 'done',
                  id: block.tool_use_id,
                  name: used?.name,
                  isError: Boolean(block.is_error),
                });
              }
            }
          }
          if (message.type === 'result') resultMessage = message;
        }
      } finally {
        clearTimeout(timer);
      }

      if (!resultMessage) {
        throw new AppError('AGENT_NO_RESULT', `Agent produced no result within ${followUpTimeoutMs}ms`, {
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
          rejectedHypotheses: parsed.rejectedHypotheses ?? [],
          noRejectedHypothesesReason: parsed.noRejectedHypothesesReason || `继续诊断未完成：${reason}`,
          fixes: normalizeFixList(parsed.fixes),
          toolCalls: tools?.calls ?? [],
          usage: usageFromResult(resultMessage, { turns: [...turnUsage.values()] }),
          incomplete: true,
          incompleteReason: resultMessage.subtype ?? 'error',
          errors: Array.isArray(resultMessage.errors) ? resultMessage.errors : [],
        };
      }

      const parsed = parseStructured(resultMessage.result);
      return {
        ...parsed,
        toolCalls: tools?.calls ?? [],
        usage: usageFromResult(resultMessage, { turns: [...turnUsage.values()] }),
      };
    },
  };
}
