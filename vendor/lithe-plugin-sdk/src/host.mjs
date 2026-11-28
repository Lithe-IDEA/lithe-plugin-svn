// Host services of the plugin-function protocol: the `lithe/host/*`
// requests a backend sends to Lithe, the subscriptions some of them create,
// and the `host` object handlers use. The backend owns the wire; this module
// owns what Core expects of a well-behaved client -- at most 16 unanswered
// host requests, cancellation through `$/cancelRequest`, and subscription
// events routed by ID.
//
// Contract: contract/v1/README.md, "Plugin functions" and "Host services".

import { HostError, PluginSdkError } from './errors.mjs';
import {
  HOST_METHODS,
  isContextReference,
  isCredentialKey,
  isFunctionId,
  LIMITS,
  METHODS,
} from './protocol.mjs';

/** Events kept for a subscription whose creating request is still unanswered. */
const MAX_EARLY_EVENTS = 128;

/**
 * The session's host-request state. `transport` is the backend's wire:
 * `{ negotiated(), ready(), send(method, params) -> { id, response }, notify(method, params), log(...) }`.
 */
export class HostChannel {
  #transport;
  #inFlight = 0;
  /** Requests waiting for a free slot, in call order: `{ start, fail }`. */
  #queue = [];
  /** Live subscriptions by ID: `{ onEvent, lastSequence }`. */
  #subscriptions = new Map();
  /** Subscribing requests not yet answered; early events wait only while there are some. */
  #subscribing = 0;
  #early = [];
  #capabilities = null;
  #closed = false;

  constructor(transport) {
    this.#transport = transport;
  }

  /** Whether the host negotiated plugin functions, and with them host services, in this session. */
  get negotiated() {
    return this.#transport.negotiated();
  }

  request(method, params, { signal } = {}) {
    if (typeof method !== 'string' || !method.startsWith('lithe/host/')) {
      return Promise.reject(new PluginSdkError('sdk.host.method', `${method} is not a host method; host requests are lithe/host/*.`));
    }
    if (this.#closed || !this.#transport.ready()) {
      return Promise.reject(new PluginSdkError('sdk.session.notReady', 'The session is not initialized.'));
    }
    if (!this.negotiated) {
      // The answer Core would give, without the round trip.
      return Promise.reject(new HostError(
        'plugin.host.unavailable',
        'The host did not negotiate plugin functions (litheFunctions), which offer host services.',
        { rpcCode: -32601, method },
      ));
    }
    if (signal?.aborted) return Promise.reject(signal.reason);
    return new Promise((resolve, reject) => {
      // `queued` → `sent` → `done`; a request settles for its caller once.
      let state = 'queued';
      let id;
      const done = () => {
        state = 'done';
        signal?.removeEventListener('abort', onAbort);
      };
      const entry = {
        start: () => {
          state = 'sent';
          this.#inFlight += 1;
          const sent = this.#transport.send(method, params);
          id = sent.id;
          sent.response
            .then(
              (result) => {
                if (state === 'done') return;
                done();
                resolve(result);
              },
              (error) => {
                if (state === 'done') return;
                done();
                reject(error);
              },
            )
            .finally(() => {
              // The slot frees when Core answers, also after a cancellation:
              // Core answers a cancelled request at once.
              this.#inFlight -= 1;
              this.#drain();
            });
        },
        fail: (error) => {
          if (state === 'done') return;
          done();
          reject(error);
        },
      };
      const onAbort = () => {
        if (state === 'done') return;
        if (state === 'queued') {
          this.#queue.splice(this.#queue.indexOf(entry), 1);
        } else {
          this.#transport.notify(METHODS.cancelRequest, { id });
        }
        // A cancelled mutation may already have taken effect; it is never
        // sent again.
        done();
        reject(signal.reason);
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.#queue.push(entry);
      this.#drain();
    });
  }

  /**
   * Sends a request whose result is `{ subscriptionID }` and routes that
   * subscription's events to `onEvent(event, { subscriptionID, sequence, gap })`.
   */
  async subscribe(method, params, onEvent, options) {
    if (onEvent !== undefined && typeof onEvent !== 'function') {
      throw new TypeError('A subscription event handler must be a function.');
    }
    this.#subscribing += 1;
    try {
      const result = await this.request(method, params, options);
      const subscriptionID = result?.subscriptionID;
      if (!isCredentialKey(subscriptionID)) {
        throw new PluginSdkError('sdk.host.invalidResult', `${method} answered without a subscriptionID.`);
      }
      const subscription = { onEvent: onEvent ?? (() => {}), lastSequence: 0, live: true };
      this.#subscriptions.set(subscriptionID, subscription);
      // Events the host sent before this answer was read.
      const early = this.#early.filter((event) => event.subscriptionID === subscriptionID);
      this.#early = this.#early.filter((event) => event.subscriptionID !== subscriptionID);
      for (const event of early) this.#emit(subscriptionID, subscription, event);
      return Object.freeze({
        subscriptionID,
        get disposed() {
          return !subscription.live;
        },
        dispose: () => this.dispose(subscriptionID),
      });
    } finally {
      this.#subscribing -= 1;
      if (this.#subscribing === 0) this.#early = [];
    }
  }

  /** Stops routing a subscription's events at once and asks the host to dispose it. */
  async dispose(subscriptionID) {
    const subscription = this.#subscriptions.get(subscriptionID);
    if (subscription) subscription.live = false;
    this.#subscriptions.delete(subscriptionID);
    if (this.#closed || !this.#transport.ready()) return;
    await this.request(HOST_METHODS.subscriptionsDispose, { subscriptionID });
  }

  /** Routes one `lithe/host/subscriptions/notify`. */
  deliver({ subscriptionID, sequence, event }) {
    const subscription = this.#subscriptions.get(subscriptionID);
    if (subscription) {
      this.#emit(subscriptionID, subscription, { sequence, event });
    } else if (this.#subscribing > 0) {
      if (this.#early.length < MAX_EARLY_EVENTS) {
        this.#early.push({ subscriptionID, sequence, event });
      } else {
        this.#transport.log('Dropped an early subscription event: queue_full');
      }
    }
    // Otherwise the subscription was disposed; nothing follows a disposal.
  }

  /** The cached `getCapabilities` answer; Core answers it itself. */
  capabilities() {
    this.#capabilities ??= this.request(HOST_METHODS.getCapabilities).catch((error) => {
      this.#capabilities = null;
      throw error;
    });
    return this.#capabilities;
  }

  /** Whether this session may call `method`, from the `getCapabilities` answer. */
  async supports(method) {
    if (!this.negotiated) return false;
    const { services } = await this.capabilities();
    return Object.values(services ?? {}).some((service) => Array.isArray(service?.methods) && service.methods.includes(method));
  }

  /** Ends the channel with the session: queued requests fail, subscriptions end. */
  close() {
    this.#closed = true;
    for (const entry of this.#queue.splice(0)) {
      entry.fail(new PluginSdkError('sdk.session.closed', 'The session ended.'));
    }
    for (const subscription of this.#subscriptions.values()) subscription.live = false;
    this.#subscriptions.clear();
    this.#early = [];
    this.#capabilities = null;
  }

  #emit(subscriptionID, subscription, { sequence, event }) {
    const gap = sequence !== subscription.lastSequence + 1;
    subscription.lastSequence = sequence;
    Promise.resolve()
      .then(() => subscription.onEvent(event, { subscriptionID, sequence, gap }))
      .catch(() => this.#transport.log('A subscription listener failed: internal_error'));
  }

  #drain() {
    while (!this.#closed && this.#inFlight < LIMITS.maxPendingHostRequests && this.#queue.length > 0) {
      this.#queue.shift().start();
    }
  }
}

/**
 * The `host` object: typed host services over `channel`. A handler's
 * `context.host` passes the call's signal, so its unanswered host requests
 * are cancelled when the call ends. It also passes the `operationID` of the
 * `lithe/function/invoke` being served as `parentOperationId`, which
 * `functions.invoke` sends as the new call's parent unless the caller names
 * another. A host object without them (`backend.host`) has no default parent.
 */
export function createHost(channel, callSignal, parentOperationId) {
  const withSignal = (options = {}) => {
    if (!callSignal) return options;
    return { ...options, signal: options.signal ? AbortSignal.any([callSignal, options.signal]) : callSignal };
  };
  const request = (method, params, options) => channel.request(method, params, withSignal(options));
  const subscribe = (method, params, onEvent, options) => channel.subscribe(method, params, onEvent, withSignal(options));
  /** A method whose params name a workspace context. */
  const scoped = (method) => async (context, params = {}, options) =>
    request(method, { ...params, context: contextReference(context) }, options);
  const getHostPaths = async (context, params = {}, options) => {
    const wire = { ...params, context: contextReference(context) };
    if (params?.rootIDs !== undefined) checkRootIds(params.rootIDs);
    return hostFolders(await request(HOST_METHODS.workspaceGetHostPaths, wire, options));
  };

  return Object.freeze({
    get negotiated() {
      return channel.negotiated;
    },
    request: async (method, params, options) => request(method, params, options),
    subscribe: async (method, params, onEvent, options) => subscribe(method, params, onEvent, options),
    capabilities: () => channel.capabilities(),
    supports: (method) => channel.supports(method),
    credentials: Object.freeze({
      async get(key, options) {
        checkCredentialKey(key);
        const result = await request(HOST_METHODS.credentialsGet, { key }, options);
        if (result === null) return null;
        if (typeof result?.secret !== 'string') {
          throw new PluginSdkError('sdk.host.invalidResult', 'The host answered credentials/get without a secret.');
        }
        return result.secret;
      },
      async set(key, secret, options) {
        checkCredentialKey(key);
        if (typeof secret !== 'string' || Buffer.byteLength(secret) > LIMITS.maxCredentialSecretBytes) {
          throw new PluginSdkError('sdk.credentials.invalidSecret', 'A secret is a string of at most 16 KiB.');
        }
        await request(HOST_METHODS.credentialsSet, { key, secret }, options);
      },
      async delete(key, options) {
        checkCredentialKey(key);
        await request(HOST_METHODS.credentialsDelete, { key }, options);
      },
    }),
    subscriptions: Object.freeze({
      dispose: async (subscriptionID) => channel.dispose(subscriptionID),
    }),
    workspace: Object.freeze({
      reveal: scoped(HOST_METHODS.workspaceReveal),
      setDirectoryTypes: scoped(HOST_METHODS.workspaceSetDirectoryTypes),
      setDirectoryMarks: scoped(HOST_METHODS.workspaceSetDirectoryMarks),

      listContexts: async (options) => request(HOST_METHODS.workspaceListContexts, {}, options),
      getContext: async (context, options) =>
        request(HOST_METHODS.workspaceGetContext, { context: contextReference(context) }, options),
      getFolders: async (context, options) =>
        request(HOST_METHODS.workspaceGetFolders, { context: contextReference(context) }, options),
      getHostPaths,
      processRoots: async (context, options) => {
        const kind = context?.authority?.kind;
        if (kind === 'local') return { folders: localFolders(context.folders) };
        if (typeof kind !== 'string') {
          throw new PluginSdkError(
            'sdk.host.invalidContext',
            'processRoots takes a full context, with its authority and folders, from listContexts or getContext.',
          );
        }
        return getHostPaths(context, {}, options);
      },
      readDirectory: scoped(HOST_METHODS.workspaceReadDirectory),
      stat: scoped(HOST_METHODS.workspaceStat),
      readFile: scoped(HOST_METHODS.workspaceReadFile),
      watch: async (context, params, onEvent, options) =>
        subscribe(HOST_METHODS.workspaceWatch, { ...params, context: contextReference(context) }, onEvent, options),
      findFiles: scoped(HOST_METHODS.workspaceFindFiles),
      findText: scoped(HOST_METHODS.workspaceFindText),
      create: scoped(HOST_METHODS.workspaceCreate),
      rename: scoped(HOST_METHODS.workspaceRename),
      copy: scoped(HOST_METHODS.workspaceCopy),
      trash: scoped(HOST_METHODS.workspaceTrash),
    }),
    /**
     * Native agent sessions and usage totals (plan API-45). Core answers it;
     * `write` and `report` need `agents.native`, `usage` `agents.usage.read`.
     */
    agents: Object.freeze({
      /** Writes 1-256 lines, without line breaks, to the standard input of `session`'s CLI. */
      write: async (session, lines, options) => {
        await request(HOST_METHODS.agentsWrite, { session, lines }, options);
      },
      /** Reports 1-256 events of `session`; one refused event refuses them all. */
      report: async (session, events, options) => {
        await request(HOST_METHODS.agentsReport, { session, events }, options);
      },
      /** `{ sinceMs, untilMs, summaries, rateLimits }` for `{ groupBy, sinceMs?, untilMs?, utcOffsetSeconds? }`. */
      usage: async (params, options) => {
        const result = await request(HOST_METHODS.agentsUsage, params, options);
        if (typeof result !== 'object' || result === null || Array.isArray(result)) {
          throw new PluginSdkError('sdk.host.invalidResult', `${HOST_METHODS.agentsUsage} answered with something other than an object.`);
        }
        return result;
      },
    }),
    functions: Object.freeze({
      providers: async (functionID, options) => {
        checkRelayFunctionId(functionID);
        return request(HOST_METHODS.functionsProviders, { functionID }, options);
      },
      invoke: async (context, call, options) =>
        request(HOST_METHODS.functionsInvoke, relayInvokeParams(context, call, parentOperationId), options),
    }),
    documents: Object.freeze({
      list: scoped(HOST_METHODS.documentsList),
      getSnapshot: scoped(HOST_METHODS.documentsGetSnapshot),
      save: scoped(HOST_METHODS.documentsSave),
      saveAs: scoped(HOST_METHODS.documentsSaveAs),
      close: scoped(HOST_METHODS.documentsClose),
    }),
    editor: Object.freeze({
      showDiff: scoped(HOST_METHODS.editorShowDiff),

      getActive: scoped(HOST_METHODS.editorGetActive),
      getSelections: scoped(HOST_METHODS.editorGetSelections),
      applyEdits: scoped(HOST_METHODS.editorApplyEdits),
      replaceSelections: scoped(HOST_METHODS.editorReplaceSelections),
      insertText: scoped(HOST_METHODS.editorInsertText),
      open: scoped(HOST_METHODS.editorOpen),
      reveal: scoped(HOST_METHODS.editorReveal),
      registerActions: async (context, params, options) =>
        subscribe(HOST_METHODS.editorRegisterActions, { ...params, context: contextReference(context) }, undefined, options),
    }),
    views: Object.freeze({
      refresh: scoped(HOST_METHODS.viewsRefresh),
    }),
    output: Object.freeze({
      create: scoped(HOST_METHODS.outputCreate),
      append: scoped(HOST_METHODS.outputAppend),
      clear: scoped(HOST_METHODS.outputClear),
      show: scoped(HOST_METHODS.outputShow),
      dispose: scoped(HOST_METHODS.outputDispose),
    }),
    progress: Object.freeze({
      create: (context, params, onEvent, options) => subscribe(HOST_METHODS.progressCreate, { ...params, context: contextReference(context) }, onEvent, options),
      report: scoped(HOST_METHODS.progressReport),
      end: async (context, params, options) => {
        const result = await scoped(HOST_METHODS.progressEnd)(context, params, options);
        await channel.dispose(params.progressID);
        return result;
      },
    }),
    statusBar: Object.freeze({
      setItem: scoped(HOST_METHODS.statusBarSetItem),
      removeItem: scoped(HOST_METHODS.statusBarRemoveItem),
    }),
    clipboard: Object.freeze({
      readText: scoped(HOST_METHODS.clipboardReadText),
      writeText: scoped(HOST_METHODS.clipboardWriteText),
    }),
    network: Object.freeze({
      request: scoped(HOST_METHODS.networkRequest),
    }),
    preview: Object.freeze({
      openMarkdown: scoped(HOST_METHODS.previewOpenMarkdown),

      openHTML: scoped(HOST_METHODS.previewOpenHTML),
    }),
    browser: Object.freeze({
      openExternal: scoped(HOST_METHODS.browserOpenExternal),
    }),
    terminal: Object.freeze({
      create: scoped(HOST_METHODS.terminalCreate),
      show: scoped(HOST_METHODS.terminalShow),
      close: scoped(HOST_METHODS.terminalClose),
      reopen: scoped(HOST_METHODS.terminalReopen),
      dispose: scoped(HOST_METHODS.terminalDispose),
      onExit: async (context, terminalID, onEvent, options) =>
        subscribe(HOST_METHODS.terminalOnExit, { context: contextReference(context), terminalID }, onEvent, options),
    }),
    window: Object.freeze({
      showQuickPick: scoped(HOST_METHODS.windowShowQuickPick),
      showInputBox: scoped(HOST_METHODS.windowShowInputBox),

      showInformation: scoped(HOST_METHODS.windowShowInformation),
      showWarning: scoped(HOST_METHODS.windowShowWarning),
      showError: scoped(HOST_METHODS.windowShowError),
    }),
  });
}

/**
 * `{ contextID, generation }` of a context reference or of a full context
 * from `listContexts` or `getContext`, so either can be passed on.
 */
export function contextReference(value) {
  const reference = { contextID: value?.contextID, generation: value?.generation };
  if (!isContextReference(reference)) {
    throw new PluginSdkError(
      'sdk.host.invalidContext',
      'A context is { contextID, generation }: an ID of 1-128 ASCII letters, digits, ".", "_", ":" or "-", and a positive generation.',
    );
  }
  return reference;
}

/**
 * A path on the remote host of a `remote` workspace context, from
 * `workspace.getHostPaths`. It is not a string, so it cannot reach `fs` or
 * `path` by mistake: the machine that runs the backend has no file there.
 * `value` is the absolute POSIX path, for what runs on that host -- process
 * arguments and working directories, a debug configuration's `program` or
 * `cwd`, a language server's `initializationOptions`. `JSON.stringify`
 * writes it as that string.
 */
export class HostPath {
  #value;

  constructor(value) {
    if (!isHostPath(value)) {
      throw new TypeError('A host path is an absolute POSIX path, a string starting with "/".');
    }
    this.#value = value;
  }

  get value() {
    return this.#value;
  }

  toString() {
    return this.#value;
  }

  toJSON() {
    return this.#value;
  }
}

function isHostPath(value) {
  return typeof value === 'string' && value.startsWith('/');
}

function checkRootIds(rootIDs) {
  if (
    !Array.isArray(rootIDs) ||
    rootIDs.length === 0 ||
    rootIDs.length > LIMITS.maxHostPathRoots ||
    !rootIDs.every(isCredentialKey) ||
    new Set(rootIDs).size !== rootIDs.length
  ) {
    throw new PluginSdkError(
      'sdk.host.invalidParams',
      'rootIDs is 1-256 distinct root IDs of 1-128 ASCII letters, digits, ".", "_", ":" or "-".',
    );
  }
}

/** `{ folders: [{ rootID, hostPath }] }` of a `getHostPaths` answer, each `hostPath` a `HostPath`. */
function hostFolders(result) {
  const folders = result?.folders;
  if (!Array.isArray(folders) || !folders.every((folder) => isCredentialKey(folder?.rootID) && isHostPath(folder?.hostPath))) {
    throw new PluginSdkError(
      'sdk.host.invalidResult',
      'The host answered getHostPaths without folders of a root ID and an absolute host path.',
    );
  }
  return { folders: folders.map(({ rootID, hostPath }) => ({ rootID, hostPath: new HostPath(hostPath) })) };
}

/** `[{ rootID, path }]` of a `local` context's folders, read without asking the host. */
function localFolders(folders) {
  if (!Array.isArray(folders) || !folders.every((folder) => isCredentialKey(folder?.rootID) && typeof folder?.path === 'string')) {
    throw new PluginSdkError('sdk.host.invalidContext', "A local context's folders each carry a rootID and a path.");
  }
  return folders.map(({ rootID, path }) => ({ rootID, path }));
}

function checkCredentialKey(key) {
  if (!isCredentialKey(key)) {
    throw new PluginSdkError(
      'sdk.credentials.invalidKey',
      'A credential key is 1-128 ASCII letters, digits, ".", "_", ":" or "-".',
    );
  }
}

function invalidRelayCall(message) {
  return new PluginSdkError('sdk.functions.invalidCall', message);
}

function checkRelayFunctionId(functionID) {
  if (!isFunctionId(functionID)) {
    throw invalidRelayCall('A function ID is dot-separated lowerCamelCase segments of at most 128 bytes, such as "project.describe".');
  }
}

function isParentOperationId(value) {
  return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= LIMITS.maxParentOperationIdBytes;
}

/**
 * The params of one `lithe/host/functions/invoke`, built from the whitelisted
 * fields of `call` only, so a caller cannot add a field of its own (Core
 * refuses `caller` and writes it itself). Checks what Core checks first; a
 * mistake throws before any frame is written. `params` stays absent unless
 * given. The parent is the call's own `parentOperationID`, else the operation
 * being served (`defaultParent`), else absent.
 */
function relayInvokeParams(context, call, defaultParent) {
  if (call === null || typeof call !== 'object' || Array.isArray(call)) {
    throw invalidRelayCall('A relayed call is { pluginID, functionID, params?, timeoutMilliseconds?, parentOperationID? }.');
  }
  const { pluginID, functionID, params, timeoutMilliseconds, parentOperationID } = call;
  if (typeof pluginID !== 'string' || pluginID.length === 0) {
    throw invalidRelayCall('pluginID is the ID of the plugin that provides the function, a non-empty string.');
  }
  checkRelayFunctionId(functionID);
  const wire = { pluginID, functionID, context: contextReference(context) };
  if (params !== undefined) {
    if (params === null || typeof params !== 'object' || Array.isArray(params)) {
      throw invalidRelayCall('params are a JSON object.');
    }
    wire.params = params;
  }
  if (timeoutMilliseconds !== undefined) {
    if (!Number.isSafeInteger(timeoutMilliseconds) || timeoutMilliseconds < 1) {
      throw invalidRelayCall('timeoutMilliseconds is a positive integer.');
    }
    wire.timeoutMilliseconds = timeoutMilliseconds;
  }
  if (parentOperationID !== undefined) {
    if (!isParentOperationId(parentOperationID)) {
      throw invalidRelayCall('parentOperationID is a string of 1-128 bytes.');
    }
    wire.parentOperationID = parentOperationID;
  } else if (defaultParent !== undefined) {
    wire.parentOperationID = defaultParent;
  }
  return wire;
}
