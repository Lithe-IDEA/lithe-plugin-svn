import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { repository, verifySdk } from '../../scripts/verify-sdk.mjs';

export const integration = process.env.LITHE_SVN_INTEGRATION === '1';
export const integrationSkip = integration ? false : 'Prepare Core and set LITHE_SVN_INTEGRATION=1 for integration tests.';
const binary = join(repository, '.artifacts/core-target/debug/examples/svn-plugin-harness');
/** Bound for one Core request; event waits ask Core for at most a second. */
const REQUEST_TIMEOUT = 10_000;
/** Bound for waiting on one provider event. */
export const EVENT_TIMEOUT = 20_000;

let verified;
async function verifyPreparedCore() {
  await verifySdk();
  const lock = JSON.parse(await readFile(join(repository, 'sdk.lock.json'), 'utf8'));
  const prepared = JSON.parse(await readFile(join(repository, '.artifacts/core-target/prepared.json'), 'utf8'));
  const digest = async (path) => createHash('sha256').update(await readFile(path)).digest('hex');
  assert.equal(prepared.revision, lock.source.revision, 'Run node scripts/prepare-core.mjs after updating the SDK.');
  assert.equal(prepared.harnessSha256, await digest(join(repository, 'test/core-harness.rs')));
  assert.equal(prepared.binarySha256, await digest(binary), 'Core bridge changed after preparation.');
}

/**
 * One Core process for one test, reached through its public JSON API.
 * Provider sessions live inside it, so it stays up for the whole test; each
 * request is answered within REQUEST_TIMEOUT. The test's `after` hook stops
 * every session it started and then the process, also when an assertion
 * failed halfway.
 */
export class Core {
  static async start(t) {
    await (verified ??= verifyPreparedCore());
    const core = new Core(spawn(binary, [], { stdio: ['pipe', 'pipe', 'pipe'] }));
    t.after(() => core.close());
    return core;
  }

  constructor(child) {
    this.child = child;
    this.waiting = [];
    this.sessions = new Set();
    this.stderr = '';
    this.exited = new Promise((resolve) => child.once('exit', resolve));
    child.stderr.setEncoding('utf8').on('data', (chunk) => {
      this.stderr = (this.stderr + chunk).slice(-16384);
    });
    createInterface({ input: child.stdout }).on('line', (line) => this.waiting.shift()?.resolve(line));
    child.once('exit', () => {
      for (const request of this.waiting.splice(0)) request.reject(new Error(`Core exited: ${this.stderr}`));
    });
    // A write after an exit is reported through the waiting request instead.
    child.stdin.on('error', () => {});
  }

  /** The raw response to one request. */
  async execute(command, payload) {
    const line = await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Core did not answer ${command} within ${REQUEST_TIMEOUT} ms`)),
        REQUEST_TIMEOUT,
      );
      // A late answer still takes this slot, so later answers stay in order.
      this.waiting.push({
        resolve: (value) => (clearTimeout(timer), resolve(value)),
        reject: (error) => (clearTimeout(timer), reject(error)),
      });
      this.child.stdin.write(`${JSON.stringify({ id: `svn-${command}`, command, payload })}\n`);
    });
    return JSON.parse(line);
  }

  /** The data of a request that must succeed. */
  async call(command, payload) {
    const response = await this.execute(command, payload);
    assert.equal(response.ok, true, `${command} failed: ${JSON.stringify(response)}`);
    return response.data;
  }

  /** Starts a provider session as the host does and waits until it is ready. */
  async startSession({ providerId, pluginId, executable, arguments: args, workspace, environment = {} }) {
    const started = await this.call('lsp.startServer', {
      providerId,
      pluginId,
      executablePath: executable,
      arguments: args,
      environment,
      // Directory URI with a trailing slash, as the macOS host sends it.
      rootUri: `file://${workspace}/`,
      workingDirectory: workspace,
      initializeTimeoutMilliseconds: EVENT_TIMEOUT,
      requestTimeoutMilliseconds: EVENT_TIMEOUT,
      shutdownTimeoutMilliseconds: 5000,
    });
    const session = new Session(this, started.sessionId);
    this.sessions.add(session.id);
    await session.awaitEvent('the session to become ready', (event) => event.type === 'stateChanged' && event.state === 'ready');
    return session;
  }

  /** Stops a session and removes it, within ten seconds. */
  async endSession(id) {
    await this.execute('lsp.stopServer', { sessionId: id });
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if ((await this.execute('lsp.destroyServer', { sessionId: id })).ok) {
        this.sessions.delete(id);
        return;
      }
      await this.execute('lsp.waitEvents', { sessionId: id, timeoutMilliseconds: 200 });
    }
    throw new Error(`Session ${id} did not stop within 10 seconds.`);
  }

  async close() {
    try {
      for (const id of [...this.sessions]) await this.endSession(id).catch(() => {});
    } finally {
      this.child.stdin.end();
      const exited = await Promise.race([this.exited.then(() => true), delay(5000).then(() => false)]);
      if (!exited) {
        this.child.kill('SIGKILL');
        await this.exited;
      }
    }
  }
}

/** One provider session and the events it has sent so far. */
export class Session {
  constructor(core, id) {
    this.core = core;
    this.id = id;
    this.events = [];
  }

  /** The first event, already received or new, that `matches`. */
  async awaitEvent(description, matches) {
    const deadline = Date.now() + EVENT_TIMEOUT;
    for (;;) {
      const event = this.events.find(matches);
      if (event) return event;
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error(`Timed out waiting for ${description}; events: ${JSON.stringify(this.events, null, 2)}`);
      }
      const drained = await this.core.call('lsp.waitEvents', {
        sessionId: this.id,
        timeoutMilliseconds: Math.min(remaining, 1000),
      });
      this.events.push(...(drained.events ?? []));
    }
  }

  /** Stops the provider and waits until it has exited. */
  async stop() {
    await this.core.call('lsp.stopServer', { sessionId: this.id });
    await this.awaitEvent('the provider to stop', (event) => event.type === 'stateChanged' && event.state === 'stopped');
  }
}
