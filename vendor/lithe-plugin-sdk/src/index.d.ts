// Type declarations for the Lithe plugin backend SDK. Keep in sync with the
// `.mjs` sources; `sdk/node/test/support.test.mjs` checks the exported names.

/** Any value JSON can carry. */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export interface RunProcessOptions {
  cwd?: string;
  /** Replaces the environment when given; Lithe's process markers are carried over regardless. */
  env?: Record<string, string>;
  /** Aborting it ends the whole process tree and rejects with its reason. */
  signal?: AbortSignal;
  /** Captured bytes per stream; default 1 MiB. */
  maxOutputBytes?: number;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
  /** Delay between the polite and forced stop; default 2000. */
  killGraceMilliseconds?: number;
}

export interface ProcessResult {
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
}

/** Typed facts for the host-owned litheLogging 1 event catalog. */
export interface Diagnostics {
  degraded(operation: string, code: string, count?: number): void;
  recovered(operation: string, code: string, count?: number): void;
}

/** Shared by every handler. */
export interface RequestContext {
  /** Aborted when the host cancels the call, the call times out, the session ends, or the call has settled. */
  signal: AbortSignal;
  throwIfCancelled(): void;
  /** `runProcess` bound to this call: its tree ends when the call is cancelled or settles. */
  run(command: string, args?: string[], options?: RunProcessOptions): Promise<ProcessResult>;
  /** Fixed facts, correlated with the host operation; never accepts payload text. */
  readonly diagnostics: Diagnostics;
  /** Omits only this call's successful fact; failures remain visible. */
  suppressSuccessDiagnostics(): void;
  /** `backend.host` bound to this call: its unanswered host requests are cancelled when the call ends. */
  host: Host;
}

/** `{ contextID, generation }`: one generation of one workspace context (protocol 3). */
export interface ContextReference {
  contextID: string;
  generation: number;
}

export interface WorkspaceFolder {
  /** Stable per plugin and location; reveals nothing about the path. */
  rootID: string;
  name: string;
  /** Present only for a local authority. */
  path?: string;
}

/** One open workspace in one window. */
export interface WorkspaceContext extends ContextReference {
  name: string;
  authority: { kind: 'local' | 'remote'; id?: string };
  folders: WorkspaceFolder[];
  /** Private to the plugin and the workspace; only `getContext` returns, and creates, it. */
  stateDirectory?: string;
  [key: string]: unknown;
}

export interface HostCapabilities {
  protocolVersion: number;
  backendAuthority: 'local';
  /** Each service this session may use, with the requests it may send and the notifications it may receive. */
  services: Record<string, { methods: string[]; notifications: string[] }>;
  limits: {
    pendingHostRequests: number;
    functionResultBytes: number;
    hostRequestBytes: number;
    hostResultBytes: number;
    errorMessageBytes: number;
    errorDetailsBytes: number;
    notificationBytes: number;
    [key: string]: number;
  };
  [key: string]: unknown;
}

export interface HostRequestOptions {
  /** Aborting it rejects with its reason; from protocol 3 the host is also told to stop. Never retried. */
  signal?: AbortSignal;
}

export interface SubscriptionEventInfo {
  subscriptionID: string;
  sequence: number;
  /** True when `sequence` does not follow the previous event: events were missed. */
  gap: boolean;
}

export type SubscriptionHandler = (event: JsonObject, info: SubscriptionEventInfo) => unknown;

export interface Subscription {
  readonly subscriptionID: string;
  readonly disposed: boolean;
  /** Stops routing events at once and asks the host to dispose the subscription. */
  dispose(): Promise<void>;
}

/** A file or folder under a root of `getFolders`; `path` uses `/` and is relative to the root. */
export interface WorkspaceResource {
  rootID: string;
  path: string;
}

/** One-based UTF-16 position. */
export interface TextPosition {
  line: number;
  column: number;
}

/** Half-open range. */
export interface TextRange {
  start: TextPosition;
  end: TextPosition;
}

export interface TextSelection {
  anchor: TextPosition;
  active: TextPosition;
}

export interface DocumentSummary {
  documentID: string;
  version: number;
  /** Workspace-relative, or null outside the root. */
  path: string | null;
  languageID: string | null;
  isReadOnly: boolean;
  isDirty: boolean;
  encoding: string;
  lineEnding: string;
  [key: string]: unknown;
}

export interface EditResult {
  documentID: string;
  version: number;
  applied: boolean;
  [key: string]: unknown;
}

export interface OpenParams {
  resource: WorkspaceResource;
  activation?: 'select' | 'background';
  range?: TextRange;
  tab?: 'regular';
}

export interface FindPage<T> {
  matches: T[];
  nextCursor: string | null;
  isTruncated: boolean;
  source: 'disk';
  [key: string]: unknown;
}

type Scoped<P, R> = (context: ContextReference, params: P, options?: HostRequestOptions) => Promise<R>;
type ScopedOptional<P, R> = (context: ContextReference, params?: P, options?: HostRequestOptions) => Promise<R>;

/**
 * Host services of plugin-function protocols 2 and 3. Every method rejects
 * with `HostError` when the host refuses; from protocol 3 check
 * `supports(method)` instead of assuming a method from the version.
 * A full `WorkspaceContext` may be passed wherever a reference is expected.
 */
export interface Host {
  /** The negotiated plugin-function version, or 0 before or without one. */
  readonly version: number;
  /** Sends any `lithe/host/*` request, including ones a later host adds. */
  request<T = unknown>(method: string, params?: JsonObject, options?: HostRequestOptions): Promise<T>;
  /** Sends a request answering `{ subscriptionID }` and routes that subscription's events. */
  subscribe(method: string, params: JsonObject, onEvent?: SubscriptionHandler, options?: HostRequestOptions): Promise<Subscription>;
  /** The session's capabilities; protocol 3, cached. */
  capabilities(): Promise<HostCapabilities>;
  /** Whether this session may call `method`. Under protocol 2, which has no discovery, the methods it defines. */
  supports(method: string): Promise<boolean>;
  /** Protocol 2; permission `credentials.store`. Kept in the platform's secret store, per plugin. */
  readonly credentials: {
    /** The stored secret, or null. */
    get(key: string, options?: HostRequestOptions): Promise<string | null>;
    set(key: string, secret: string, options?: HostRequestOptions): Promise<void>;
    delete(key: string, options?: HostRequestOptions): Promise<void>;
  };
  readonly subscriptions: {
    dispose(subscriptionID: string): Promise<void>;
  };
  readonly workspace: {
    /** Permission `workspace.metadata`. Entries carry no `stateDirectory`. */
    listContexts(options?: HostRequestOptions): Promise<{ revision: number; contexts: WorkspaceContext[] }>;
    getContext(context: ContextReference, options?: HostRequestOptions): Promise<WorkspaceContext>;
    getFolders(context: ContextReference, options?: HostRequestOptions): Promise<{ folders: WorkspaceFolder[] }>;
    /** Permission `workspace.files.read`. */
    readDirectory: Scoped<{ resource: WorkspaceResource; cursor?: string; limit?: number }, {
      entries: { name: string; resource: WorkspaceResource; kind: string }[];
      nextCursor: string | null;
    }>;
    stat: Scoped<{ resource: WorkspaceResource }, { resource: WorkspaceResource; kind: string; size: number; modifiedMilliseconds: number }>;
    readFile: Scoped<{ resource: WorkspaceResource; maximumBytes?: number }, {
      resource: WorkspaceResource;
      source: 'disk';
      byteCount: number;
      isTruncated: boolean;
      identity: JsonValue;
      text?: string;
      encoding?: string;
      base64?: string;
    }>;
    /** Permission `workspace.files.watch`. Events carry `{ rootID, changedPaths, requiresRescan }`. */
    watch(
      context: ContextReference,
      params: { resource: WorkspaceResource; recursive?: boolean },
      onEvent: SubscriptionHandler,
      options?: HostRequestOptions,
    ): Promise<Subscription>;
    /** Permission `workspace.search`; `resource` names the root (`path: ""`). */
    findFiles: Scoped<{ resource: WorkspaceResource; query: string; fileMask?: string; cursor?: string; limit?: number }, FindPage<WorkspaceResource>>;
    findText: Scoped<{
      resource: WorkspaceResource;
      pattern: string;
      fileMask?: string;
      caseSensitive?: boolean;
      wholeWords?: boolean;
      regularExpression?: boolean;
      cursor?: string;
      limit?: number;
    }, FindPage<{ resource: WorkspaceResource; line: number; preview: string; range: TextRange | null }>>;
  };
  /** Permission `documents.read`. */
  readonly documents: {
    list: ScopedOptional<JsonObject, { documents: DocumentSummary[] }>;
    getSnapshot: Scoped<{ documentID: string }, { document: DocumentSummary; text: string }>;
  };
  readonly editor: {
    getActive: ScopedOptional<JsonObject, DocumentSummary | null>;
    getSelections: Scoped<{ documentID: string }, { documentID: string; version: number; selections: TextSelection[]; primaryIndex: number }>;
    /** Permission `editor.edit`. Not replayed on cancellation or timeout: the edit may have committed. */
    applyEdits: Scoped<{ documentID: string; expectedVersion: number; edits: { range: TextRange; text: string }[] }, EditResult>;
    replaceSelections: Scoped<{ documentID: string; expectedVersion: number; selections: TextSelection[]; replacements: string[] }, EditResult>;
    insertText: Scoped<{ documentID: string; expectedVersion: number; at: TextPosition; text: string }, EditResult>;
    /** Permission `editor.open`. */
    open: Scoped<OpenParams, JsonObject>;
    reveal: Scoped<OpenParams, JsonObject>;
    /** Permission `editor.actions`; the host later calls `function` to collect actions. */
    registerActions(
      context: ContextReference,
      params: { id: string; function: string; selector: { fileExtensions?: string[]; fileNames?: string[] } },
      options?: HostRequestOptions,
    ): Promise<Subscription>;
  };
  /** Permission `preview.open`. */
  readonly preview: {
    openHTML: Scoped<{ resource: WorkspaceResource; presentation?: 'editorAndPreview' | 'previewOnly'; range?: TextRange }, JsonObject>;
  };
  /** Permission `browser.open`; exactly one of `url` or `resource`. */
  readonly browser: {
    openExternal: Scoped<
      { url: string } | { resource: WorkspaceResource; unsaved?: 'openSavedFile' | 'requireSaved' },
      { opened: true; source: 'web' | 'disk'; hasUnsavedChanges?: boolean }
    >;
  };
  /** Permission `terminal.create`; only terminals owned by this backend session and context. */
  readonly terminal: {
    create: Scoped<{ executable: string; arguments?: string[]; title?: string; cwd?: WorkspaceResource;
      environment?: Record<string, string | null>; show?: boolean; retainedContextBytes?: number }, { terminalID: string; generation: number }>;
    show: Scoped<{ terminalID: string }, null>;
    close: Scoped<{ terminalID: string; retainedContextBytes?: number }, { retainedContextBytes: number }>;
    reopen: Scoped<{ terminalID: string; show?: boolean }, { terminalID: string; generation: number; restoredContextBytes: number }>;
    dispose: Scoped<{ terminalID: string }, null>;
    onExit(context: ContextReference, terminalID: string,
      onEvent: (event: { type: 'exit'; terminalID: string; exitCode: number | null; reason: 'exited' | 'closed'; generation: number }, metadata: SubscriptionEventInfo) => void,
      options?: HostRequestOptions): Promise<Subscription>;
  };
  /** Permission `window.messages`. `selectedIndex` is zero-based, or null on dismissal. */
  readonly window: {
    showInformation: Scoped<{ text: string; actions?: string[] }, { selectedIndex: number | null }>;
    showWarning: Scoped<{ text: string; actions?: string[] }, { selectedIndex: number | null }>;
    showError: Scoped<{ text: string; actions?: string[] }, { selectedIndex: number | null }>;
  };
}

export interface CommandEvent {
  commandID: string;
  /** The context of the window the command ran in, or null. */
  workspaceContext: ContextReference | null;
}

export interface ProgressReport {
  /** Cut to 1024 bytes. */
  message?: string;
  /** Rounded and clamped to 0-100. */
  percentage?: number;
}

export interface FunctionContext extends RequestContext {
  functionID: string;
  /** Opaque per-call ID chosen by Lithe. */
  operationID: string;
  /** The context of the page's window (protocol 3), or null. */
  workspaceContext: ContextReference | null;
  /** Reports progress; ignored once the call has ended. */
  progress(report: ProgressReport): void;
}

export type FunctionHandler = (params: JsonObject, context: FunctionContext) => unknown | Promise<unknown>;
export type BuildHandler = (params: BuildRequestParams, context: RequestContext) => JsonObject | Promise<JsonObject>;

/** Params of `lithe/build/model` and `lithe/build/dependencies`. */
export interface BuildRequestParams {
  /** Read-only host snapshot; missing producers remain unavailable. Requires protocol 6. */
  modelInputs?: BuildModelInputs;
  buildSystemID: string;
  root: string;
  options: JsonObject;
  optionArguments: string[];
  environment: Record<string, string>;
  /** Dependencies only: the selected project, or null for the workspace. */
  project?: { name: string; path: string } | null;
  /** True when the user or a sync-file change asked to reload; skip any snapshot. */
  refresh?: boolean;
  /** The build tool the host resolved; absent when it could not, so look it up yourself. */
  tool?: { executable: string };
  [key: string]: unknown;
}

/** Public normalized facts. Tasks, run plans, settings and optionValues never cross this boundary. */
export interface BuildSharedModel {
  projects: { id: string; name: string; path: string; displayName?: string; parentID?: string; properties: Record<string, string> }[];
  targets: { id: string; projectID: string; name: string; path: string; tags: string[]; properties: Record<string, string> }[];
  contentRoots: { projectID: string; path: string; kind: string }[];
}
export type BuildModelInputInstance =
  | { root: string; state: 'ready'; model: BuildSharedModel; configurationFingerprint: string; options: JsonObject }
  | { root: string; state: 'loading' | 'stale' | 'failed' };
export interface BuildModelInputs {
  version: 1;
  /** Opaque workspace-activation revision; discard cached work after it changes. */
  revision: number;
  inputs: { pluginID: string; buildSystemID: string; state: 'available' | 'unavailable'; instances: BuildModelInputInstance[] }[];
}

/** Current upstream model selection, preserved as data rather than shell text. */
export interface BuildSelection {
  name: string;
  path: string;
  tags?: string[];
  properties?: JsonObject;
}

export interface BuildExecutionParams extends BuildRequestParams {
  task: string;
  project?: BuildSelection | null;
  target?: BuildSelection | null;
  userArguments: string[];
  operationID: string;
}

export interface BuildTestParams extends BuildRequestParams {
  project?: BuildSelection | null;
  target?: BuildSelection | null;
  suite?: string;
  case?: string;
  userArguments: string[];
  operationID: string;
}

export interface BuildRunParams extends BuildRequestParams {
  run: string;
  project: BuildSelection;
  target: BuildSelection;
  userArguments: string[];
  operationID: string;
}

export interface BuildProgressReport extends ProgressReport {
  /** Cut to 64 KiB of UTF-8 per notification. Build messages are cut to 4096 bytes. */
  output?: string;
}

export interface BuildContext extends RequestContext {
  /** The Core-assigned wire identity, never a plugin-selected value. */
  operationID: string;
  /** Dropped after cancellation or completion. */
  progress(report: BuildProgressReport): void;
}

export interface BuildExecutionResult { exitCode: number; output: string; }
export interface BuildTestDiscovery {
  format?: 'litheTestDiscovery';
  version?: 1;
  tests: { suite: string; case: string; project?: BuildSelection; target?: BuildSelection }[];
}
export interface BuildRunPreparation {
  executable: { kind: 'toolchain' | 'command'; value: string };
  arguments: string[];
  workingDirectory: string;
  environment: Record<string, string>;
}
export type BuildExecutionHandler = (params: BuildExecutionParams, context: BuildContext) => BuildExecutionResult | Promise<BuildExecutionResult>;
export type BuildTestHandler = (params: BuildTestParams, context: BuildContext) => BuildExecutionResult | Promise<BuildExecutionResult>;
export type BuildDiscoveryHandler = (params: BuildRequestParams, context: RequestContext) => BuildTestDiscovery | Promise<BuildTestDiscovery>;
export interface BuildDebugPreparation {
  program: string;
  arguments: string[];
  workingDirectory: string;
  environment: Record<string, string>;
}
export type BuildDebugHandler = (params: BuildRunParams, context: BuildContext) => BuildDebugPreparation | Promise<BuildDebugPreparation>;
export type BuildRunHandler = (params: BuildRunParams, context: BuildContext) => BuildRunPreparation | Promise<BuildRunPreparation>;

/** Params every VCS handler receives, on top of its operation's arguments. */
export interface VcsRequestParams {
  root: { path: string };
  /** The VCS client the host resolved; null when it could not, so report `vcs.tool.unavailable`. */
  tool: { executable: string } | null;
  [key: string]: unknown;
}

export interface VcsRunOptions extends RunProcessOptions {
  /** Report the finished command as `lithe/vcs/execution`; default true. */
  report?: boolean;
}

export interface VcsContext extends RequestContext {
  /** `RequestContext.run` that also reports each finished command to the host's console. */
  run(command: string, args?: string[], options?: VcsRunOptions): Promise<ProcessResult>;
}

export type VcsHandler = (params: VcsRequestParams, context: VcsContext) => JsonObject | void | Promise<JsonObject | void>;

/** Handlers keyed by operation; see shared/contracts/vcs-provider-v1.md for each reply. */
export interface VcsHandlers {
  status: VcsHandler;
  baseContent: VcsHandler;
  checkin: VcsHandler;
  rollback: VcsHandler;
  history?: VcsHandler;
  fileHistory?: VcsHandler;
  annotate?: VcsHandler;
  update?: VcsHandler;
  fileOperation?: VcsHandler;
  resolve?: VcsHandler;
  cleanup?: VcsHandler;
}

export interface VcsTraits {
  /** Check-in is local and publishing is a separate step. */
  push?: boolean;
  /** Changes carry a staged/unstaged dimension. */
  staging?: boolean;
}

export interface Negotiated {
  functions: boolean;
  build: boolean;
  vcs: boolean;
}

export interface BackendOptions {
  name?: string;
  version?: string;
  /** Standard LSP server capabilities; `experimental.litheBuild`, `litheFunctions`, and `litheVcs` are reserved. */
  capabilities?: JsonObject;
}

export interface ListenOptions {
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  errorOutput?: NodeJS.WritableStream;
  /** Defaults to `process.exit`; null only resolves the returned promise. */
  exit?: ((code: number) => void) | null;
}

export interface Backend {
  readonly negotiated: Negotiated;
  readonly initializeParams: JsonObject | null;
  /** Highest common version (1-6), or null before/without negotiation. */
  readonly buildVersion: number | null;
  /** Highest common plugin-function version (1-3), or null before/without negotiation. */
  readonly functionsVersion: number | null;
  readonly functionIDs: string[];
  /** Host services; usable once the session is ready. */
  readonly host: Host;
  readonly build: {
    model(handler: BuildHandler): Backend;
    dependencies(handler: BuildHandler): Backend;
    execute(handler: BuildExecutionHandler): Backend;
    test(handler: BuildTestHandler): Backend;
    discoverTests(handler: BuildDiscoveryHandler): Backend;
    prepareRun(handler: BuildRunHandler): Backend;
    prepareDebug(handler: BuildDebugHandler): Backend;
  };
  vcs(id: string, handlers: VcsHandlers, traits?: VcsTraits): Backend;
  function(id: string, handler: FunctionHandler): Backend;
  registerFunction(id: string, handler: FunctionHandler): Promise<void>;
  unregisterFunction(id: string): Promise<void>;
  onRequest(method: string, handler: (params: unknown, context: RequestContext) => unknown): Backend;
  onNotification(method: string, handler: (params: unknown) => unknown): Backend;
  /** Handles `lithe/host/commands/didRun` for one of the plugin's commands (protocol 3). */
  onCommand(commandID: string, handler: (event: CommandEvent) => unknown): Backend;
  /** Handles `lithe/host/workspace/didChangeContexts` (protocol 3). */
  onContextsChanged(handler: (event: { revision: number }) => unknown): Backend;
  /** Handles a `lithe/host/*` notification a later host adds. */
  onHostNotification(method: string, handler: (params: JsonObject) => unknown): Backend;
  onInitialize(hook: (event: { params: JsonObject; negotiated: Negotiated }) => unknown): Backend;
  onShutdown(hook: () => unknown): Backend;
  sendRequest(method: string, params?: unknown): Promise<unknown>;
  sendNotification(method: string, params?: unknown): void;
  readonly diagnostics: Diagnostics;
  suppressSuccessDiagnostics(operation: string): this;
  listen(options?: ListenOptions): Promise<number>;
}

export function createBackend(options?: BackendOptions): Backend;

export class PluginError extends Error {
  constructor(code: string, message: string, options?: { cause?: unknown });
  readonly code: string;
}

export class PluginSdkError extends Error {
  readonly code: string;
}

/** The host refused or failed a request this backend sent. */
export class HostError extends PluginSdkError {
  /** `error.data.code`, such as `plugin.host.contextExpired`. */
  readonly code: string;
  /** The JSON-RPC error number. */
  readonly rpcCode: number | undefined;
  /** Protocol 3 details, such as `{ option }` or `{ retryAfterMilliseconds }`. */
  readonly details: JsonObject | undefined;
  readonly method: string | undefined;
}

export function runProcess(command: string, args?: string[], options?: RunProcessOptions): Promise<ProcessResult>;

export interface StateStore {
  readonly directory: string;
  read<T = JsonValue>(key: string, fallback?: T): T | undefined;
  write(key: string, value: JsonValue): void;
  delete(key: string): void;
}

export function openStateStore(directory: string, options?: { packageDirectory?: string | null }): StateStore;

export function isFunctionId(value: unknown): boolean;

/** Host failure codes and the JSON-RPC number each has from protocol 3. */
export const HOST_ERRORS: Readonly<{
  'plugin.host.unavailable': -32601;
  'plugin.host.invalidParams': -32602;
  'plugin.host.failed': -32603;
  'plugin.host.cancelled': -32800;
  'plugin.host.permissionDenied': -32010;
  'plugin.host.contextExpired': -32011;
  'plugin.host.authorityUnsupported': -32012;
  'plugin.host.versionConflict': -32013;
  'plugin.host.limitExceeded': -32014;
  'plugin.host.timeout': -32015;
  'plugin.host.notFound': -32016;
  'plugin.host.readOnly': -32017;
  'plugin.host.unsupportedOption': -32018;
  'plugin.host.preconditionFailed': -32019;
  'plugin.host.busy': -32020;
  'plugin.host.rateLimited': -32021;
}>;

/** Host request method names of protocols 2 and 3. */
export const HOST_METHODS: Readonly<Record<
  | 'credentialsGet' | 'credentialsSet' | 'credentialsDelete' | 'getCapabilities' | 'subscriptionsDispose'
  | 'workspaceListContexts' | 'workspaceGetContext' | 'workspaceGetFolders' | 'workspaceReadDirectory'
  | 'workspaceStat' | 'workspaceReadFile' | 'workspaceWatch' | 'workspaceFindFiles' | 'workspaceFindText'
  | 'documentsList' | 'documentsGetSnapshot' | 'editorRegisterActions' | 'editorGetActive'
  | 'editorGetSelections' | 'editorApplyEdits' | 'editorReplaceSelections' | 'editorInsertText'
  | 'editorOpen' | 'editorReveal' | 'previewOpenHTML' | 'browserOpenExternal'
  | 'windowShowInformation' | 'windowShowWarning' | 'windowShowError',
  string
>>;

export function isVcsId(value: unknown): boolean;

/** Provider error codes Core passes on; use them as `PluginError` codes. */
export const VCS_ERRORS: Readonly<{
  authenticationFailed: 'vcs.authentication.failed';
  conflict: 'vcs.conflict';
  outOfDate: 'vcs.outOfDate';
  toolUnavailable: 'vcs.tool.unavailable';
  workingCopyLocked: 'vcs.workingCopy.locked';
  workingCopyUnsupported: 'vcs.workingCopy.unsupported';
}>;

export const LIMITS: Readonly<{
  maxFunctions: number;
  maxFunctionIdBytes: number;
  maxPluginErrorCodeBytes: number;
  maxMessageBytes: number;
  maxResultBytes: number;
  maxBuildResultBytes: number;
  maxBuildMessageBytes: number;
  maxBuildOutputBytes: number;
  maxVcsIdBytes: number;
  maxExecutionErrorOutputBytes: number;
  maxCredentialKeyBytes: number;
  maxCredentialSecretBytes: number;
  maxPendingHostRequests: number;
}>;
