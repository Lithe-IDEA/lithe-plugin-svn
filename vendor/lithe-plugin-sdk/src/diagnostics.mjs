// Typed plugin diagnostics use the host's catalog and writer. No payload text crosses this API.
import { PluginSdkError } from './errors.mjs';

export const KNOWN_OPERATIONS = new Set([
  'initialize', 'shutdown', 'notification', 'function-call', 'result-encoding',
  ...['model', 'dependencies', 'execute', 'test', 'discoverTests', 'prepareRun', 'prepareDebug'].map((name) => `lithe/build/${name}`),
  ...['status', 'baseContent', 'history', 'fileHistory', 'annotate', 'checkin', 'rollback', 'update', 'fileOperation', 'resolve', 'cleanup'].map((name) => `lithe/vcs/${name}`),
]);
const token = (value, maximum) => typeof value === 'string' && value.length > 0 && value.length <= maximum && /^[A-Za-z0-9._:/\-$]+$/.test(value);
export function requestOperationId(operationId, requestId) {
  if (token(operationId, 128)) return operationId;
  const fallback = typeof requestId === 'string' ? requestId : Number.isSafeInteger(requestId) ? String(requestId) : undefined;
  return token(fallback, 128) ? fallback : undefined;
}
export function diagnostics(send, registered, operationId) {
  const record = (kind, operation, code, count, durationMs) => {
    if (!KNOWN_OPERATIONS.has(operation) && !registered(operation)) throw new PluginSdkError('sdk.logging.invalidOperation', 'Diagnostics need a registered operation.');
    if (code !== undefined && !token(code, 64)) throw new PluginSdkError('sdk.logging.invalidCode', 'Diagnostics need a controlled code.');
    if (count !== undefined && (!Number.isSafeInteger(count) || count < 0)) throw new PluginSdkError('sdk.logging.invalidCount', 'Diagnostics need a nonnegative safe count.');
    const params = { kind, operation: operation.length <= 64 ? operation : 'function-call' };
    if (code !== undefined) params.code = code;
    if (count !== undefined) params.count = count;
    if (durationMs !== undefined) params.durationMs = Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.floor(durationMs)));
    if (token(operationId, 128)) params.operationId = operationId;
    send(params);
  };
  return Object.freeze({
    degraded: (operation, code, count) => record('degraded', operation, code, count),
    recovered: (operation, code, count) => record('recovered', operation, code, count),
    terminal: (operation, error, durationMs = 0) => record(error ? 'operationFailed' : 'operationFinished', operation,
      error ? (token(error.code, 64) ? error.code : 'internal_error') : undefined, undefined, durationMs),
  });
}
