// The plugin backend session: one process the host starts from the plugin's
// manifest and talks to over stdio with the LSP base protocol. The SDK owns
// everything Lithe manages uniformly -- the lifecycle, protocol negotiation,
// cancellation, error codes, and the `lithe/*` namespace -- and leaves the
// plugin free to decide what its handlers do.
//
// Contracts: contract/v1/README.md ("Build providers", "Plugin functions",
// "Host services" and "VCS providers"), and Lithe's
// shared/contracts/vcs-provider-v1.md.

import { format } from 'node:util';
import { performance } from 'node:perf_hooks';
import { diagnostics, KNOWN_OPERATIONS, requestOperationId } from './diagnostics.mjs';
import { encodeFrame, FrameDecoder, FramingError, MALFORMED } from './framing.mjs';
import { HostError, PluginError, PluginSdkError, toResponseError } from './errors.mjs';
import { createHost, HostChannel } from './host.mjs';
import { killAllProcesses, runProcess } from './process.mjs';
import {
  BUILD_VERSION,
  BUILD_METHOD_VERSIONS,
  boundedText,
  ERROR_CODES,
  FUNCTIONS_VERSION,
  HOST_NOTIFICATIONS,
  isContextReference,
  isFunctionId,
  isReservedMethod,
  isVcsId,
  LIMITS,
  METHODS,
  VCS_OPERATIONS,
  VCS_REQUIRED_OPERATIONS,
  VCS_VERSION,
} from './protocol.mjs';

/** Canonical result format of each typed build request. */
const BUILD_FORMATS = Object.freeze({
  [METHODS.buildModel]: 'litheBuildModel',
  [METHODS.buildDependencies]: 'litheDependencies',
  [METHODS.buildDiscoverTests]: 'litheTestDiscovery',
});

/** Host notifications the SDK routes itself; see `onCommand`, `onContextsChanged`, and `host.subscribe`. */
const ROUTED_NOTIFICATIONS = Object.freeze(Object.values(HOST_NOTIFICATIONS));

/** VCS capabilities that describe the VCS rather than a request it answers. */
const VCS_TRAITS = Object.freeze(['push', 'staging']);

/**
 * Creates a backend. Declare handlers, then call `listen()`.
 *
 * @param {object} [options]
 * @param {string} [options.name] Reported as `serverInfo.name` and used as the log prefix.
 * @param {string} [options.version] Reported as `serverInfo.version`.
 * @param {object} [options.capabilities] Standard LSP server capabilities, for a
 *   backend that is also a language server. `experimental.litheBuild`,
 *   `experimental.litheFunctions`, `experimental.litheVcs`, and `experimental.litheKeymapImport` are negotiated by
 *   the SDK and cannot be set here.
 */
export function createBackend(options = {}) {
  return new Backend(options);
}

class Backend {
  #logging = false;
  #loggingReady = false;
  #earlyDiagnostics = [];
  #quietSuccess = new Set();
  #name;
  #version;
  #capabilities;
  #functions = new Map();
  #keymapProviders = new Map();
  #selectedKeymapProviders = new Set();
  #buildHandlers = new Map();
  #buildVersion = null;
  #functionsVersion = null;
  /** The declared VCS provider: `{ id, handlers: Map<method, handler>, capabilities }`. */
  #vcs = null;
  #requestHandlers = new Map();
  #notificationHandlers = new Map();
  #commandHandlers = new Map();
  #contextsHandler = null;
  #hostNotificationHandlers = new Map();
  #channel;
  #initializeHooks = [];
  #shutdownHooks = [];
  /** `idle` → `listening` → `initializing` → `ready` → `shuttingDown` → `exited`. */
  #phase = 'idle';
  #negotiated = Object.freeze({ functions: false, build: false, vcs: false });
  #initializeParams = null;
  /** Host requests being handled, by JSON-RPC ID. */
  #incoming = new Map();
  /** Requests this backend sent to the host, by JSON-RPC ID. */
  #outgoing = new Map();
  #nextRequestId = 1;
  /** Serializes register/unregister so the host sees them in call order. */
  #registrations = Promise.resolve();
  #output = null;
  #errorOutput = process.stderr;
  #finish = null;

  /** Typed build-provider handlers (`lithe/build/*`). */
  build;

  /**
   * Host services (`lithe/host/*`) of plugin-function protocols 2 and 3,
   * usable once the session is ready. A handler's `context.host` is the
   * same object bound to its call.
   */
  host;

  constructor({ name = 'lithe-plugin-backend', version, capabilities = {} } = {}) {
    const experimental = capabilities.experimental ?? {};
    if ('litheLogging' in experimental || 'litheBuild' in experimental || 'litheFunctions' in experimental || 'litheVcs' in experimental || 'litheKeymapImport' in experimental) {
      throw new PluginSdkError(
        'sdk.capabilities.reserved',
        'litheLogging, litheBuild, litheFunctions, litheVcs, and litheKeymapImport are negotiated by the SDK; declare handlers instead.',
      );
    }
    this.#name = String(name);
    this.#version = version === undefined ? undefined : String(version);
    this.#capabilities = capabilities;
    this.build = Object.freeze({
      /** Answers `lithe/build/model` with a `litheBuildModel` document. */
      model: (handler) => this.#declareBuild(METHODS.buildModel, handler),
      /** Answers `lithe/build/dependencies` with a `litheDependencies` document. */
      dependencies: (handler) => this.#declareBuild(METHODS.buildDependencies, handler),
      /** Runs a bounded task in the provider; the host owns its operation. */
      execute: (handler) => this.#declareBuild(METHODS.buildExecute, handler),
      test: (handler) => this.#declareBuild(METHODS.buildTest, handler),
      discoverTests: (handler) => this.#declareBuild(METHODS.buildDiscoverTests, handler),
      /** Prepares a plan; the application itself belongs to the host. */
      prepareRun: (handler) => this.#declareBuild(METHODS.buildPrepareRun, handler),
      prepareDebug: (handler) => this.#declareBuild(METHODS.buildPrepareDebug, handler),
    });
    this.#channel = new HostChannel({
      version: () => this.#functionsVersion ?? 0,
      ready: () => this.#phase === 'ready',
      send: (method, params) => this.#send(method, params),
      notify: (method, params) => this.#write({ jsonrpc: '2.0', method, params }),
      log: () => this.#diagnostics().degraded('notification', 'event_handler_failed'),
    });
    this.host = createHost(this.#channel);
  }

  /** Protocols the host agreed to in `initialize`; all false before it. */
  get negotiated() {
    return this.#negotiated;
  }

  /** Selected build protocol version, or null when unavailable. */
  get buildVersion() { return this.#buildVersion; }

  /** Selected plugin-function protocol version (1-3), or null when unavailable. */
  get functionsVersion() { return this.#functionsVersion; }

  /** The host's `initialize` params, or null before it arrives. */
  get initializeParams() {
    return this.#initializeParams;
  }

  /** IDs of the functions this backend currently serves, sorted. */
  get functionIDs() {
    return [...this.#functions.keys()].sort();
  }

  /**
   * Declares a plugin function offered from the start, in the `initialize`
   * answer. To add one later, use `registerFunction`.
   *
   * @param {string} id Dot-separated lowerCamelCase segments, such as `snapshot.refresh`.
   * @param {(params: object, context: object) => unknown} handler
   */
  function(id, handler) {
    if (!this.#beforeAnswer()) {
      throw new PluginSdkError('sdk.function.lateDeclaration', 'After initialize, add functions with registerFunction().');
    }
    this.#checkNewFunction(id, handler);
    this.#functions.set(id, handler);
    return this;
  }

  /** Declares an independent typed shortcut import provider. */
  keymapImportProvider(id, handler) {
    if (!this.#beforeAnswer() || !validKeymapProvider(id) || typeof handler !== 'function'
        || this.#keymapProviders.has(id) || this.#keymapProviders.size >= 8) {
      throw new PluginSdkError('sdk.keymap.invalidRegistration', 'Invalid or duplicate shortcut import provider.');
    }
    this.#keymapProviders.set(id, handler);
    return this;
  }

  /**
   * Declares the VCS this backend provides and the operations it answers,
   * before `listen()`. Each handler gets the operation's arguments plus
   * `root: { path }` and `tool: { executable } | null`, and returns the reply
   * object of shared/contracts/vcs-provider-v1.md. Declaring a handler
   * negotiates its capability; `status`, `baseContent`, `checkin`, and
   * `rollback` are required.
   *
   * @param {string} id The VCS ID of the manifest's `vcsProviders` entry, such as `svn`.
   * @param {Record<string, Function>} handlers Keyed by operation name.
   * @param {object} [traits]
   * @param {boolean} [traits.push] Check-in is local and publishing is a separate step.
   * @param {boolean} [traits.staging] Changes carry a staged/unstaged dimension.
   */
  vcs(id, handlers, traits = {}) {
    if (this.#phase !== 'idle') {
      throw new PluginSdkError('sdk.vcs.lateDeclaration', 'Declare the VCS provider before listen().');
    }
    if (this.#vcs) throw new PluginSdkError('sdk.vcs.duplicate', 'A backend provides one VCS.');
    if (!isVcsId(id)) {
      throw new PluginSdkError(
        'sdk.vcs.invalidID',
        `VCS ID ${JSON.stringify(id)} must be lowercase letters, digits, and "-", start with a letter, and be at most ${LIMITS.maxVcsIdBytes} bytes.`,
      );
    }
    if (id === 'git') throw new PluginSdkError('sdk.vcs.reserved', 'git is provided by Lithe.');
    const methods = new Map();
    const capabilities = {};
    for (const [operation, handler] of Object.entries(handlers ?? {})) {
      const declared = VCS_OPERATIONS[operation];
      if (!declared) throw new PluginSdkError('sdk.vcs.unknownOperation', `${operation} is not a VCS operation.`);
      if (typeof handler !== 'function') throw new TypeError(`The ${operation} handler must be a function.`);
      methods.set(declared.method, handler);
      capabilities[declared.capability] = VCS_VERSION;
    }
    const missing = VCS_REQUIRED_OPERATIONS.filter((operation) => !methods.has(VCS_OPERATIONS[operation].method));
    if (missing.length > 0) {
      throw new PluginSdkError('sdk.vcs.missingOperation', `A VCS provider must answer ${missing.join(', ')}.`);
    }
    for (const [trait, enabled] of Object.entries(traits)) {
      if (!VCS_TRAITS.includes(trait)) throw new PluginSdkError('sdk.vcs.unknownTrait', `${trait} is not a VCS trait.`);
      if (enabled) capabilities[trait] = VCS_VERSION;
    }
    this.#vcs = { id, methods, capabilities: sortedKeys(capabilities) };
    return this;
  }

  /** Handles a standard LSP request, for a backend that is also a language server. */
  onRequest(method, handler) {
    this.#declareHandler(this.#requestHandlers, method, handler);
    return this;
  }

  /** Handles a standard LSP notification. */
  onNotification(method, handler) {
    this.#declareHandler(this.#notificationHandlers, method, handler);
    return this;
  }

  /**
   * Handles `lithe/host/commands/didRun` for one of the plugin's commands
   * (protocol 3). The handler gets `{ commandID, workspaceContext }`, the
   * context of the window it ran in or null. It is an event: the host waits
   * for no result.
   */
  onCommand(commandID, handler) {
    if (typeof commandID !== 'string' || !/^[a-z0-9.-]{1,128}$/.test(commandID)) {
      throw new PluginSdkError('sdk.command.invalidID', `Command ID ${JSON.stringify(commandID)} must be 1-128 of [a-z0-9.-].`);
    }
    if (typeof handler !== 'function') throw new TypeError('A command handler must be a function.');
    this.#commandHandlers.set(commandID, handler);
    return this;
  }

  /**
   * Handles `lithe/host/workspace/didChangeContexts` (protocol 3) with
   * `{ revision }`; call `host.workspace.listContexts()` for the contexts.
   */
  onContextsChanged(handler) {
    if (typeof handler !== 'function') throw new TypeError('A handler must be a function.');
    this.#contextsHandler = handler;
    return this;
  }

  /**
   * Handles a `lithe/host/*` notification a later host adds. Commands,
   * context changes, and subscription events have their own APIs.
   */
  onHostNotification(method, handler) {
    if (typeof method !== 'string' || !method.startsWith('lithe/host/')) {
      throw new PluginSdkError('sdk.method.invalid', `${method} is not a host notification.`);
    }
    if (ROUTED_NOTIFICATIONS.includes(method)) {
      throw new PluginSdkError('sdk.method.reserved', `${method} is routed by the SDK; use onCommand, onContextsChanged, or host.subscribe.`);
    }
    if (typeof handler !== 'function') throw new TypeError('A handler must be a function.');
    this.#hostNotificationHandlers.set(method, handler);
    return this;
  }

  /** Runs before the `initialize` answer, with `{ params, negotiated }`. */
  onInitialize(hook) {
    this.#initializeHooks.push(hook);
    return this;
  }

  /** Runs on `shutdown`, after running calls were cancelled. */
  onShutdown(hook) {
    this.#shutdownHooks.push(hook);
    return this;
  }

  /**
   * Adds a function. Before the `initialize` answer (including from an
   * `onInitialize` hook) it joins the initial list; afterwards the host must
   * accept it first.
   */
  registerFunction(id, handler) {
    if (this.#beforeAnswer()) {
      return settle(() => {
        this.#checkNewFunction(id, handler);
        this.#functions.set(id, handler);
      });
    }
    return this.#queueRegistration(async () => {
      this.#requireFunctions();
      this.#checkNewFunction(id, handler);
      // Installed before the request: the host may invoke it as soon as its
      // registry changed, before this backend reads the reply.
      this.#functions.set(id, handler);
      try {
        await this.#request(METHODS.functionRegister, { functions: [{ id }] });
      } catch (error) {
        this.#functions.delete(id);
        this.#quietSuccess.delete(id);
        throw error;
      }
    });
  }

  /** Withdraws a function. The host ends its running calls as revoked. */
  unregisterFunction(id) {
    if (this.#beforeAnswer()) {
      return settle(() => {
        if (!this.#functions.delete(id)) {
          throw new PluginSdkError('sdk.function.unknown', `Function ${id} is not registered.`);
        }
        this.#quietSuccess.delete(id);
      });
    }
    return this.#queueRegistration(async () => {
      this.#requireFunctions();
      if (!this.#functions.has(id)) {
        throw new PluginSdkError('sdk.function.unknown', `Function ${id} is not registered.`);
      }
      await this.#request(METHODS.functionUnregister, { ids: [id] });
      this.#functions.delete(id);
      this.#quietSuccess.delete(id);
      for (const call of this.#incoming.values()) {
        if (call.functionID === id) call.controller.abort();
      }
    });
  }

  /** Sends a standard LSP request to the host. `lithe/*` methods are reserved. */
  sendRequest(method, params) {
    this.#checkOutgoing(method);
    return this.#request(method, params);
  }

  /** Sends a standard LSP notification to the host. `lithe/*` methods are reserved. */
  sendNotification(method, params) {
    this.#checkOutgoing(method);
    this.#write({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) });
  }

  get diagnostics() { return this.#diagnostics(); }

  suppressSuccessDiagnostics(operation) {
    if (!KNOWN_OPERATIONS.has(operation) && !this.#functions.has(operation)) throw new PluginSdkError('sdk.logging.invalidOperation', 'Suppress a registered operation.');
    this.#quietSuccess.add(operation);
    return this;
  }

  #diagnostics(operationId) {
    return diagnostics((params) => {
      if (!this.#logging) return;
      if (!this.#loggingReady) { if (this.#earlyDiagnostics.length < 8) this.#earlyDiagnostics.push(params); return; }
      this.#write({ jsonrpc: '2.0', method: 'lithe/log', params });
    }, (id) => this.#functions.has(id), operationId);
  }

  /**
   * Serves the host until it sends `exit` or closes the input stream, and
   * resolves with the process exit code. With the default `exit`, the process
   * then exits with that code.
   *
   * @param {object} [io]
   * @param {NodeJS.ReadableStream} [io.input] Defaults to stdin.
   * @param {NodeJS.WritableStream} [io.output] Defaults to stdout.
   * @param {NodeJS.WritableStream} [io.errorOutput] Defaults to stderr.
   * @param {((code: number) => void) | null} [io.exit] Defaults to `process.exit`; null only resolves.
   */
  listen({ input = process.stdin, output = process.stdout, errorOutput = process.stderr, exit = (code) => process.exit(code) } = {}) {
    if (this.#phase !== 'idle') {
      throw new PluginSdkError('sdk.listen.repeated', 'A backend listens once.');
    }
    this.#phase = 'listening';
    this.#output = output;
    this.#errorOutput = errorOutput;
    if (output === process.stdout) redirectConsole(errorOutput);

    return new Promise((resolve) => {
      this.#finish = (code) => {
        if (this.#phase === 'exited') return;
        this.#phase = 'exited';
        this.#abortAll();
        killAllProcesses();
        // Before the pending requests fail, so a freed slot starts nothing.
        this.#channel.close();
        for (const pending of this.#outgoing.values()) {
          pending.reject(new PluginSdkError('sdk.session.closed', 'The session ended.'));
        }
        this.#outgoing.clear();
        input.off?.('data', onData);
        resolve(code);
        exit?.(code);
      };
      const decoder = new FrameDecoder();
      const onData = (chunk) => {
        let messages;
        try {
          messages = decoder.push(chunk);
        } catch (error) {
          if (!(error instanceof FramingError)) throw error;
          this.#diagnostics().terminal('notification', {code:'framing_error'}, 0);
          this.#finish(1);
          return;
        }
        for (const message of messages) this.#dispatch(message);
      };
      input.on('data', onData);
      input.once('end', () => this.#finish(this.#phase === 'shuttingDown' ? 0 : 1));
      input.once('error', () => this.#finish(1));
    });
  }

  #dispatch(message) {
    if (message === MALFORMED) {
      this.#respond(null, undefined, { code: ERROR_CODES.parseError, message: 'The message is not valid JSON.' });
      return;
    }
    // Valid JSON that is not a message object, such as `null` or a batch.
    if (typeof message !== 'object' || message === null || Array.isArray(message)) {
      this.#respond(null, undefined, { code: ERROR_CODES.invalidRequest, message: 'The message is not a JSON-RPC object.' });
      return;
    }
    const hasID = message.id !== undefined && message.id !== null;
    if (typeof message.method !== 'string') {
      if (hasID) this.#settleOutgoing(message);
      return;
    }
    if (hasID) {
      this.#handleRequest(message);
    } else {
      this.#handleNotification(message);
    }
  }

  #handleRequest({ id, method, params }) {
    if (method === METHODS.initialize) {
      void this.#initialize(id, params ?? {});
      return;
    }
    if (method === METHODS.shutdown) {
      void this.#shutdown(id);
      return;
    }
    if (this.#phase === 'listening' || this.#phase === 'initializing') {
      this.#respond(id, undefined, { code: ERROR_CODES.serverNotInitialized, message: 'The backend is not initialized.' });
      return;
    }
    if (this.#phase !== 'ready') {
      this.#respond(id, undefined, { code: ERROR_CODES.invalidRequest, message: 'The backend is shutting down.' });
      return;
    }
    if (method === METHODS.functionInvoke) {
      this.#invokeFunction(id, params ?? {});
      return;
    }
    if (method === 'lithe/keymap/import') {
      this.#invokeKeymap(id, params);
      return;
    }
    const build = this.#buildHandlers.get(method);
    if (build && this.#buildVersion >= BUILD_METHOD_VERSIONS[method]) {
      this.#invokeBuild(id, method, params ?? {}, build);
      return;
    }
    const vcs = this.#negotiated.vcs ? this.#vcs.methods.get(method) : undefined;
    if (vcs) {
      this.#run(id, null, (context) => vcs(params ?? {}, this.#vcsContext(context)), (result) => vcsResult(method, result), undefined, method, params?.operationID);
      return;
    }
    const handler = this.#requestHandlers.get(method);
    if (handler) {
      this.#run(id, null, (context) => handler(params, context), (result) => result ?? null);
      return;
    }
    this.#respond(id, undefined, { code: ERROR_CODES.methodNotFound, message: `Unsupported method: ${method}` });
  }

  #handleNotification({ method, params }) {
    if (method === METHODS.exit) {
      this.#finish(this.#phase === 'shuttingDown' ? 0 : 1);
      return;
    }
    if (method === METHODS.cancelRequest) {
      this.#incoming.get(requestKey(params?.id))?.controller.abort();
      return;
    }
    if (this.#phase !== 'ready' || method === METHODS.initialized) return;
    if (typeof method === 'string' && method.startsWith('lithe/host/')) {
      this.#hostNotification(method, params);
      return;
    }
    const handler = this.#notificationHandlers.get(method);
    if (!handler) return;
    Promise.resolve()
      .then(() => handler(params))
      .catch((error) => this.#diagnostics().terminal('notification', { code: failureKind(error) }, 0));
  }

  /**
   * Routes a host notification. Core checked its shape and the session's
   * grant; one this SDK does not know is ignored, as the contract asks.
   */
  #hostNotification(method, params) {
    if ((this.#functionsVersion ?? 0) < 3 || !isObject(params)) return;
    if (method === HOST_NOTIFICATIONS.subscriptionNotify) {
      this.#channel.deliver(params);
      return;
    }
    let handler;
    let event = params;
    if (method === HOST_NOTIFICATIONS.commandDidRun) {
      handler = this.#commandHandlers.get(params.commandID);
      event = { commandID: params.commandID, workspaceContext: isContextReference(params.context) ? params.context : null };
      if (!handler) {
        this.#diagnostics().degraded('notification', 'command_unhandled');
        return;
      }
    } else if (method === HOST_NOTIFICATIONS.didChangeContexts) {
      handler = this.#contextsHandler;
    } else {
      handler = this.#hostNotificationHandlers.get(method);
    }
    if (!handler) return;
    Promise.resolve()
      .then(() => handler(event))
      .catch((error) => this.#diagnostics().terminal('notification', { code: failureKind(error) }, 0));
  }

  async #initialize(id, params) {
    if (this.#phase !== 'listening') {
      this.#respond(id, undefined, { code: ERROR_CODES.invalidRequest, message: 'initialize was already received.' });
      return;
    }
    this.#phase = 'initializing';
    this.#initializeParams = params;
    const offered = params.capabilities?.experimental ?? {};
    this.#loggingReady = false;
    this.#earlyDiagnostics = [];
    this.#logging = offered.litheLogging?.versions?.includes(1) === true;
    if (!this.#logging) {
      this.#phase = 'listening';
      this.#respond(id, undefined, { code: ERROR_CODES.invalidRequest, message: 'The backend requires litheLogging version 1.' });
      return;
    }
    const offers = (entry, version) => Array.isArray(entry?.versions) && entry.versions.includes(version);
    const highest = (entry, latest) => Array.from({ length: latest }, (_, index) => latest - index)
      .find((version) => offers(entry, version)) ?? null;
    this.#buildVersion = this.#buildHandlers.size > 0 ? highest(offered.litheBuild, BUILD_VERSION) : null;
    this.#functionsVersion = highest(offered.litheFunctions, FUNCTIONS_VERSION);
    this.#negotiated = Object.freeze({
      functions: this.#functionsVersion !== null,
      build: this.#buildVersion !== null,
      vcs: this.#vcs !== null && offers(offered.litheVcs, VCS_VERSION),
    });
    try {
      for (const hook of this.#initializeHooks) {
        await hook({ params, negotiated: this.#negotiated });
      }
    } catch (error) {
      if (this.#phase === 'initializing') this.#phase = 'listening';
      this.#respond(id, undefined, toResponseError(error));
      return;
    }
    // A shutdown or exit that arrived while a hook ran ended the session;
    // finishing initialize must not reopen it.
    if (this.#phase !== 'initializing') {
      this.#respond(id, undefined, { code: ERROR_CODES.invalidRequest, message: 'The session ended during initialize.' });
      return;
    }
    if (!this.#negotiated.functions && this.#functions.size > 0) {
      this.#diagnostics().degraded('initialize', 'functions_unavailable');
    }
    const experimental = { ...(this.#capabilities.experimental ?? {}), litheLogging: { version: 1 } };
    if (offers(offered.litheKeymapImport, 1) && Array.isArray(offered.litheKeymapImport?.providers)
        && offered.litheKeymapImport.providers.length <= 8) {
      this.#selectedKeymapProviders = new Set(offered.litheKeymapImport.providers.filter((id) => this.#keymapProviders.has(id)));
      if (this.#selectedKeymapProviders.size) {
        experimental.litheKeymapImport = { version: 1, providers: [...this.#selectedKeymapProviders].sort() };
      }
    }
    if (this.#negotiated.build) experimental.litheBuild = { version: this.#buildVersion };
    if (this.#negotiated.vcs) {
      experimental.litheVcs = { version: VCS_VERSION, vcs: this.#vcs.id, capabilities: this.#vcs.capabilities };
    } else if (this.#vcs) {
      this.#diagnostics().degraded('initialize', 'vcs_unavailable');
    }
    if (this.#negotiated.functions) {
      experimental.litheFunctions = {
        version: this.#functionsVersion,
        functions: this.functionIDs.map((functionID) => ({ id: functionID })),
      };
    }
    this.#phase = 'ready';
    this.#respond(id, {
      capabilities: { ...this.#capabilities, experimental },
      serverInfo: { name: this.#name, ...(this.#version ? { version: this.#version } : {}) },
    });
    this.#loggingReady = true;
    for (const params of this.#earlyDiagnostics.splice(0)) this.#write({ jsonrpc: '2.0', method: 'lithe/log', params });
  }

  async #shutdown(id) {
    if (this.#phase !== 'ready' && this.#phase !== 'listening' && this.#phase !== 'initializing') {
      this.#respond(id, undefined, { code: ERROR_CODES.invalidRequest, message: 'shutdown was already received.' });
      return;
    }
    this.#phase = 'shuttingDown';
    this.#abortAll();
    for (const hook of this.#shutdownHooks) {
      try {
        await hook();
      } catch (error) {
        this.#diagnostics().terminal('shutdown', { code: failureKind(error) }, 0);
      }
    }
    killAllProcesses();
    this.#respond(id, null);
  }

  #invokeBuild(id, method, params, handler) {
    if (Object.hasOwn(params ?? {}, 'modelInputs') && this.#buildVersion < 6) {
      this.#respond(id, undefined, { code: ERROR_CODES.invalidParams, message: 'Model inputs require build protocol 6.' });
      return;
    }
    const progressing = [METHODS.buildExecute, METHODS.buildTest, METHODS.buildPrepareRun, METHODS.buildPrepareDebug].includes(method);
    if (!params || typeof params !== 'object' || Array.isArray(params)
        || (progressing && typeof params.operationID !== 'string')) {
      this.#respond(id, undefined, { code: ERROR_CODES.invalidParams, message: 'A build request needs object params and its wire operationID.' });
      return;
    }
    const operationID = params.operationID;
    let reporting = true;
    this.#run(id, null, (context) => handler(params, progressing ? {
      ...context,
      operationID,
      progress: ({ message, percentage, output } = {}) => {
        if (!reporting || context.signal.aborted) return;
        const report = { operationID };
        if (message !== undefined) report.message = boundedText(message, LIMITS.maxBuildMessageBytes);
        if (output !== undefined) report.output = boundedText(output, LIMITS.maxBuildOutputBytes);
        if (Number.isFinite(percentage)) report.percentage = Math.min(100, Math.max(0, Math.round(percentage)));
        this.#write({ jsonrpc: '2.0', method: METHODS.buildProgress, params: report });
      },
    } : context), (result) => buildResult(method, result), () => { reporting = false; }, method, operationID);
  }

  #invokeKeymap(id, params) {
    if (!isObject(params) || Object.keys(params).length !== 2 || !validKeymapProvider(params.providerID)
        || !validSnapshotToken(params.snapshotID) || !this.#selectedKeymapProviders.has(params.providerID)) {
      this.#respond(id, undefined, { code: ERROR_CODES.invalidParams, message: 'Invalid shortcut import request.' });
      return;
    }
    const handler = this.#keymapProviders.get(params.providerID);
    this.#run(id, null, (context) => handler(keymapSnapshot(params, context.host), context), functionResult, undefined, 'lithe/keymap/import');
  }

  #invokeFunction(id, { functionID, operationID, params, context: workspaceContext }) {
    const handler = this.#negotiated.functions ? this.#functions.get(functionID) : undefined;
    if (!handler) {
      this.#respond(id, undefined, { code: ERROR_CODES.invalidParams, message: `Function ${functionID} is not registered.` });
      return;
    }
    let reporting = true;
    const progress = ({ message, percentage } = {}) => {
      if (!reporting) return;
      const report = { operationID };
      if (message !== undefined) report.message = boundedText(message);
      if (Number.isFinite(percentage)) report.percentage = Math.min(100, Math.max(0, Math.round(percentage)));
      this.#write({ jsonrpc: '2.0', method: METHODS.functionProgress, params: report });
    };
    this.#run(
      id,
      functionID,
      (context) => handler(params ?? {}, {
        ...context,
        functionID,
        operationID,
        // The page's window, from protocol 3; null for a call without one.
        workspaceContext: isContextReference(workspaceContext) ? workspaceContext : null,
        progress,
      }),
      functionResult,
      () => {
        reporting = false;
      },
      functionID,
      operationID,
    );
  }

  /** Runs one handler with its own cancellation and answers exactly once. */
  #run(id, functionID, invoke, shape, onSettled, operation = functionID ?? 'function-call', operationId) {
    const started = performance.now();
    const diagnostic = this.#diagnostics(requestOperationId(operationId, id));
    let quietSuccess = false;
    const controller = new AbortController();
    const key = requestKey(id);
    this.#incoming.set(key, { controller, functionID });
    const { signal } = controller;
    const context = {
      signal,
      diagnostics: diagnostic,
      suppressSuccessDiagnostics: () => { quietSuccess = true; },
      throwIfCancelled: () => signal.throwIfAborted(),
      run: (command, args, options = {}) => {
        const running = runProcess(command, args, {
          ...options,
          signal: options.signal ? AbortSignal.any([signal, options.signal]) : signal,
        });
        // A tool the handler did not await is stopped when the call ends; its
        // rejection then must not end the backend as an unhandled rejection.
        running.catch(() => {});
        return running;
      },
      host: createHost(this.#channel, signal),
    };
    Promise.resolve()
      .then(() => invoke(context))
      .then(
        (value) => {
          signal.throwIfAborted();
          return { result: shape(value) };
        },
        (error) => {
          return { error: toResponseError(error, signal) };
        },
      )
      .catch((error) => {
        // Shaping the result failed, for example a build result in another format.
        return { error: toResponseError(error, signal) };
      })
      .then(({ result, error }) => {
        if (!signal.aborted && (error || (!quietSuccess && !this.#quietSuccess.has(operation)))) diagnostic.terminal(operation, error ? { code: error.data?.code ?? 'internal_error' } : null, performance.now() - started);
        onSettled?.();
        this.#incoming.delete(key);
        // Work belongs to its call: tools still running when the handler
        // settled, such as the siblings of a failed `Promise.all`, end now.
        // Other calls have their own controllers and keep running.
        controller.abort(new PluginSdkError('sdk.call.ended', 'The call ended.'));
        this.#respond(id, result, error);
      });
  }

  /**
   * The request context of a VCS handler. Its `run` reports every finished
   * command to the host as `lithe/vcs/execution`, for the project console,
   * unless the call passes `report: false`. Arguments are reported as given,
   * so they must never carry a credential.
   */
  #vcsContext(context) {
    const report = (command, args, started, outcome) => {
      const params = {
        command: [String(command), ...args.map(String)],
        exitCode: outcome.exitCode ?? null,
        durationMilliseconds: Math.max(0, Math.round(performance.now() - started)),
        stderr: boundedText(outcome.stderr ?? '', LIMITS.maxExecutionErrorOutputBytes),
      };
      this.#write({ jsonrpc: '2.0', method: METHODS.vcsExecution, params });
    };
    return {
      ...context,
      run: (command, args = [], { report: reporting = true, ...options } = {}) => {
        const started = performance.now();
        const running = context.run(command, args, options);
        if (!reporting) return running;
        const reported = running.then(
          (result) => {
            report(command, args, started, result);
            return result;
          },
          (error) => {
            if (!context.signal.aborted) report(command, args, started, { exitCode: null, stderr: error?.message });
            throw error;
          },
        );
        reported.catch(() => {});
        return reported;
      },
    };
  }

  #declareBuild(method, handler) {
    if (this.#phase !== 'idle') {
      throw new PluginSdkError('sdk.build.lateDeclaration', 'Declare build handlers before listen().');
    }
    if (typeof handler !== 'function') throw new TypeError('A build handler must be a function.');
    this.#buildHandlers.set(method, handler);
    return this;
  }

  #declareHandler(handlers, method, handler) {
    if (typeof method !== 'string' || isReservedMethod(method)) {
      throw new PluginSdkError('sdk.method.reserved', `${method} is managed by the SDK and Lithe.`);
    }
    if (typeof handler !== 'function') throw new TypeError('A handler must be a function.');
    handlers.set(method, handler);
  }

  #checkNewFunction(id, handler) {
    if (!isFunctionId(id)) {
      throw new PluginSdkError(
        'sdk.function.invalidID',
        `Function ID ${JSON.stringify(id)} must be dot-separated lowerCamelCase segments of at most 128 bytes.`,
      );
    }
    if (typeof handler !== 'function') throw new TypeError('A function handler must be a function.');
    if (this.#functions.has(id)) {
      throw new PluginSdkError('sdk.function.duplicate', `Function ${id} is already declared.`);
    }
    if (this.#functions.size >= LIMITS.maxFunctions) {
      throw new PluginSdkError('sdk.function.limit', `A backend serves at most ${LIMITS.maxFunctions} functions.`);
    }
  }

  /** True until the `initialize` answer fixes the initial function list. */
  #beforeAnswer() {
    return this.#phase === 'idle' || this.#phase === 'listening' || this.#phase === 'initializing';
  }

  #requireFunctions() {
    if (this.#phase !== 'ready' || !this.#negotiated.functions) {
      throw new PluginSdkError('sdk.functions.unavailable', 'The host has not negotiated plugin functions.');
    }
  }

  #queueRegistration(change) {
    const next = this.#registrations.then(change);
    this.#registrations = next.catch(() => {});
    return next;
  }

  #checkOutgoing(method) {
    if (typeof method !== 'string' || isReservedMethod(method)) {
      throw new PluginSdkError(
        'sdk.method.reserved',
        `${method} is reserved. A backend never asks the host to run a domain operation or a function.`,
      );
    }
    if (this.#phase !== 'ready') {
      throw new PluginSdkError('sdk.session.notReady', 'The session is not initialized.');
    }
  }

  #request(method, params) {
    return this.#send(method, params).response;
  }

  /** Writes a request to the host; `response` settles with its answer. */
  #send(method, params) {
    const id = `sdk-${this.#nextRequestId++}`;
    const response = new Promise((resolve, reject) => {
      this.#outgoing.set(id, { resolve, reject, method });
      this.#write({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });
    });
    return { id, response };
  }

  #settleOutgoing({ id, result, error }) {
    const pending = this.#outgoing.get(id);
    if (!pending) return;
    this.#outgoing.delete(id);
    if (error) {
      pending.reject(HostError.fromResponse(pending.method, error));
    } else {
      pending.resolve(result ?? null);
    }
  }

  #abortAll() {
    for (const call of this.#incoming.values()) call.controller.abort();
  }

  #respond(id, result, error) {
    if (this.#phase === 'exited') return;
    try {
      this.#write(error ? { jsonrpc: '2.0', id, error } : { jsonrpc: '2.0', id, result: result ?? null });
    } catch (failure) {
      // A result JSON cannot encode, such as a BigInt or a cycle, must not
      // become an unhandled rejection that ends the whole session.
      this.#diagnostics().terminal('result-encoding', { code: 'result_encoding_failed' }, 0);
      this.#write({ jsonrpc: '2.0', id, error: toResponseError(failure) });
    }
  }

  #write(message) {
    if (!this.#output || this.#phase === 'exited') return;
    this.#output.write(encodeFrame(message));
  }
}

// Errors can include request bodies, credentials and paths. Only the category
// crosses the diagnostic boundary; the response keeps its existing error contract.
function failureKind(error) {
  return error instanceof PluginError ? 'plugin_error' : 'internal_error';
}

/** Runs `change` now and reports its outcome as a promise. */
function settle(change) {
  try {
    change();
    return Promise.resolve();
  } catch (error) {
    return Promise.reject(error);
  }
}

/** The JSON-RPC ID as a map key; numbers and strings never collide. */
function requestKey(id) {
  return `${typeof id}:${id}`;
}

/**
 * Stamps the canonical format on a build result, so a handler can return the
 * plain document. A result in another format is a backend bug: Core would
 * refuse it as `plugin.build.invalidOutput`, so it fails here with a clear log.
 */
function buildResult(method, result) {
  const expected = BUILD_FORMATS[method];
  if (!isObject(result)) {
    throw new PluginSdkError('sdk.build.invalidResult', `${method} must return a reply object.`);
  }
  let document = result;
  if (expected) {
    if (result.format !== undefined && result.format !== expected) {
      throw new PluginSdkError('sdk.build.invalidResult', `${method} returned format ${result.format}, not ${expected}.`);
    }
    if (result.version !== undefined && result.version !== 1) {
      throw new PluginSdkError('sdk.build.invalidResult', `${method} returned version ${result.version}, not 1.`);
    }
    document = { ...result, format: expected, version: 1 };
  }
  if ([METHODS.buildExecute, METHODS.buildTest].includes(method)
      && (!Number.isInteger(result.exitCode) || result.exitCode < -2147483648 || result.exitCode > 2147483647
        || typeof result.output !== 'string' || Buffer.byteLength(result.output) > LIMITS.maxBuildResultBytes)) {
    throw new PluginSdkError('sdk.build.invalidResult', `${method} needs an int32 exitCode and bounded output.`);
  }
  if (method === METHODS.buildPrepareRun
      && (!isObject(result.executable) || !['toolchain', 'command'].includes(result.executable.kind)
        || typeof result.executable.value !== 'string' || typeof result.workingDirectory !== 'string'
        || !Array.isArray(result.arguments) || !result.arguments.every((value) => typeof value === 'string')
        || !isObject(result.environment) || !Object.values(result.environment).every((value) => typeof value === 'string'))) {
    throw new PluginSdkError('sdk.build.invalidResult', `${method} needs a portable launch plan.`);
  }
  if (method === METHODS.buildPrepareDebug
      && (typeof result.program !== 'string' || typeof result.workingDirectory !== 'string'
        || !Array.isArray(result.arguments) || !result.arguments.every((value) => typeof value === 'string')
        || !isObject(result.environment) || !Object.values(result.environment).every((value) => typeof value === 'string')
        || Object.keys(result).some((key) => !['program', 'arguments', 'workingDirectory', 'environment'].includes(key)))) {
    throw new PluginSdkError('sdk.build.invalidResult', `${method} needs native debug target facts, without an adapter or DAP arguments.`);
  }
  // Workspace containment and domain facts remain Core/provider responsibilities.
  if (Buffer.byteLength(JSON.stringify(document)) > LIMITS.maxBuildResultBytes) {
    throw new PluginSdkError('sdk.build.invalidResult', `${method} exceeds the build-result size limit.`);
  }
  return document;
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validKeymapProvider(id) {
  return typeof id === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(id);
}

function validSnapshotToken(id) {
  return typeof id === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(id);
}

function keymapSnapshot({ providerID, snapshotID }, host) {
  const scope = { providerID, snapshotID };
  const invalid = () => new PluginSdkError('sdk.keymap.invalidResponse', 'Invalid shortcut source response.');
  return Object.freeze({
    providerID, snapshotID,
    async listInputs() {
      const result = await host.request('lithe/host/keymapImport/listInputs', scope);
      if (!Array.isArray(result?.files) || result.files.length > 128 || result.files.some((file) =>
        !validSnapshotToken(file?.id) || typeof file.path !== 'string' || !file.path || Buffer.byteLength(file.path) > 4096
        || !Number.isSafeInteger(file.byteCount) || file.byteCount < 0 || file.byteCount > 1048576)) throw invalid();
      return result.files.map(({ id, path, byteCount }) => ({ id, path, byteCount }));
    },
    async readChunk(fileID, offset, maximumBytes) {
      if (!validSnapshotToken(fileID) || !Number.isSafeInteger(offset) || offset < 0 || offset > 1048576
          || !Number.isInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > 131072) throw invalid();
      const result = await host.request('lithe/host/keymapImport/readChunk', { ...scope, fileID, offset, maximumBytes });
      if (typeof result?.data !== 'string' || result.data.length > 174764) throw invalid();
      const bytes = Buffer.from(result.data, 'base64');
      if (bytes.length > maximumBytes || bytes.toString('base64') !== result.data) throw invalid();
      return bytes;
    },
  });
}

/**
 * A VCS reply must be a JSON object; Core validates its fields and refuses
 * anything else as `plugin.vcs.invalidOutput`, so it fails here with a log.
 */
function vcsResult(method, result) {
  if (result === undefined) return {};
  if (result === null || typeof result !== 'object' || Array.isArray(result)) {
    throw new PluginSdkError('sdk.vcs.invalidResult', `${method} must return a reply object.`);
  }
  return result;
}

/** A copy of `object` with its keys sorted, for a stable `initialize` answer. */
function sortedKeys(object) {
  return Object.fromEntries(Object.entries(object).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)));
}

/**
 * A function result as the JSON value Core accepts. A value JSON cannot
 * encode, or one over Core's 1 MiB limit, fails here as a backend bug with a
 * log line, instead of breaking the response frame or being refused by Core.
 */
function functionResult(result) {
  let encoded;
  try {
    encoded = JSON.stringify(result ?? null);
  } catch (error) {
    throw new PluginSdkError('sdk.function.invalidResult', `The result is not JSON: ${error.message}`);
  }
  if (encoded === undefined) {
    throw new PluginSdkError('sdk.function.invalidResult', 'The result is not a JSON value.');
  }
  if (Buffer.byteLength(encoded) > LIMITS.maxResultBytes) {
    throw new PluginSdkError('sdk.function.invalidResult', `The result exceeds ${LIMITS.maxResultBytes} bytes.`);
  }
  return result ?? null;
}

/**
 * Sends `console.log`, `info`, and `debug` to stderr. Stdout carries the
 * protocol; a stray line there would corrupt the stream and end the session.
 */
function redirectConsole(errorOutput) {
  const write = (...parts) => errorOutput.write(`${format(...parts)}\n`);
  console.log = write;
  console.info = write;
  console.debug = write;
}
