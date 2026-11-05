import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { AppError } from './errors.mjs';

export const DEFAULT_DATABASES = Object.freeze({ activeId: null, connections: [] });

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function invalid(message) {
  throw new AppError('DATABASE_CONFIG_INVALID', message, { exitCode: 2 });
}

function newId() {
  return `db-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function publicConnection(connection) {
  const { password: _password, ...rest } = connection;
  return {
    ...rest,
    hasPassword: Boolean(connection.password),
    passwordEnv: connection.passwordEnv ?? '',
  };
}

function normalizeConnection(input, existing, codec, { allowPlaintext = false } = {}) {
  if (!isObject(input)) invalid('database connection must be an object');
  const id = String(input.id || existing?.id || newId()).trim();
  if (!id) invalid('database connection id is required');
  const name = String(input.name ?? existing?.name ?? '').trim() || id;
  const host = String(input.host ?? existing?.host ?? '').trim();
  if (!host) invalid(`database ${id}: host is required`);
  const portNumber = Number(input.port ?? existing?.port ?? 3306);
  if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535) {
    invalid(`database ${id}: port must be between 1 and 65535`);
  }
  const connectTimeoutMs = Number(input.connectTimeoutMs ?? existing?.connectTimeoutMs ?? 3000);
  if (!Number.isFinite(connectTimeoutMs) || connectTimeoutMs < 500) {
    invalid(`database ${id}: connectTimeoutMs must be >= 500`);
  }

  const passwordEnv = String(input.passwordEnv ?? existing?.passwordEnv ?? '').trim();
  let password = existing?.password;
  if (input.password !== undefined) {
    if (input.password === null || input.password === '') {
      password = undefined;
    } else if (typeof input.password === 'string') {
      if (codec?.encrypt) {
        const data = codec.encrypt(input.password);
        if (!data) {
          throw new AppError(
            'DB_SECRET_UNAVAILABLE',
            'Password encryption is unavailable; use passwordEnv instead of a plaintext password',
            { exitCode: 2 },
          );
        }
        password = { scheme: codec.scheme ?? 'safeStorage', data };
      } else if (allowPlaintext) {
        password = input.password;
      } else {
        throw new AppError(
          'DB_SECRET_UNAVAILABLE',
          'Password encryption is unavailable; use passwordEnv instead of a plaintext password',
          { exitCode: 2 },
        );
      }
    } else if (isObject(input.password)) {
      password = input.password;
    }
  }
  // Migrate any legacy plaintext (including one inherited from disk) on save.
  if (typeof password === 'string' && password) {
    if (codec?.encrypt) {
      const data = codec.encrypt(password);
      if (data) password = { scheme: codec.scheme ?? 'safeStorage', data };
    } else if (!allowPlaintext) {
      throw new AppError(
        'DB_SECRET_UNAVAILABLE',
        'Password encryption is unavailable; use passwordEnv instead of a plaintext password',
        { exitCode: 2 },
      );
    }
  }
  if (passwordEnv) password = undefined;

  return {
    id,
    name,
    enabled: input.enabled !== false,
    allowWrite: input.allowWrite === true,
    host,
    port: portNumber,
    user: String(input.user ?? existing?.user ?? '').trim(),
    database: String(input.database ?? existing?.database ?? '').trim(),
    ssl: input.ssl ?? existing?.ssl ?? false,
    connectTimeoutMs: Math.floor(connectTimeoutMs),
    passwordEnv,
    password,
  };
}

function resolvePassword(connection, codec) {
  if (connection.passwordEnv) {
    const value = process.env[connection.passwordEnv];
    if (!value) {
      return { ...connection, password: null, secretError: `环境变量 ${connection.passwordEnv} 未设置` };
    }
    return { ...connection, password: value, secretError: null };
  }
  if (!connection.password) return { ...connection, password: null, secretError: null };
  if (typeof connection.password === 'string') {
    return { ...connection, password: connection.password, secretError: null };
  }
  if (!codec?.decrypt) {
    return { ...connection, password: null, secretError: '当前版本无法解密数据库密码' };
  }
  try {
    const password = codec.decrypt(connection.password.data);
    return { ...connection, password, secretError: null };
  } catch (error) {
    return { ...connection, password: null, secretError: `数据库密码解密失败：${error?.message ?? error}` };
  }
}

/**
 * Independent database connection store (`configs/databases.json`).
 *
 * @param {{ configDir?: string, secretCodec?: { scheme?: string, encrypt?: (value: string) => string, decrypt?: (data: string) => string } | null }} [options]
 */
export function createDatabaseStore({ configDir = path.resolve('configs'), secretCodec = null } = {}) {
  const file = path.join(configDir, 'databases.json');

  async function readRaw() {
    let text;
    try {
      text = await readFile(file, 'utf8');
    } catch (err) {
      if (err && err.code === 'ENOENT') return structuredClone(DEFAULT_DATABASES);
      throw new AppError('DATABASE_CONFIG_READ_FAILED', `Cannot read ${file}`, { cause: err });
    }
    try {
      return JSON.parse(text);
    } catch (err) {
      throw new AppError('DATABASE_CONFIG_PARSE_FAILED', `Invalid JSON in ${file}`, { cause: err });
    }
  }

  function normalizeState(raw) {
    const connections = [];
    for (const entry of Array.isArray(raw?.connections) ? raw.connections : []) {
      if (!isObject(entry)) continue;
      try {
        connections.push(normalizeConnection(entry, null, null, { allowPlaintext: true }));
      } catch {
        // A hand-edited or partially written connection must not make the
        // whole config (and therefore diagnosis) unreadable.
      }
    }
    let activeId = raw?.activeId ? String(raw.activeId) : null;
    if (!connections.some((connection) => connection.id === activeId)) activeId = null;
    return { activeId, connections };
  }

  async function writeAtomic(state) {
    await mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    try {
      await chmod(tmp, 0o600);
    } catch {
      // Windows ACLs are handled by the OS user profile.
    }
    await rename(tmp, file);
  }

  async function getPublicConfig() {
    const state = normalizeState(await readRaw());
    return {
      activeId: state.activeId,
      connections: state.connections.map(publicConnection),
    };
  }

  /** Decrypted connections for preflight/tooling. Never expose through HTTP/IPC. */
  async function getRuntimeConfig() {
    const state = normalizeState(await readRaw());
    return {
      activeId: state.activeId,
      connections: state.connections
        .filter((connection) => connection.enabled)
        .map((connection) => resolvePassword(connection, secretCodec)),
    };
  }

  async function save(input) {
    if (!isObject(input) || !Array.isArray(input.connections)) invalid('databases config must contain connections');
    const current = normalizeState(await readRaw());
    const byId = new Map(current.connections.map((connection) => [connection.id, connection]));
    const connections = input.connections.map((connection) => {
      const existing = byId.get(String(connection?.id ?? ''));
      return normalizeConnection(connection, existing, secretCodec);
    });
    const ids = new Set();
    for (const connection of connections) {
      if (ids.has(connection.id)) invalid(`duplicate database connection id: ${connection.id}`);
      ids.add(connection.id);
    }
    let activeId = input.activeId ? String(input.activeId) : current.activeId;
    if (!connections.some((connection) => connection.id === activeId)) {
      activeId = connections.find((connection) => connection.enabled)?.id ?? connections[0]?.id ?? null;
    }
    const state = { activeId, connections };
    await writeAtomic(state);
    return getPublicConfig();
  }

  async function resolveForTest(input) {
    if (!isObject(input)) invalid('database connection must be an object');
    const current = normalizeState(await readRaw());
    const existing = current.connections.find((connection) => connection.id === input.id);
    const merged = normalizeConnection(input, existing, secretCodec);
    return resolvePassword(merged, secretCodec);
  }

  return {
    file,
    getPublicConfig,
    getRuntimeConfig,
    save,
    resolveForTest,
  };
}
