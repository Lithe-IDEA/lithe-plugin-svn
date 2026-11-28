// Wire constants and validation shared with Lithe's Rust Core
// (rust/crates/plugin-rpc/src/ and
// rust/crates/vcs/ in the Lithe repository). The SDK checks the
// same rules locally so a plugin author sees a mistake when registering a
// handler instead of as a refused session at runtime.

/** The protocol versions this SDK speaks. */
export const FUNCTIONS_VERSION = 0;
/** The newest build protocol version (buildProviders 1 adds lithe/build/runEntrypoints); every earlier one is spoken too. */
export const BUILD_VERSION = 1;
export const VCS_VERSION = 0;
export const LOGGING_VERSION = 0;
export const KEYMAP_IMPORT_VERSION = 0;

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
  buildRunEntrypoints: 'lithe/build/runEntrypoints',
  buildPrepareRun: 'lithe/build/prepareRun',
  buildPrepareDebug: 'lithe/build/prepareDebug',
  buildProgress: 'lithe/build/progress',
  vcsExecution: 'lithe/vcs/execution',
});

/**
 * Backend-to-host requests of the plugin-function protocol. The host adds
 * methods without a new version; `host.request` sends any `lithe/host/*`
 * method, and `getCapabilities` says which ones this session may call.
 */
export const HOST_METHODS = Object.freeze({
  windowShowQuickPick: 'lithe/host/window/showQuickPick',
  windowShowInputBox: 'lithe/host/window/showInputBox',
  previewOpenMarkdown: 'lithe/host/preview/openMarkdown',
  editorShowDiff: 'lithe/host/editor/showDiff',
  viewsRefresh: 'lithe/host/views/refresh',
  outputCreate: 'lithe/host/output/create',
  outputAppend: 'lithe/host/output/append',
  outputClear: 'lithe/host/output/clear',
  outputShow: 'lithe/host/output/show',
  outputDispose: 'lithe/host/output/dispose',
  progressCreate: 'lithe/host/progress/create',
  progressReport: 'lithe/host/progress/report',
  progressEnd: 'lithe/host/progress/end',
  statusBarSetItem: 'lithe/host/statusBar/setItem',
  statusBarRemoveItem: 'lithe/host/statusBar/removeItem',
  clipboardReadText: 'lithe/host/clipboard/readText',
  clipboardWriteText: 'lithe/host/clipboard/writeText',
  workspaceReveal: 'lithe/host/workspace/reveal',
  workspaceSetDirectoryTypes: 'lithe/host/workspace/setDirectoryTypes',
  workspaceSetDirectoryMarks: 'lithe/host/workspace/setDirectoryMarks',
  networkRequest: 'lithe/host/network/request',

  credentialsGet: 'lithe/host/credentials/get',
  credentialsSet: 'lithe/host/credentials/set',
  credentialsDelete: 'lithe/host/credentials/delete',
  getCapabilities: 'lithe/host/getCapabilities',
  subscriptionsDispose: 'lithe/host/subscriptions/dispose',
  workspaceListContexts: 'lithe/host/workspace/listContexts',
  workspaceGetContext: 'lithe/host/workspace/getContext',
  workspaceGetFolders: 'lithe/host/workspace/getFolders',
  workspaceGetHostPaths: 'lithe/host/workspace/getHostPaths',
  workspaceReadDirectory: 'lithe/host/workspace/readDirectory',
  workspaceStat: 'lithe/host/workspace/stat',
  workspaceReadFile: 'lithe/host/workspace/readFile',
  workspaceWatch: 'lithe/host/workspace/watch',
  workspaceFindFiles: 'lithe/host/workspace/findFiles',
  workspaceFindText: 'lithe/host/workspace/findText',
  workspaceCreate: 'lithe/host/workspace/create',
  workspaceRename: 'lithe/host/workspace/rename',
  workspaceCopy: 'lithe/host/workspace/copy',
  workspaceTrash: 'lithe/host/workspace/trash',
  documentsList: 'lithe/host/documents/list',
  documentsGetSnapshot: 'lithe/host/documents/getSnapshot',
  documentsSave: 'lithe/host/documents/save',
  documentsSaveAs: 'lithe/host/documents/saveAs',
  documentsClose: 'lithe/host/documents/close',
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
  functionsProviders: 'lithe/host/functions/providers',
  functionsInvoke: 'lithe/host/functions/invoke',
  agentsWrite: 'lithe/host/agents/write',
  agentsReport: 'lithe/host/agents/report',
  agentsUsage: 'lithe/host/agents/usage',
});

/** Host-to-backend notifications. */
export const HOST_NOTIFICATIONS = Object.freeze({
  didChangeContexts: 'lithe/host/workspace/didChangeContexts',
  subscriptionNotify: 'lithe/host/subscriptions/notify',
  commandDidRun: 'lithe/host/commands/didRun',
});

/** Native agent session notifications (plan API-45); see `onAgentSessions`. */
export const AGENT_NOTIFICATIONS = Object.freeze({
  didStart: 'lithe/host/agents/didStart',
  didOutput: 'lithe/host/agents/didOutput',
  didPrompt: 'lithe/host/agents/didPrompt',
  didCancel: 'lithe/host/agents/didCancel',
  didDecidePermission: 'lithe/host/agents/didDecidePermission',
  didExit: 'lithe/host/agents/didExit',
});

/**
 * Host failure codes (`error.data.code`) and the JSON-RPC number Core sends
 * with each to a backend. A number never changes meaning; a later host adds
 * codes after the last one listed here. The `plugin.function.*` codes are the
 * relay's own.
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
  'plugin.host.languageServerUnavailable': -32022,
  'plugin.host.languageServerError': -32023,
  'plugin.host.methodNotDeclared': -32024,
  'plugin.host.toolUnresolved': -32025,
  'plugin.host.foreignContribution': -32026,
  'plugin.function.notDeclared': -32027,
  'plugin.function.notExported': -32028,
  'plugin.function.providerDisabled': -32029,
  'plugin.function.versionMismatch': -32030,
  'plugin.function.callCycle': -32065,
  'plugin.function.depthExceeded': -32066,
  'plugin.function.tooManyCalls': -32067,
  'plugin.function.payloadTooLarge': -32068,
  'plugin.function.providerUnavailable': -32069,
  'plugin.function.failed': -32070,
  'plugin.function.invalidResult': -32071,
  'plugin.host.remoteDisconnected': -32078,
  'plugin.host.platformUnavailable': -32079,
  'plugin.host.alreadyExists': -32080,
  'plugin.host.diskChanged': -32081,
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
  maxHostPathRoots: 256,
  // The relay's bounds are Core's to enforce; the SDK only names them.
  relayDefaultTimeoutMilliseconds: 60000,
  relayMaxTimeoutMilliseconds: 600000,
  maxParentOperationIdBytes: 128,
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
 * The key alphabet of host services: 1-128 ASCII letters, digits, `.`, `_`,
 * `:`, or `-`. Credential keys, context IDs, and subscription IDs use it.
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
