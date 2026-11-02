/**
 * Unified error model. Every failure carries a stable code and an exit code
 * so the CLI can behave predictably and tests can assert on codes.
 */

export class AppError extends Error {
  /**
   * @param {string} code stable machine-readable code
   * @param {string} message human-readable message
   * @param {{ exitCode?: number, details?: unknown, cause?: unknown }} [options]
   */
  constructor(code, message, { exitCode = 1, details, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'AppError';
    this.code = code;
    this.exitCode = exitCode;
    this.details = details;
  }
}

/** Invalid CLI usage: exit 2. */
export class UsageError extends AppError {
  constructor(message, details) {
    super('USAGE', message, { exitCode: 2, details });
    this.name = 'UsageError';
  }
}

/** Invalid scenario or preflight failure: exit 3. */
export class ScenarioError extends AppError {
  constructor(code, message, details) {
    super(code, message, { exitCode: 3, details });
    this.name = 'ScenarioError';
  }
}

/** Feature not implemented yet (planned milestone): exit 4. */
export class NotImplementedError extends AppError {
  constructor(code, message, details) {
    super(code, message, { exitCode: 4, details });
    this.name = 'NotImplementedError';
  }
}

/**
 * @param {unknown} err
 * @returns {{ code: string, message: string, exitCode: number, details?: unknown }}
 */
export function toErrorPayload(err) {
  if (err instanceof AppError) {
    return {
      code: err.code,
      message: err.message,
      exitCode: err.exitCode,
      ...(err.details === undefined ? {} : { details: err.details }),
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { code: 'INTERNAL', message, exitCode: 1 };
}
