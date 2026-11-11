import { AppError } from './errors.mjs';

/**
 * Turn the stored credential into SDK options.
 *
 * - user:   keep loading ~/.claude/settings.json (current behavior)
 * - custom: inject ANTHROPIC_AUTH_TOKEN (and optional base URL); user settings
 *           are isolated so a stale token there cannot win
 * - env:    resolve the token from a process environment variable
 */
export function resolveAgentAuth(auth = {}, env = process.env) {
  const source = auth && typeof auth === 'object' ? auth : {};
  if (source.secretError) {
    throw new AppError('AGENT_AUTH_SECRET_ERROR', source.secretError, { exitCode: 2 });
  }
  const mode = ['user', 'custom', 'env'].includes(source.mode) ? source.mode : 'user';
  const baseUrl = String(source.baseUrl ?? '').trim();

  if (mode === 'user') {
    return { mode, env: {}, settingSources: ['user'] };
  }

  if (mode === 'env') {
    const name = String(source.tokenEnv ?? '').trim();
    if (!name) {
      throw new AppError('AGENT_AUTH_ENV_REQUIRED', '环境变量模式需要填写 Token 环境变量名', { exitCode: 2 });
    }
    const token = String(env?.[name] ?? '').trim();
    if (!token) {
      throw new AppError('AGENT_AUTH_ENV_MISSING', `环境变量 ${name} 未设置`, { exitCode: 2 });
    }
    return {
      mode,
      env: {
        ANTHROPIC_AUTH_TOKEN: token,
        ...(baseUrl ? { ANTHROPIC_BASE_URL: baseUrl } : {}),
      },
      settingSources: [],
    };
  }

  const token = String(source.token ?? '').trim();
  if (!token) {
    throw new AppError('AGENT_AUTH_TOKEN_REQUIRED', '自定义凭据需要填写 Token', { exitCode: 2 });
  }
  return {
    mode,
    env: {
      ANTHROPIC_AUTH_TOKEN: token,
      ...(baseUrl ? { ANTHROPIC_BASE_URL: baseUrl } : {}),
    },
    settingSources: [],
  };
}
