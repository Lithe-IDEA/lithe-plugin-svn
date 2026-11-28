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

/** `{ contextID, generation }`: one generation of one workspace context. */
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

/**
 * The remote host's operating system and CPU architecture: `os` is `linux`
 * and `arch` is `arm64` or `x86_64`. Ignore a value you do not know; a later
 * host may connect to other systems.
 */
export interface RemotePlatform {
  os: string;
  arch: string;
}

/**
 * A path on the remote host of a `remote` context, from `getHostPaths`. It
 * is not a string, so `fs` and `path` refuse it: the machine that runs the
 * backend has no file there. Pass `value` only to what runs on that host.
 * `JSON.stringify` writes it as that string.
 */
export class HostPath {
  /** Throws `TypeError` unless `value` is an absolute POSIX path. */
  constructor(value: string);
  /** The absolute POSIX path on the remote host. */
  readonly value: string;
  toString(): string;
  toJSON(): string;
}

/** One root folder of a `remote` context and its path on the remote host. */
export interface HostFolder {
  rootID: string;
  hostPath: HostPath;
}

/** One root folder of a `local` context and its local path. */
export interface LocalFolder {
  rootID: string;
  path: string;
}

/** One open workspace in one window. */
export interface WorkspaceContext extends ContextReference {
  name: string;
  /** `platform` is present only for a remote authority. */
  authority: { kind: 'local' | 'remote'; id?: string; platform?: RemotePlatform };
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
  /** Aborting it rejects with its reason, and the host is told to stop. Never retried. */
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

/** One enabled plugin that exports a function, from `host.functions.providers`. */
export interface FunctionProvider {
  pluginID: string;
  /** The contract version of the exported function. */
  version: number;
}

export interface FunctionProvidersResult {
  /** Enabled plugins other than the caller, sorted by plugin ID. */
  providers: FunctionProvider[];
}

/** One cross-plugin call, the argument of `host.functions.invoke`. */
export interface FunctionCall {
  /** The providing plugin, one of `providers(functionID)`. */
  pluginID: string;
  functionID: string;
  /** A JSON object; not sent when omitted, which Core reads as `{}`. */
  params?: JsonObject;
  /** A positive integer. Core defaults it to 60000 and caps it at 600000. */
  timeoutMilliseconds?: number;
  /**
   * The `operationID` of the call this one belongs to, a string of 1-128 bytes.
   * Inside a function handler `context.host` fills it with the call being
   * served; `backend.host` has no default.
   */
  parentOperationID?: string;
}

export interface FunctionInvokeResult {
  /** The provider's result; `null` is a result. */
  value: JsonValue;
}

/**
 * Host services of the plugin-function protocol. Every method rejects with
 * `HostError` when the host refuses; check `supports(method)` instead of
 * assuming a method exists. A full `WorkspaceContext` may be passed wherever
 * a reference is expected.
 */
export interface Host {
  /** Whether the host negotiated plugin functions, and with them host services, in this session. */
  readonly negotiated: boolean;
  /** Sends any `lithe/host/*` request, including ones a later host adds. */
  request<T = unknown>(method: string, params?: JsonObject, options?: HostRequestOptions): Promise<T>;
  /** Sends a request answering `{ subscriptionID }` and routes that subscription's events. */
  subscribe(method: string, params: JsonObject, onEvent?: SubscriptionHandler, options?: HostRequestOptions): Promise<Subscription>;
  /** The session's capabilities, cached. */
  capabilities(): Promise<HostCapabilities>;
  /** Whether this session may call `method`, from the session's capabilities. */
  supports(method: string): Promise<boolean>;
  /** Permission `credentials.store`. Kept in the platform's secret store, per plugin. */
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
    reveal: Scoped<{resource:WorkspaceResource},null>;
    setDirectoryTypes: Scoped<{types:JsonObject[]},{count:number}>;
    setDirectoryMarks: Scoped<{marks:JsonObject[]},{count:number}>;

    /** Permission `workspace.metadata`. Entries carry no `stateDirectory`. */
    listContexts(options?: HostRequestOptions): Promise<{ revision: number; contexts: WorkspaceContext[] }>;
    getContext(context: ContextReference, options?: HostRequestOptions): Promise<WorkspaceContext>;
    getFolders(context: ContextReference, options?: HostRequestOptions): Promise<{ folders: WorkspaceFolder[] }>;
    /**
     * The root folders of a `remote` context on the remote host, every root or
     * the `rootIDs` named, in that order. Permission `workspace.metadata`, as a
     * method grant of its own. A `local` context is `plugin.host.authorityUnsupported`.
     */
    getHostPaths(
      context: ContextReference,
      params?: { rootIDs?: string[] },
      options?: HostRequestOptions,
    ): Promise<{ folders: HostFolder[] }>;
    /**
     * The path a process uses for each root of a full context: `path` of a
     * `local` context, without asking the host, or `hostPath` from
     * `getHostPaths` for any other authority.
     */
    processRoots(
      context: WorkspaceContext,
      options?: HostRequestOptions,
    ): Promise<{ folders: LocalFolder[] } | { folders: HostFolder[] }>;
    /** Permission `workspace.files.read`. */
    readDirectory: Scoped<{ resource: WorkspaceResource; cursor?: string; limit?: number }, {
      entries: { name: string; resource: WorkspaceResource; kind: string }[];
      nextCursor: string | null;
    }>;
    stat: Scoped<{ resource: WorkspaceResource }, { resource: WorkspaceResource; kind: string; size: number; modifiedMilliseconds: number | null }>;
    readFile: Scoped<{ resource: WorkspaceResource; maximumBytes?: number }, {
      resource: WorkspaceResource;
      source: 'disk';
      byteCount: number;
      isTruncated: boolean;
      /** Identity of the returned byte prefix, including whether an unread suffix exists. */
      identity: { sha256: string; byteCount: number; isTruncated: boolean };
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
    /**
     * Permission `workspace.files.write`. Never overwrites: an existing
     * `resource` is `plugin.host.alreadyExists`. `text` is for a file only.
     */
    create: Scoped<
      | { resource: WorkspaceResource; kind: 'file'; text?: string }
      | { resource: WorkspaceResource; kind: 'directory' }
      | { resource: WorkspaceResource; kind: 'symlink'; linkTarget: string },
      { resource: WorkspaceResource; kind: 'file' | 'directory' | 'symlink' }>;
    /**
     * Permission `workspace.files.write`. `target` is the full new path. The
     * host saves the open documents under `resource` first; they follow the file.
     */
    rename: Scoped<{ resource: WorkspaceResource; target: WorkspaceResource }, { resource: WorkspaceResource }>;
    /** Permission `workspace.files.write`. `target` must not exist. */
    copy: Scoped<{ resource: WorkspaceResource; target: WorkspaceResource }, { resource: WorkspaceResource }>;
    /**
     * Permission `workspace.files.write`. Saves and closes the open documents
     * under `resource`, then moves it to the system trash; nothing is deleted permanently.
     */
    trash: Scoped<{ resource: WorkspaceResource }, null>;
  };
  /** Permission `documents.read`, and `documents.save` for `save`, `saveAs` and `close`. */
  readonly documents: {
    list: ScopedOptional<JsonObject, { documents: DocumentSummary[] }>;
    getSnapshot: Scoped<{ documentID: string }, { document: DocumentSummary; text: string }>;
    /**
     * Writes the document's current text. A file changed on disk is
     * `plugin.host.diskChanged`, and nothing is written.
     */
    save: Scoped<{ documentID: string; expectedVersion?: number }, { document: DocumentSummary }>;
    /** Writes to `target`, which must not exist, and opens the new file. */
    saveAs: Scoped<{ documentID: string; target: WorkspaceResource }, { document: DocumentSummary }>;
    /** Saves the document, then closes its tab; never discards the user's edits. */
    close: Scoped<{ documentID: string }, null>;
  };
  readonly editor: {
    showDiff: Scoped<{original:string;modified:string;title?:string;originalTitle?:string;modifiedTitle?:string},{opened:true}>;

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
  /** Permission `views.refresh`. */
  readonly views: {
    refresh: Scoped<{instance:string},{refreshed:true}>;
  };
  readonly output: {
    create: Scoped<{name:string},{channelID:string}>;
    append: Scoped<{channelID:string;text:string},null>;
    clear: Scoped<{channelID:string},null>;
    show: Scoped<{channelID:string},null>;
    dispose: Scoped<{channelID:string},null>;
  };
  readonly progress: {
    create(context: ContextReference, params: {title:string;cancellable?:boolean}, onEvent?: (event: {cancelled:true}, metadata: SubscriptionEventInfo) => void, options?: HostRequestOptions): Promise<Subscription>;
    report: Scoped<{progressID:string;message?:string;percentage?:number},null>;
    end: Scoped<{progressID:string},null>;
  };
  readonly statusBar: {
    setItem: Scoped<{id:string;text:string;tooltip?:string;commandID?:string;priority?:number},{id:string}>;
    removeItem: Scoped<{id:string},null>;
  };
  readonly clipboard: {
    readText: Scoped<JsonObject,{text:string}>;
    writeText: Scoped<{text:string},null>;
  };
  readonly network: {
    request: Scoped<{url:string;method?:'GET'|'POST'|'PUT'|'PATCH'|'DELETE'|'HEAD'|'OPTIONS';headers?:Record<string,string>;body?:string;timeoutMilliseconds?:number;maximumResponseBytes?:number},{status:number;headers:Record<string,string[]>;body:string;encoding:'utf8'|'base64'}>;
  };
  /** Permission `preview.open`. */
  readonly preview: {
    openMarkdown: Scoped<PreviewParams,JsonObject>;

    openHTML: Scoped<PreviewParams,JsonObject>;
  };
  /** Permission `browser.open`; exactly one of `url` or `resource`. */
  readonly browser: {
    openExternal: Scoped<
      { url: string } | { resource: WorkspaceResource; unsaved?: 'openSavedFile' | 'requireSaved' },
      { opened: true; source: 'web' | 'disk'; hasUnsavedChanges?: boolean }
    >;
  };
  /**
   * The manifest's `pluginFunctions.calls`. Calls between plugins, relayed
   * through Core. Argument mistakes reject with `PluginSdkError`
   * `sdk.functions.invalidCall`, or `sdk.host.invalidContext` for the
   * context, before anything is sent.
   */
  /**
   * Native agent sessions and usage totals (plan API-45). Core answers it;
   * `write` and `report` need `agents.native`, `usage` `agents.usage.read`.
   */
  readonly agents: {
    /** Writes 1-256 lines, without line breaks, to the standard input of `session`'s CLI. */
    write(session: string, lines: string[], options?: HostRequestOptions): Promise<void>;
    /** Reports 1-256 events of `session`; one refused event refuses them all. */
    report(session: string, events: AgentSessionEvent[], options?: HostRequestOptions): Promise<void>;
    /** Usage totals of the agents' sessions. */
    usage(params: AgentUsageParams, options?: HostRequestOptions): Promise<AgentUsageResult>;
  };
  readonly functions: {
    /** The enabled plugins other than this one that export `functionID`. */
    providers(functionID: string, options?: HostRequestOptions): Promise<FunctionProvidersResult>;
    /** Calls one provider's function in a workspace context. A provider's own failure is `plugin.function.failed`. */
    invoke(context: ContextReference, call: FunctionCall, options?: HostRequestOptions): Promise<FunctionInvokeResult>;
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
    showQuickPick: Scoped<{title?:string;placeholder?:string;items:QuickPickItem[];canPickMany?:boolean},{selectedIDs:string[]}|null>;
    showInputBox: Scoped<{title?:string;prompt?:string;placeholder?:string;value?:string;password?:boolean},{value:string}|null>;

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
  /** The context of the page's window, or null. */
  workspaceContext: ContextReference | null;
  /**
   * The plugin that called this function through the relay, or null: the
   * host started the call.
   * Decide by this field, never by a plugin ID inside `params`.
   */
  readonly caller: { readonly pluginID: string } | null;
  /** Reports progress; ignored once the call has ended. */
  progress(report: ProgressReport): void;
}

export type FunctionHandler = (params: JsonObject, context: FunctionContext) => unknown | Promise<unknown>;
export type BuildHandler = (params: BuildRequestParams, context: RequestContext) => JsonObject | Promise<JsonObject>;

/** A file captured under the selected shortcut source. `path` is a relative label. */
export interface KeymapSourceFile { id: string; path: string; byteCount: number }
export interface KeymapImportSnapshot {
  readonly providerID: string;
  readonly snapshotID: string;
  listInputs(): Promise<KeymapSourceFile[]>;
  readChunk(fileID: string, offset: number, maximumBytes: number): Promise<Uint8Array>;
}
export interface KeymapImportBinding {
  commandID: string;
  keys: Array<{ key: string; modifiers: Array<'control' | 'alt' | 'shift' | 'meta'> }>;
}
export type KeymapImportHandler = (snapshot: KeymapImportSnapshot, context: RequestContext) =>
  { bindings: KeymapImportBinding[] } | Promise<{ bindings: KeymapImportBinding[] }>;

/** Params of `lithe/build/model` and `lithe/build/dependencies`. */
export interface BuildRequestParams {
  /** Read-only host snapshot; missing producers remain unavailable. */
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
  version: 0;
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
  version?: 0;
  tests: { suite: string; case: string; project?: BuildSelection; target?: BuildSelection }[];
}
/** buildProviders 1: the entrypoints of one source file an entrypoint run starts. */
export interface BuildRunEntrypoints {
  format?: 'litheRunEntrypoints';
  version?: 0;
  entrypoints: { run: string; name: string; entrypoint: string; project: BuildSelection }[];
}
export interface BuildRunPreparation {
  executable: { kind: 'toolchain' | 'command'; value: string };
  arguments: string[];
  workingDirectory: string;
  environment: Record<string, string>;
}
export type BuildExecutionHandler = (params: BuildExecutionParams, context: BuildContext) => BuildExecutionResult | Promise<BuildExecutionResult>;
export type BuildTestHandler = (params: BuildTestParams, context: BuildContext) => BuildExecutionResult | Promise<BuildExecutionResult>;
export type BuildRunEntrypointsHandler = (params: BuildRequestParams & { file: string }, context: RequestContext) => BuildRunEntrypoints | Promise<BuildRunEntrypoints>;
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

// Plugin views (`ui` 0, `settings` 0): the params a view function receives and
// the result it returns. contract/v1/plugin-ui.schema.json is the authority;
// Core's plugins.ui.applyResult enforces the rules a type cannot express.

export type ViewEventKind = 'open' | 'close' | 'click' | 'change' | 'select' | 'activate' | 'viewport' | 'resize' | 'settings' | 'refresh' | 'expand' | 'loadMore';

/** Params of one call to a view function. */
export interface ViewEvent {
  event: ViewEventKind;
  /** Host-chosen; each `open` starts a new instance. */
  instance: string;
  /** The declaration being drawn. */
  surface: { toolWindowID: string } | { settingRegionID: string };
  /** Interface language tag, such as `en` or `zh-Hans`; return view text in it. */
  language: string;
  /** Setting values by ID. `draft` holds the open settings window's unapplied changes; `{}` in a tool window. */
  settings: { effective: JsonObject; draft: JsonObject };
  /** `click`, `change`, `select`, `activate`: the node acted on; the group's ID inside a canvas, the tree's ID for an item. */
  node?: string;
  /** A click inside a canvas, and `viewport`: the canvas ID. */
  canvas?: string;
  /** `change`: a string, a boolean for `toggle`; for a bound control, the new draft value as the setting stores it. */
  value?: string | number | boolean;
  /** `change` of a control bound to a setting: the setting ID. */
  setting?: string;
  /** `select`, `activate`: the tree item ID. */
  item?: string;
  /** Opaque continuation of a tree loadMore event. */
  cursor?: string;
  /** `viewport`: the visible part of the canvas, in view-box coordinates. */
  viewport?: { x: number; y: number; width: number; height: number };
  /**
   * The width in points the host lays the view out in, on every event from a
   * host that reports it; `resize` sends the new width. List `resize` in a
   * canvas's `on` only when it is present: a host without it may refuse the canvas.
   */
  width?: number;
}

/** A whole view, a batch of patches, or `{}` when nothing changed. The first result after `open` is a view. */
export type ViewResult =
  | { view: ViewNode[]; patches?: never }
  | { patches: ViewPatch[]; view?: never }
  | { view?: never; patches?: never };
/** `undefined` and `null` answer `{}`. */
export type ViewHandler = (event: ViewEvent, context: FunctionContext) =>
  ViewResult | null | undefined | Promise<ViewResult | null | undefined>;

export type ViewTone = 'secondary' | 'muted' | 'accent' | 'success' | 'warning' | 'error';
export interface ViewOption { value: string; label: string }

/** Host controls carry meaning only; the host draws them with its own controls. */
export type ViewNode =
  | { type: 'row'; id?: string; children: ViewNode[] }
  | { type: 'section'; id?: string; title?: string; info?: string; children: ViewNode[] }
  | { type: 'label'; id?: string; text: string; tone?: ViewTone; style?: 'title' | 'strong' | 'body' | 'caption' | 'mono'; width?: number; info?: string }
  | ViewTextField
  | ViewChoice
  | ViewToggle
  | ViewButton
  | { type: 'keyValue'; id?: string; items: Array<{ label: string; value: string; tone?: ViewTone }> }
  | { type: 'table'; id?: string; columns: Array<{ title: string; align?: 'start' | 'center' | 'end' }>; rows: string[][] }
  | { type: 'banner'; id?: string; text: string; tone: ViewTone }
  /** settings only: the host's row for a declared setting. */
  | { type: 'setting'; id?: string; setting: string }
  /** settings only: the host's row for a tool the plugin defines or requires. */
  | { type: 'tool'; id?: string; tool: string; choose?: boolean }
  /** tool windows only. */
  | { type: 'tree'; id: string; label?: string; items: ViewTreeItem[]; cursor?: string }
  | ViewCanvas;

/** A control shows its own `value` or edits a declared `setting` (settings only), never both. */
type ViewBinding<Value> = { value?: Value; setting?: never } | { setting: string; value?: never };
export type ViewTextField = { type: 'textField'; id: string; label?: string; info?: string; placeholder?: string; width?: 'fill' | number; mono?: boolean; enabled?: boolean } & ViewBinding<string>;
/** An enum setting supplies the options. `segmented` takes 2 to 8. */
export type ViewChoice = { type: 'select' | 'segmented'; id: string; label?: string; info?: string; enabled?: boolean }
  & ({ options: ViewOption[]; value?: string; setting?: never } | { setting: string; options?: never; value?: never });
export type ViewToggle = { type: 'toggle'; id: string; label: string; info?: string; enabled?: boolean } & ViewBinding<boolean>;
export interface ViewButton {
  type: 'button';
  id: string;
  text: string;
  tone?: 'primary';
  enabled?: boolean;
  /** settings only: a settingActions[] ID, run through the host's confirmation flow instead of sending `click`. */
  action?: string;
  /** A host icon name. */
  icon?: string;
}

export interface ViewTreeItem {
  id: string;
  label: string;
  icon?: string;
  detail?: string;
  expanded?: boolean;
  hasChildren?: boolean;
  children?: ViewTreeItem[];
}

/** `#RRGGBB`, `#RRGGBBAA`, or a theme token. */
export type ViewPlainColor = `#${string}` | '$text' | '$textSecondary' | '$textMuted' | '$accent' | '$success' | '$warning'
  | '$error' | '$surface' | '$background' | '$sidebar' | '$line' | '$hover' | '$selection' | '$badge';
export type ViewColor = ViewPlainColor | { light: ViewPlainColor; dark: ViewPlainColor }
  | { linear: Array<[offset: number, color: ViewPlainColor]>; angle?: number };

/** A vector scene the host keeps and draws natively; hover, press, pan and zoom never reach the plugin. */
export interface ViewCanvas {
  type: 'canvas';
  id: string;
  /** Accessible name of the scene. */
  label: string;
  height: number;
  viewBox: [x: number, y: number, width: number, height: number];
  pan?: boolean;
  zoom?: [minimum: number, maximum: number];
  on?: Array<'viewport' | 'resize'>;
  nodes: CanvasNode[];
}

export interface CanvasState { fill?: ViewColor; stroke?: ViewColor; width?: number; shadow?: 1 | 2 | 3; scale?: number; opacity?: number }
interface CanvasGroupBase {
  type: 'group';
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  radius?: number;
  clip?: boolean;
  scale?: number;
  children: CanvasNode[];
  tooltip?: string;
  states?: { hover?: CanvasState; pressed?: CanvasState; selected?: CanvasState };
  selected?: boolean;
  opacity?: number;
  shadow?: 1 | 2 | 3;
  hidden?: boolean;
}
/** A group with `on: ['click']` is a control: `id`, `w`, `h` (its hit area) and `label` are required. */
export type CanvasGroup = (CanvasGroupBase & { id?: string; label?: string; on?: never })
  | (CanvasGroupBase & { id: string; w: number; h: number; label: string; on: ['click'] });
export type CanvasText = { type: 'text'; id?: string; x: number; y: number; style?: 'title' | 'strong' | 'body' | 'caption' | 'display' | 'mono' | 'monoSmall'; align?: 'start' | 'center' | 'end'; color?: ViewColor; maxWidth?: number; opacity?: number }
  & ({ text: string; runs?: never } | { runs: Array<{ text: string; color?: ViewColor }>; text?: never });

export type CanvasNode =
  | { type: 'rect'; id?: string; x: number; y: number; w: number; h: number; radius?: number; fill?: ViewColor; stroke?: ViewColor; width?: number; dash?: number[]; shadow?: 1 | 2 | 3; opacity?: number }
  /** SVG path data; `bounds` lets the host skip it outside the visible area. */
  | { type: 'path'; id?: string; d: string; bounds?: [x: number, y: number, width: number, height: number]; fill?: ViewColor; stroke?: ViewColor; width?: number; dash?: number[]; cap?: 'butt' | 'round' | 'square'; rule?: 'nonzero' | 'evenodd'; opacity?: number }
  | CanvasText
  /** `src`: a PNG path inside the plugin package. */
  | { type: 'image'; id?: string; x: number; y: number; w: number; h: number; src: string; opacity?: number }
  | CanvasGroup;

/** Addresses the host controls by default, one canvas scene with `canvas`, or one tree's items with `tree`. */
type ViewPatchTarget = { canvas?: string; tree?: never } | { tree?: string; canvas?: never };
export type ViewPatch = ViewPatchTarget & (
  /** Merges fields; a `null` field removes it. `type` and `id` stay. */
  | { op: 'set'; id: string; fields: { [field: string]: unknown } }
  | { op: 'replace'; id: string; node: ViewNode | CanvasNode | ViewTreeItem }
  | { op: 'remove'; id: string }
  /** At `index` of `parent`'s children, or of the top level, or at the end. */
  | { op: 'insert'; parent?: string; index?: number; node: ViewNode | CanvasNode | ViewTreeItem }
);

export interface Negotiated {
  functions: boolean;
  build: boolean;
  vcs: boolean;
}

export interface BackendOptions {
  name?: string;
  version?: string;
  /** Standard LSP server capabilities; the SDK negotiates its experimental protocols. */
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
  /** The build protocol version in use (0), or null before/without negotiation. */
  readonly buildVersion: number | null;
  /** The plugin-function protocol version in use (0), or null before/without negotiation. */
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
    /** buildProviders 1: answers lithe/build/runEntrypoints with the format stamped. */
    runEntrypoints(handler: BuildRunEntrypointsHandler): Backend;
    prepareDebug(handler: BuildDebugHandler): Backend;
  };
  vcs(id: string, handlers: VcsHandlers, traits?: VcsTraits): Backend;
  function(id: string, handler: FunctionHandler): Backend;
  /**
   * Declares the view function a tool window or settings region names in
   * `view.function`: a plugin function whose params are a {@link ViewEvent}.
   * Params that are not a view event fail the call with
   * `sdk.view.invalidEvent` before the handler runs; an optional field that
   * is `null` counts as absent.
   */
  view(id: string, handler: ViewHandler): Backend;
  /** Declares an independent shortcut import provider before initialize. */
  keymapImportProvider(id: string, handler: KeymapImportHandler): Backend;
  registerFunction(id: string, handler: FunctionHandler): Promise<void>;
  unregisterFunction(id: string): Promise<void>;
  onRequest(method: string, handler: (params: unknown, context: RequestContext) => unknown): Backend;
  onNotification(method: string, handler: (params: unknown) => unknown): Backend;
  /** Handles `lithe/host/commands/didRun` for one of the plugin's commands. */
  onCommand(commandID: string, handler: (event: CommandEvent) => unknown): Backend;
  /** Handles `lithe/host/workspace/didChangeContexts`. */
  onContextsChanged(handler: (event: { revision: number }) => unknown): Backend;
  /**
   * Translates the native sessions of the plugin's agents (plan API-45): one
   * handler per session, called one notification at a time in Core's order.
   */
  onAgentSessions(start: (start: AgentSessionStart, session: AgentSessionHandle) => AgentSession | Promise<AgentSession>): Backend;
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

/** What `lithe/host/agents/didStart` says about a session Core started. */
export interface AgentSessionStart {
  /** Core's ID of the session, such as `agent-1`. */
  session: string;
  /** The `agents[].id` from the manifest. */
  agentID: string;
  /** The working directory the CLI runs in. */
  cwd: string;
  /** The CLI's own session ID to resume, or null. */
  resume: string | null;
}

/**
 * The plugin's translation of one native session. Each call waits for the
 * one before; a rejected `prompt` ends its turn as failed.
 */
export interface AgentSession {
  /** Lines the CLI wrote to standard output, without line breaks. */
  output(lines: string[]): unknown;
  /** The user's prompt for `turn`; write what the CLI expects. */
  prompt(turn: number, text: string): unknown;
  /** The user cancelled `turn`. */
  cancel?(turn: number): unknown;
  /** The user answered permission request `permission` with `option`. */
  decidePermission(turn: number, permission: string, option: string): unknown;
  /** The CLI ended; the session gets no further calls. */
  exited?(exitCode: number | null): unknown;
}

/** The host methods of one agent session. */
export interface AgentSessionHandle {
  readonly id: string;
  readonly host: Host;
  write(lines: string[], options?: HostRequestOptions): Promise<void>;
  report(events: AgentSessionEvent[], options?: HostRequestOptions): Promise<void>;
}

/** A session event, as the contract README's Native sessions lists them, such as `{ kind: 'turnEnded', turn, reason }`. */
export type AgentSessionEvent = JsonObject & { kind: string };

export interface AgentUsageParams {
  groupBy: 'day' | 'agent' | 'model';
  sinceMs?: number;
  untilMs?: number;
  utcOffsetSeconds?: number;
}

export interface AgentUsageResult extends JsonObject {
  sinceMs: number;
  untilMs: number;
  summaries: JsonObject[];
  rateLimits: JsonObject[];
}

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
  /** Details the host may add, such as `{ option }` or `{ retryAfterMilliseconds }`. */
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

/**
 * Host failure codes and the JSON-RPC number each has. The
 * `plugin.function.*` codes belong to the relay.
 */
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
  'plugin.host.languageServerUnavailable': -32022;
  'plugin.host.languageServerError': -32023;
  'plugin.host.methodNotDeclared': -32024;
  'plugin.host.toolUnresolved': -32025;
  'plugin.host.foreignContribution': -32026;
  'plugin.function.notDeclared': -32027;
  'plugin.function.notExported': -32028;
  'plugin.function.providerDisabled': -32029;
  'plugin.function.versionMismatch': -32030;
  'plugin.function.callCycle': -32065;
  'plugin.function.depthExceeded': -32066;
  'plugin.function.tooManyCalls': -32067;
  'plugin.function.payloadTooLarge': -32068;
  'plugin.function.providerUnavailable': -32069;
  'plugin.function.failed': -32070;
  'plugin.function.invalidResult': -32071;
  'plugin.host.remoteDisconnected': -32078;
  'plugin.host.platformUnavailable': -32079;
  'plugin.host.alreadyExists': -32080;
  'plugin.host.diskChanged': -32081;
}>;

/** Host request method names. */
export const HOST_METHODS: Readonly<Record<
  | 'credentialsGet' | 'credentialsSet' | 'credentialsDelete' | 'getCapabilities' | 'subscriptionsDispose'
  | 'workspaceListContexts' | 'workspaceGetContext' | 'workspaceGetFolders' | 'workspaceGetHostPaths'
  | 'workspaceReadDirectory'
  | 'workspaceStat' | 'workspaceReadFile' | 'workspaceWatch' | 'workspaceFindFiles' | 'workspaceFindText'
  | 'workspaceCreate' | 'workspaceRename' | 'workspaceCopy' | 'workspaceTrash'
  | 'documentsList' | 'documentsGetSnapshot' | 'documentsSave' | 'documentsSaveAs' | 'documentsClose'
  | 'editorRegisterActions' | 'editorGetActive'
  | 'editorGetSelections' | 'editorApplyEdits' | 'editorReplaceSelections' | 'editorInsertText'
  | 'editorOpen' | 'editorReveal' | 'previewOpenHTML' | 'browserOpenExternal'
  | 'windowShowInformation' | 'windowShowWarning' | 'windowShowError'
  | 'terminalCreate' | 'terminalShow' | 'terminalClose' | 'terminalReopen' | 'terminalDispose' | 'terminalOnExit'
  | 'functionsProviders' | 'functionsInvoke'
  | 'agentsWrite' | 'agentsReport' | 'agentsUsage',
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
  maxHostPathRoots: number;
  relayDefaultTimeoutMilliseconds: number;
  relayMaxTimeoutMilliseconds: number;
  maxParentOperationIdBytes: number;
}>;

/** A stable item in a bounded searchable native picker. */
export interface QuickPickItem {id:string;label:string;description?:string;detail?:string;picked?:boolean}
/** Exactly one saved resource or an inline read-only document. */
export type PreviewParams = ({resource:WorkspaceResource}|{id:string;title:string;text:string}) & {presentation?:'editorAndPreview'|'previewOnly';range?:TextRange};
