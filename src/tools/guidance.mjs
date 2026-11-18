import { normalizePath } from '../core/path-policy.mjs';

export const BOUNDARY_CODES = new Set([
  'COMMAND_DENIED',
  'COMMAND_CWD_DENIED',
  'COMMAND_CWD_INVALID',
  'READ_OUT_OF_SCOPE',
  'PATH_OUT_OF_SCOPE',
  'SENSITIVE_PATH',
  'PATH_NOT_DIRECTORY',
  'PATH_NOT_FILE',
  'SOURCE_ROOT_REQUIRED',
  'FRONTEND_SOURCE_ROOT_REQUIRED',
  'EXTRA_SOURCE_ROOT_REQUIRED',
  'SOURCE_FILE_TYPE_UNSUPPORTED',
  'SOURCE_REGEX_UNSAFE',
  'SOURCE_REGEX_INVALID',
  'SOURCE_REGEX_TOO_LONG',
  'GIT_UNAVAILABLE',
  'NOT_A_GIT_REPO',
  'MAVEN_ROOT_UNSUPPORTED',
  'MAVEN_OUTPUT_MISSING',
  'MAVEN_OUTPUT_OUT_OF_SCOPE',
]);

const COMMAND_USAGE = [
  'mvn -q -DskipTests compile',
  'mvn -q -Dtest=ClassName test',
  'npm test',
  'npm run build',
  'pytest tests/unit',
  'go test ./...',
];

const FS_USAGE = [
  'list_dir({ root: "backend", path: "." })',
  'stat_file({ root: "backend", path: "pom.xml" })',
  'read_source({ target: "src/main/java/.../OrderService.java" })',
  'read_source({ target: "pom.xml" })',
  'search_source({ keyword: "server.port" })',
];

function cleanUsage(items) {
  const out = [];
  for (const item of items ?? []) {
    const text = String(item ?? '').trim();
    if (!text || text.length > 120 || /[\r\n]/.test(text)) continue;
    const normalized = normalizePath(text);
    if (/^(?:[A-Za-z]:\/|\/)/.test(normalized)) continue;
    if (!out.includes(text)) out.push(text);
    if (out.length >= 6) break;
  }
  return out;
}

function uniqueUsage(primary, fallback) {
  const out = [];
  for (const item of [...(primary ?? []), ...(fallback ?? [])]) {
    const text = String(item ?? '').trim();
    if (text && !out.includes(text)) out.push(text);
    if (out.length >= 6) break;
  }
  return out;
}

/**
 * Build structured guidance for capability-boundary errors. Returns null for
 * ordinary failures that may legitimately be retried.
 */
export function boundaryGuidance({ tool, code, details = null } = {}) {
  if (!BOUNDARY_CODES.has(code)) return null;
  const reason = details?.reason ?? null;
  const examples = cleanUsage(details?.examples);

  if (code === 'COMMAND_DENIED') {
    if (reason === 'bash-disabled') {
      return {
        hint: '当前模式不允许 Bash；改用 list_dir / stat_file / read_source / git_* 等专用工具。',
        usage: uniqueUsage([], FS_USAGE.concat('git_status({ root: "backend" })')),
        details: { reason },
      };
    }
    if (reason === 'shell-syntax') {
      return {
        hint: '一次只运行一条命令；不要使用 ; | && $() 或换行。目录/Git/进程分别用 list_dir、git_*、list_processes。',
        usage: uniqueUsage(examples, COMMAND_USAGE),
        details: { reason, examples },
      };
    }
    if (reason === 'risky') {
      return {
        hint: 'install / publish / run / dev server 等命令不允许；需要安装依赖或启动服务时写入 needsMoreInfo。',
        usage: uniqueUsage(examples, COMMAND_USAGE),
        details: { reason, examples },
      };
    }
    if (reason === 'approval') {
      return {
        hint: '该 Bash 命令未获用户确认；不要重复尝试同一命令，改用构建/测试命令或写入 needsMoreInfo。',
        usage: uniqueUsage(examples, COMMAND_USAGE),
        details: { reason, examples },
      };
    }
    return {
      hint: 'run_command 只接受构建/测试工具链；不要用 python -V、echo、print 试探。Git 用 git_*，目录/时间用 list_dir / stat_file。',
      usage: uniqueUsage(examples, COMMAND_USAGE),
      details: { reason, examples },
    };
  }

  if (code === 'COMMAND_CWD_DENIED') {
    const roots = Array.isArray(details?.roots) ? details.roots.filter(Boolean) : [];
    return {
      hint: `省略 cwd，或传沙箱源码根及其子目录${roots.length ? `（可用：${roots.join(' / ')}）` : ''}。`,
      usage: ['省略 cwd，使用默认构建目录'],
      details: { reason: 'cwd', roots },
    };
  }

  if (code === 'COMMAND_CWD_INVALID') {
    return {
      hint: 'cwd 不存在或不是目录；省略 cwd，或传沙箱源码根下已存在的子目录。',
      usage: ['省略 cwd，使用默认构建目录'],
      details: { reason: 'cwd-missing' },
    };
  }

  if (code === 'READ_OUT_OF_SCOPE') {
    return {
      hint: 'read 只读取 run/evidence 下的溢写结果；源码用 read_source，目录用 list_dir，元数据用 stat_file。',
      usage: FS_USAGE,
      details: { reason: 'read-scope' },
    };
  }

  if (code === 'PATH_OUT_OF_SCOPE' || code === 'SENSITIVE_PATH') {
    return {
      hint: '路径必须位于授权的 backend / frontend / extra 源码根内；敏感文件与 .git 内部路径不可访问。',
      usage: FS_USAGE,
      details: { reason: code === 'SENSITIVE_PATH' ? 'sensitive' : 'outside-root' },
    };
  }

  if (code === 'PATH_NOT_DIRECTORY') {
    return {
      hint: 'list_dir 只接受目录；文件元数据用 stat_file，内容用 read_source。',
      usage: ['stat_file({ root: "backend", path: "pom.xml" })', ...FS_USAGE],
      details: { reason: 'not-directory' },
    };
  }

  if (code === 'PATH_NOT_FILE') {
    return {
      hint: '完整 git_diff 只接受单个文件路径；目录级变更请先用 statOnly=true 查看文件列表。',
      usage: ['git_diff({ root: "backend", statOnly: true })', 'git_diff({ root: "backend", path: "src/.../File.java", statOnly: false })'],
      details: { reason: 'not-file' },
    };
  }

  if (code === 'EXTRA_SOURCE_ROOT_REQUIRED') {
    return {
      hint: '额外后端源码根未授权；本次先用 root=backend，需要额外根时请用户在诊断时勾选授权。',
      usage: ['read_source({ root: "backend", target: "..." })', 'list_dir({ root: "backend", path: "." })'],
      details: { reason: 'extra-root' },
    };
  }

  if (code === 'FRONTEND_SOURCE_ROOT_REQUIRED') {
    return {
      hint: '前端源码根未配置；本次先用 root=backend，或提示用户配置 frontendProjectRoot。',
      usage: ['read_source({ root: "backend", target: "..." })', 'list_dir({ root: "backend", path: "." })'],
      details: { reason: 'frontend-root' },
    };
  }

  if (code === 'SOURCE_ROOT_REQUIRED') {
    return {
      hint: '后端源码根未配置；请提示用户在工作区配置 sourceRoot，或改用 list_processes/runtime_classpath 继续。',
      usage: ['list_processes({ javaOnly: true })', 'runtime_classpath({ pid: 1234, declaredFile: "target/classpath.txt" })'],
      details: { reason: 'source-root' },
    };
  }

  if (code === 'SOURCE_FILE_TYPE_UNSUPPORTED') {
    return {
      hint: 'read_source 直接路径只接受源码或配置类型；配置文件可用 pom.xml / application-*.yml / .properties / .json / .gradle 等，其他类型用 list_dir/stat_file 查看元数据。',
      usage: FS_USAGE,
      details: { reason: 'file-type' },
    };
  }

  if (code === 'SOURCE_REGEX_UNSAFE' || code === 'SOURCE_REGEX_INVALID' || code === 'SOURCE_REGEX_TOO_LONG') {
    return {
      hint: '正则被拒绝；改用字面关键词，或简化正则（≤200 字符，禁用反向引用、后顾和嵌套量词）。不要把同一模式反复提交。',
      usage: ['search_source({ keyword: "server.port" })', 'search_source({ keyword: "Exception", regex: true })'],
      details: { reason: code === 'SOURCE_REGEX_UNSAFE' ? 'unsafe-regex' : code === 'SOURCE_REGEX_TOO_LONG' ? 'too-long' : 'invalid-regex' },
    };
  }

  if (code === 'GIT_UNAVAILABLE' || code === 'NOT_A_GIT_REPO') {
    return {
      hint: '无法读取 Git 信息；改用 list_dir、stat_file、read_source 继续排查，不要重复调用 git_*。',
      usage: FS_USAGE,
      details: { reason: code === 'GIT_UNAVAILABLE' ? 'git-unavailable' : 'not-a-repo' },
    };
  }

  if (code === 'MAVEN_ROOT_UNSUPPORTED') {
    return {
      hint: 'maven_dependencies 当前只支持 backend 根；不要对 frontend/extra 重复调用。',
      usage: ['maven_dependencies({ root: "backend", includeClasspath: true })', 'list_dir({ root: "frontend", path: "." })'],
      details: { reason: 'maven-root' },
    };
  }

  if (code === 'MAVEN_OUTPUT_MISSING' || code === 'MAVEN_OUTPUT_OUT_OF_SCOPE') {
    return {
      hint: 'Maven 输出文件不可用；先确认 backend 根下有 pom.xml，再重试一次 maven_dependencies，不要反复执行 dependency:tree。',
      usage: ['maven_dependencies({ root: "backend", includeClasspath: true })'],
      details: { reason: 'maven-output' },
    };
  }

  return null;
}

/** Track repeated boundary errors per tool + code within one diagnosis run. */
export function createDenialTracker() {
  const counts = new Map();
  return {
    recordSuccess(tool) {
      const prefix = `${tool}\0`;
      for (const key of [...counts.keys()]) {
        if (key.startsWith(prefix)) counts.delete(key);
      }
    },
    recordFailure({ tool, code } = {}) {
      if (!BOUNDARY_CODES.has(code)) return null;
      const key = `${tool}\0${code}`;
      const repeated = (counts.get(key) ?? 0) + 1;
      counts.set(key, repeated);
      return { repeated, code };
    },
  };
}
