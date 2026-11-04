import { boundedText, ERROR_CODES, HOST_ERRORS, isPluginErrorCode } from './protocol.mjs';

/**
 * A failure a handler reports on purpose. Core ends the call with the stable
 * `plugin.function.failed` code and forwards `code` as `pluginErrorCode`, so
 * the plugin's own UI can tell its failures apart. Lithe never branches on it.
 */
export class PluginError extends Error {
  /**
   * @param {string} code Identifier of at most 64 bytes, such as `maven.snapshotLocked`.
   * @param {string} message User-facing text; Core keeps the first 1024 bytes.
   * @param {object} [options] `{ cause }`, retained in memory and omitted from automatic diagnostics.
   */
  constructor(code, message, options) {
    super(message, options);
    if (!isPluginErrorCode(code)) {
      throw new TypeError(
        `Plugin error code ${JSON.stringify(code)} must start with a letter, use letters, digits, ".", "_" or "-", and be at most 64 bytes.`,
      );
    }
    this.name = 'PluginError';
    this.code = code;
  }
}

/** An SDK usage error, raised synchronously to the plugin author. */
export class PluginSdkError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PluginSdkError';
    this.code = code;
  }
}

const HOST_CODES = new Map(Object.entries(HOST_ERRORS).map(([code, rpcCode]) => [rpcCode, code]));

/**
 * The host refused or failed a request this backend sent. `code` is the
 * stable `error.data.code`, such as `plugin.host.contextExpired`; `rpcCode`
 * the JSON-RPC number; `details` the object a version 3 host may add, such
 * as `{ option }` or `{ retryAfterMilliseconds }`.
 */
export class HostError extends PluginSdkError {
  constructor(code, message, { rpcCode, details, method } = {}) {
    super(code, message);
    this.name = 'HostError';
    this.rpcCode = rpcCode;
    this.details = details;
    this.method = method;
  }

  /**
   * The failure for a JSON-RPC error answer. A host method without a known
   * code is a host failure: from version 3 a number names one code, and an
   * unknown number is `plugin.host.failed`.
   */
  static fromResponse(method, error) {
    const data = error?.data;
    const isHost = method.startsWith('lithe/host/');
    const code = typeof data?.code === 'string'
      ? data.code
      : isHost
        ? HOST_CODES.get(error?.code) ?? 'plugin.host.failed'
        : 'sdk.host.error';
    const details = data?.details !== null && typeof data?.details === 'object' && !Array.isArray(data.details)
      ? data.details
      : undefined;
    return new HostError(code, typeof error?.message === 'string' ? error.message : `${method} failed.`, {
      rpcCode: error?.code,
      details,
      method,
    });
  }
}

/** True for the rejection an aborted `AbortSignal` produces. */
export function isAbort(error, signal) {
  return Boolean(signal?.aborted) && (error === signal.reason || error?.name === 'AbortError');
}

/**
 * The JSON-RPC error object for a handler failure. Only `PluginError` carries
 * a plugin code; any other exception becomes a generic internal error so that
 * stack traces and machine paths never reach the host's UI. A `PluginError`
 * message is shown to the user as written, so it must not contain them either.
 */
export function toResponseError(error, signal) {
  if (isAbort(error, signal)) {
    return { code: ERROR_CODES.requestCancelled, message: 'The request was cancelled.' };
  }
  if (error instanceof PluginError) {
    return {
      code: ERROR_CODES.requestFailed,
      message: boundedText(error.message),
      data: { code: error.code },
    };
  }
  // Unexpected exceptions often embed absolute paths (ENOENT) or internals;
  // the caller logs only a fixed failure category to stderr.
  return { code: ERROR_CODES.internalError, message: 'The plugin backend failed unexpectedly.' };
}
