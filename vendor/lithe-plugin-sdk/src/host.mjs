// Host services of plugin-function protocols 2 and 3: the `lithe/host/*`
// requests a backend sends to Lithe, the subscriptions some of them create,
// and the `host` object handlers use. The backend owns the wire; this module
// owns what Core expects of a well-behaved client -- at most 16 unanswered
// host requests, cancellation through `$/cancelRequest` from version 3, and
// subscription events routed by ID.
//
// Contract: contract/v1/README.md, "Host services (protocol version 2)" and
// the version 3 sections after it.

import { HostError, PluginSdkError } from './errors.mjs';
import {
  CONTEXT_VERSION,
  HOST_METHODS,
  HOST_SERVICES_VERSION,
  isContextReference,
  isCredentialKey,
  LIMITS,
  METHODS,
} from './protocol.mjs';

/** Events kept for a subscription whose creating request is still unanswered. */
const MAX_EARLY_EVENTS = 128;

const CREDENTIAL_METHODS = Object.freeze([
  HOST_METHODS.credentialsGet,
  HOST_METHODS.credentialsSet,
  HOST_METHODS.credentialsDelete,
]);

/**
 * The session's host-request state. `transport` is the backend's wire:
 * `{ version(), ready(), send(method, params) -> { id, response }, notify(method, params), log(...) }`.
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

  /** The negotiated plugin-function version, or 0 before or without one. */
  get version() {
    return this.#transport.version();
  }

  request(method, params, { signal } = {}) {
    if (typeof method !== 'string' || !method.startsWith('lithe/host/')) {
      return Promise.reject(new PluginSdkError('sdk.host.method', `${method} is not a host method; host requests are lithe/host/*.`));
    }
    if (this.#closed || !this.#transport.ready()) {
      return Promise.reject(new PluginSdkError('sdk.session.notReady', 'The session is not initialized.'));
    }
    if (this.version < HOST_SERVICES_VERSION) {
      // The answer Core would give, without the round trip.
      return Promise.reject(new HostError(
        'plugin.host.unavailable',
        'The host did not negotiate plugin-function protocol 2 or later, which offers host services.',
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
              // from version 3 Core answers it at once, before version 3 the
              // host still finishes the request.
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
        } else if (this.version >= CONTEXT_VERSION) {
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

  /** The cached `getCapabilities` answer; Core answers it itself, from version 3. */
  capabilities() {
    if (this.version < CONTEXT_VERSION) {
      return Promise.reject(new HostError(
        'plugin.host.unavailable',
        'Capability discovery needs plugin-function protocol 3.',
        { rpcCode: -32601, method: HOST_METHODS.getCapabilities },
      ));
    }
    this.#capabilities ??= this.request(HOST_METHODS.getCapabilities).catch((error) => {
      this.#capabilities = null;
      throw error;
    });
    return this.#capabilities;
  }

  /**
   * Whether this session may call `method`. From version 3 the answer comes
   * from `getCapabilities`; version 2 has no discovery, so it reports the
   * methods version 2 defines, and a missing grant still fails the request.
   */
  async supports(method) {
    if (this.version >= CONTEXT_VERSION) {
      const { services } = await this.capabilities();
      return Object.values(services ?? {}).some((service) => Array.isArray(service?.methods) && service.methods.includes(method));
    }
    return this.version >= HOST_SERVICES_VERSION && CREDENTIAL_METHODS.includes(method);
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
 * are cancelled when the call ends.
 */
export function createHost(channel, callSignal) {
  const withSignal = (options = {}) => {
    if (!callSignal) return options;
    return { ...options, signal: options.signal ? AbortSignal.any([callSignal, options.signal]) : callSignal };
  };
  const request = (method, params, options) => channel.request(method, params, withSignal(options));
  const subscribe = (method, params, onEvent, options) => channel.subscribe(method, params, onEvent, withSignal(options));
  /** A method whose params name a workspace context. */
  const scoped = (method) => async (context, params = {}, options) =>
    request(method, { ...params, context: contextReference(context) }, options);

  return Object.freeze({
    get version() {
      return channel.version;
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
      listContexts: async (options) => request(HOST_METHODS.workspaceListContexts, {}, options),
      getContext: async (context, options) =>
        request(HOST_METHODS.workspaceGetContext, { context: contextReference(context) }, options),
      getFolders: async (context, options) =>
        request(HOST_METHODS.workspaceGetFolders, { context: contextReference(context) }, options),
      readDirectory: scoped(HOST_METHODS.workspaceReadDirectory),
      stat: scoped(HOST_METHODS.workspaceStat),
      readFile: scoped(HOST_METHODS.workspaceReadFile),
      watch: async (context, params, onEvent, options) =>
        subscribe(HOST_METHODS.workspaceWatch, { ...params, context: contextReference(context) }, onEvent, options),
      findFiles: scoped(HOST_METHODS.workspaceFindFiles),
      findText: scoped(HOST_METHODS.workspaceFindText),
    }),
    documents: Object.freeze({
      list: scoped(HOST_METHODS.documentsList),
      getSnapshot: scoped(HOST_METHODS.documentsGetSnapshot),
    }),
    editor: Object.freeze({
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
    preview: Object.freeze({
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

function checkCredentialKey(key) {
  if (!isCredentialKey(key)) {
    throw new PluginSdkError(
      'sdk.credentials.invalidKey',
      'A credential key is 1-128 ASCII letters, digits, ".", "_", ":" or "-".',
    );
  }
}
