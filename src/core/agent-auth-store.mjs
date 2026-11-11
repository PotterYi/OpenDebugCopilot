import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { AppError } from './errors.mjs';

export const DEFAULT_AGENT_AUTH = Object.freeze({
  mode: 'user',
  baseUrl: '',
  tokenEnv: '',
  token: null,
});

const MODES = new Set(['user', 'custom', 'env']);
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function invalid(message) {
  throw new AppError('AGENT_AUTH_INVALID', message, { exitCode: 2 });
}

function secretUnavailable() {
  throw new AppError(
    'AGENT_AUTH_SECRET_UNAVAILABLE',
    '当前系统无法加密 Claude Token，请改用「环境变量」模式',
    { exitCode: 2 },
  );
}

function normalizeBaseUrl(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    invalid('Base URL 不是合法地址');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    invalid('Base URL 仅支持 http/https');
  }
  if (parsed.username || parsed.password) {
    invalid('Base URL 不能包含账号密码');
  }
  return parsed.toString().replace(/\/+$/, '');
}

function normalizeTokenEnv(value) {
  const text = String(value ?? '').trim();
  if (text && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(text)) {
    invalid('Token 环境变量名不合法');
  }
  return text;
}

function normalizeDisk(raw) {
  const source = isObject(raw) ? raw : {};
  const mode = MODES.has(source.mode) ? source.mode : DEFAULT_AGENT_AUTH.mode;
  let baseUrl = '';
  try {
    baseUrl = normalizeBaseUrl(source.baseUrl);
  } catch {
    baseUrl = '';
  }
  let tokenEnv = '';
  try {
    tokenEnv = normalizeTokenEnv(source.tokenEnv);
  } catch {
    tokenEnv = '';
  }
  const token = source.token === null || source.token === undefined
    ? null
    : (typeof source.token === 'string' || isObject(source.token) ? source.token : null);
  return { mode, baseUrl, tokenEnv, token };
}

function publicState(state) {
  return {
    mode: state.mode,
    baseUrl: state.baseUrl,
    tokenEnv: state.tokenEnv,
    hasToken: Boolean(state.token),
  };
}

/**
 * Claude credential store (`configs/agent-auth.json`).
 *
 * Tokens are encrypted with the host secret codec (Electron safeStorage).
 * The public state never includes the token itself.
 */
export function createAgentAuthStore({
  configDir = path.resolve('configs'),
  secretCodec = null,
  allowPlaintext = false,
} = {}) {
  const file = path.join(configDir, 'agent-auth.json');

  async function readRaw() {
    let text;
    try {
      text = await readFile(file, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return structuredClone(DEFAULT_AGENT_AUTH);
      throw new AppError('AGENT_AUTH_READ_FAILED', `Cannot read ${file}`, { cause: error });
    }
    try {
      return normalizeDisk(JSON.parse(text));
    } catch (error) {
      throw new AppError('AGENT_AUTH_PARSE_FAILED', `Invalid JSON in ${file}`, { cause: error });
    }
  }

  async function writeAtomic(state) {
    await mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    try {
      await chmod(tmp, 0o600);
    } catch {
      // chmod is not available on every platform; the user profile is still protected.
    }
    await rename(tmp, file);
  }

  function encryptToken(value) {
    if (secretCodec?.encrypt) {
      const data = secretCodec.encrypt(String(value));
      if (!data) secretUnavailable();
      return { scheme: secretCodec.scheme ?? 'safeStorage', data };
    }
    if (allowPlaintext) return String(value);
    secretUnavailable();
    return null;
  }

  async function save(input = {}) {
    if (!isObject(input)) invalid('auth must be an object');
    const existing = await readRaw();
    const mode = MODES.has(input.mode) ? input.mode : existing.mode;
    const baseUrl = normalizeBaseUrl(input.baseUrl !== undefined ? input.baseUrl : existing.baseUrl);
    const tokenEnv = normalizeTokenEnv(input.tokenEnv !== undefined ? input.tokenEnv : existing.tokenEnv);

    let token = existing.token;
    if (input.clearToken === true) token = null;
    if (input.token !== undefined) {
      if (input.token === null || input.token === '') {
        token = null;
      } else if (typeof input.token === 'string') {
        token = encryptToken(input.token);
      } else if (isObject(input.token)) {
        token = input.token;
      }
    }
    // Legacy plaintext on disk is migrated when a codec is available.
    if (typeof token === 'string' && token) {
      if (!allowPlaintext) token = encryptToken(token);
    }
    if (mode === 'env') token = null;

    if (mode === 'custom' && !token) invalid('自定义凭据需要填写 Token');
    if (mode === 'env' && !tokenEnv) invalid('环境变量模式需要填写 Token 环境变量名');

    const state = { mode, baseUrl, tokenEnv, token: token ?? null };
    await writeAtomic(state);
    return publicState(state);
  }

  async function getPublic() {
    return publicState(await readRaw());
  }

  async function getRuntime() {
    const state = await readRaw();
    let token = null;
    let secretError = null;
    if (state.token) {
      if (typeof state.token === 'string') {
        token = state.token;
      } else if (secretCodec?.decrypt) {
        try {
          token = secretCodec.decrypt(state.token.data);
        } catch (error) {
          secretError = `Claude Token 解密失败：${error?.message ?? error}`;
        }
      } else {
        secretError = '当前版本无法解密 Claude Token';
      }
    }
    return {
      mode: state.mode,
      baseUrl: state.baseUrl,
      tokenEnv: state.tokenEnv,
      token,
      secretError,
    };
  }

  return { file, getPublic, getRuntime, save };
}
