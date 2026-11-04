// Wire constants and validation shared with Lithe's Rust Core
// (rust/lithe-core/src/lsp/interface/plugin_function.rs and
// rust/lithe-core/src/vcs/ in the Lithe repository). The SDK checks the
// same rules locally so a plugin author sees a mistake when registering a
// handler instead of as a refused session at runtime.

/** Protocol versions this SDK can answer: the highest of each. */
export const FUNCTIONS_VERSION = 3;
export const BUILD_VERSION = 6;
export const VCS_VERSION = 1;

/** First plugin-function version with host services (credentials). */
export const HOST_SERVICES_VERSION = 2;
/** First plugin-function version with workspace contexts, discovery, and host notifications. */
export const CONTEXT_VERSION = 3;

export const METHODS = Object.freeze({
  initialize: 'initialize',
  initialized: 'initialized',
  shutdown: 'shutdown',
  exit: 'exit',
  cancelRequest: '$/cancelRequest',
  functionInvoke: 'lithe/function/invoke',
  functionRegister: 'lithe/function/register',
  functionUnregister: 'lithe/function/unregister',
  functionProgress: 'lithe/function/progress',
  buildModel: 'lithe/build/model',
  buildDependencies: 'lithe/build/dependencies',
  buildExecute: 'lithe/build/execute',
  buildTest: 'lithe/build/test',
  buildDiscoverTests: 'lithe/build/discoverTests',
  buildPrepareRun: 'lithe/build/prepareRun',
  buildPrepareDebug: 'lithe/build/prepareDebug',
  buildProgress: 'lithe/build/progress',
  vcsExecution: 'lithe/vcs/execution',
});

/**
 * Backend-to-host requests of plugin-function protocols 2 and 3. From
 * version 3 the host adds methods without a new version; `host.request`
 * sends any `lithe/host/*` method, and `getCapabilities` says which ones
 * this session may call.
 */
export const HOST_METHODS = Object.freeze({
  credentialsGet: 'lithe/host/credentials/get',
  credentialsSet: 'lithe/host/credentials/set',
  credentialsDelete: 'lithe/host/credentials/delete',
  getCapabilities: 'lithe/host/getCapabilities',
  subscriptionsDispose: 'lithe/host/subscriptions/dispose',
  workspaceListContexts: 'lithe/host/workspace/listContexts',
  workspaceGetContext: 'lithe/host/workspace/getContext',
  workspaceGetFolders: 'lithe/host/workspace/getFolders',
  workspaceReadDirectory: 'lithe/host/workspace/readDirectory',
  workspaceStat: 'lithe/host/workspace/stat',
  workspaceReadFile: 'lithe/host/workspace/readFile',
  workspaceWatch: 'lithe/host/workspace/watch',
  workspaceFindFiles: 'lithe/host/workspace/findFiles',
  workspaceFindText: 'lithe/host/workspace/findText',
  documentsList: 'lithe/host/documents/list',
  documentsGetSnapshot: 'lithe/host/documents/getSnapshot',
  editorRegisterActions: 'lithe/host/editor/registerActions',
  editorGetActive: 'lithe/host/editor/getActive',
  editorGetSelections: 'lithe/host/editor/getSelections',
  editorApplyEdits: 'lithe/host/editor/applyEdits',
  editorReplaceSelections: 'lithe/host/editor/replaceSelections',
  editorInsertText: 'lithe/host/editor/insertText',
  editorOpen: 'lithe/host/editor/open',
  editorReveal: 'lithe/host/editor/reveal',
  previewOpenHTML: 'lithe/host/preview/openHTML',
  browserOpenExternal: 'lithe/host/browser/openExternal',
  windowShowInformation: 'lithe/host/window/showInformation',
  windowShowWarning: 'lithe/host/window/showWarning',
  windowShowError: 'lithe/host/window/showError',
  terminalCreate: 'lithe/host/terminal/create',
  terminalShow: 'lithe/host/terminal/show',
  terminalClose: 'lithe/host/terminal/close',
  terminalReopen: 'lithe/host/terminal/reopen',
  terminalDispose: 'lithe/host/terminal/dispose',
  terminalOnExit: 'lithe/host/terminal/onExit',
});

/** Host-to-backend notifications of protocol 3. */
export const HOST_NOTIFICATIONS = Object.freeze({
  didChangeContexts: 'lithe/host/workspace/didChangeContexts',
  subscriptionNotify: 'lithe/host/subscriptions/notify',
  commandDidRun: 'lithe/host/commands/didRun',
});

/**
 * Host failure codes (`error.data.code`) and the JSON-RPC number Core sends
 * with each to a version 3 backend. A number never changes meaning; a later
 * host adds codes after `-32021`.
 */
export const HOST_ERRORS = Object.freeze({
  'plugin.host.unavailable': -32601,
  'plugin.host.invalidParams': -32602,
  'plugin.host.failed': -32603,
  'plugin.host.cancelled': -32800,
  'plugin.host.permissionDenied': -32010,
  'plugin.host.contextExpired': -32011,
  'plugin.host.authorityUnsupported': -32012,
  'plugin.host.versionConflict': -32013,
  'plugin.host.limitExceeded': -32014,
  'plugin.host.timeout': -32015,
  'plugin.host.notFound': -32016,
  'plugin.host.readOnly': -32017,
  'plugin.host.unsupportedOption': -32018,
  'plugin.host.preconditionFailed': -32019,
  'plugin.host.busy': -32020,
  'plugin.host.rateLimited': -32021,
});

/** Minimum negotiated version of each typed build operation. */
export const BUILD_METHOD_VERSIONS = Object.freeze({
  [METHODS.buildModel]: 1,
  [METHODS.buildDependencies]: 1,
  [METHODS.buildExecute]: 2,
  [METHODS.buildTest]: 3,
  [METHODS.buildDiscoverTests]: 3,
  [METHODS.buildPrepareRun]: 4,
  [METHODS.buildPrepareDebug]: 5,
});

/**
 * VCS-provider operations: the handler name a plugin declares, the request
 * Core sends for it, and the capability declaring the handler negotiates.
 * Contract: shared/contracts/vcs-provider-v1.md.
 */
export const VCS_OPERATIONS = Object.freeze({
  status: Object.freeze({ method: 'lithe/vcs/status', capability: 'status' }),
  baseContent: Object.freeze({ method: 'lithe/vcs/baseContent', capability: 'baseContent' }),
  history: Object.freeze({ method: 'lithe/vcs/history', capability: 'history' }),
  fileHistory: Object.freeze({ method: 'lithe/vcs/fileHistory', capability: 'fileHistory' }),
  annotate: Object.freeze({ method: 'lithe/vcs/annotate', capability: 'annotate' }),
  checkin: Object.freeze({ method: 'lithe/vcs/checkin', capability: 'checkin' }),
  rollback: Object.freeze({ method: 'lithe/vcs/rollback', capability: 'rollback' }),
  update: Object.freeze({ method: 'lithe/vcs/update', capability: 'update' }),
  fileOperation: Object.freeze({ method: 'lithe/vcs/fileOperation', capability: 'fileOperations' }),
  resolve: Object.freeze({ method: 'lithe/vcs/resolve', capability: 'conflicts' }),
  cleanup: Object.freeze({ method: 'lithe/vcs/cleanup', capability: 'cleanup' }),
});

/** Handlers every VCS provider must declare; Core refuses a provider without them. */
export const VCS_REQUIRED_OPERATIONS = Object.freeze(['status', 'baseContent', 'checkin', 'rollback']);

/**
 * The provider error codes Core passes on (`error.data.code`). Throw a
 * `PluginError` with one of them; any other code reaches the host as
 * `vcs.provider.failed`.
 */
export const VCS_ERRORS = Object.freeze({
  authenticationFailed: 'vcs.authentication.failed',
  conflict: 'vcs.conflict',
  outOfDate: 'vcs.outOfDate',
  toolUnavailable: 'vcs.tool.unavailable',
  workingCopyLocked: 'vcs.workingCopy.locked',
  workingCopyUnsupported: 'vcs.workingCopy.unsupported',
});

/** JSON-RPC and LSP error codes the SDK answers with. */
export const ERROR_CODES = Object.freeze({
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
  serverNotInitialized: -32002,
  requestFailed: -32000,
  requestCancelled: -32800,
});

export const LIMITS = Object.freeze({
  maxFunctions: 256,
  maxFunctionIdBytes: 128,
  maxPluginErrorCodeBytes: 64,
  maxMessageBytes: 1024,
  maxResultBytes: 1 << 20,
  maxBuildResultBytes: 32 * 1024 * 1024,
  maxBuildMessageBytes: 4096,
  maxBuildOutputBytes: 65536,
  maxVcsIdBytes: 32,
  maxExecutionErrorOutputBytes: 16 * 1024,
  maxCredentialKeyBytes: 128,
  maxCredentialSecretBytes: 16 * 1024,
  maxPendingHostRequests: 16,
});

/** Dot-separated lowerCamelCase segments, for example `snapshot.refresh`. */
export function isFunctionId(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    Buffer.byteLength(value) <= LIMITS.maxFunctionIdBytes &&
    value.split('.').every((segment) => /^[a-z][A-Za-z0-9]*$/.test(segment))
  );
}

/** A VCS ID: lowercase ASCII letters, digits, and `-`, starting with a letter, such as `svn`. */
export function isVcsId(value) {
  return typeof value === 'string' && value.length <= LIMITS.maxVcsIdBytes && /^[a-z][a-z0-9-]*$/.test(value);
}

/**
 * The key alphabet of protocols 2 and 3: 1-128 ASCII letters, digits, `.`,
 * `_`, `:`, or `-`. Credential keys, context IDs, and subscription IDs use it.
 */
export function isCredentialKey(value) {
  return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(value);
}

/** `{ contextID, generation }`, exactly, naming one generation of one workspace context. */
export function isContextReference(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === 2 &&
    isCredentialKey(value.contextID) &&
    Number.isSafeInteger(value.generation) &&
    value.generation >= 1
  );
}

/** The plugin error code alphabet Core forwards as `pluginErrorCode`. */
export function isPluginErrorCode(value) {
  return (
    typeof value === 'string' &&
    Buffer.byteLength(value) <= LIMITS.maxPluginErrorCodeBytes &&
    /^[A-Za-z][A-Za-z0-9._-]*$/.test(value)
  );
}

/** Cuts `value` to `limit` UTF-8 bytes without splitting a character. */
export function boundedText(value, limit = LIMITS.maxMessageBytes) {
  const text = String(value ?? '');
  if (Buffer.byteLength(text) <= limit) return text;
  let used = 0;
  let end = 0;
  for (const character of text) {
    const size = Buffer.byteLength(character);
    if (used + size > limit) break;
    used += size;
    end += character.length;
  }
  return text.slice(0, end);
}

/**
 * Methods reserved for the SDK. A plugin cannot install its own handler for
 * these, or send them to the host: the lifecycle belongs to the host's
 * session management, and `lithe/*` belongs to Lithe's typed contracts.
 */
export function isReservedMethod(method) {
  return (
    method === METHODS.initialize ||
    method === METHODS.initialized ||
    method === METHODS.shutdown ||
    method === METHODS.exit ||
    method === METHODS.cancelRequest ||
    method.startsWith('lithe/')
  );
}
