// End-to-end scenario of the plugin package against Lithe Core and a real
// `svn` client on a `file://` repository. The package is assembled by
// scripts/package.mjs, so the test runs exactly what is shipped: root
// detection from the manifest, the launch plan, the negotiation, and every
// operation through `lsp.vcsRequest`, including the failures a provider
// must tell apart (out of date, conflict) and the moves svn must record.
// A second working copy plays a colleague committing at the same time.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, constants } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, relative } from 'node:path';
import test from 'node:test';
import { buildPackage } from '../scripts/package.mjs';
import { Core, integrationSkip } from './support/core.mjs';

const VCS = 'svn';

/**
 * svn waits up to a second after changing working files so a later edit
 * gets a newer timestamp. Its own test suite turns that off with this
 * variable; the scenario does too, so its ~40 writes do not take a minute.
 * Every edit here changes the file's size, which svn compares as well.
 */
const NO_TIMESTAMP_SLEEP = { SVN_I_LOVE_CORRUPTED_WORKING_COPIES_SO_DISABLE_SLEEP_FOR_TIMESTAMPS: 'yes' };

/** The `svn` client from `LITHE_SVN`, or the first one on PATH. */
function svnExecutable() {
  if (process.env.LITHE_SVN) return process.env.LITHE_SVN;
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    const candidate = join(directory, 'svn');
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Not in this directory.
    }
  }
  throw new Error('Install Subversion 1.8 or newer, or set LITHE_SVN to its svn client.');
}

/** Runs the scenario's own commands with the provider's environment and a private configuration. */
function svnRunner(executable, config) {
  const environment = { ...process.env, ...NO_TIMESTAMP_SLEEP, LC_MESSAGES: 'C' };
  delete environment.LC_ALL;
  delete environment.LANGUAGE;
  environment.LC_CTYPE = process.platform === 'darwin' ? 'UTF-8' : 'C.UTF-8';
  return (directory, args) =>
    execFileSync(executable, ['--non-interactive', '--config-dir', config, ...args], {
      cwd: directory,
      env: environment,
      encoding: 'utf8',
      timeout: 30_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
}

/** Every file below `root` with its SHA-256, to prove the package is unchanged. */
async function listing(root) {
  const files = new Map();
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else files.set(relative(root, path), createHash('sha256').update(await readFile(path)).digest('hex'));
    }
  }
  await walk(root);
  return files;
}

async function write(root, path, contents) {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), contents);
}

const read = (root, path) => readFile(join(root, path), 'utf8');
const exists = (path) => stat(path).then(() => true, () => false);
const change = (path, status, oldPath = null) => [path, status, oldPath];
const revisionIds = (entries) => entries.map((entry) => entry.revision.id);

/** Operations through Core as the host sends them, and their replies as Core decodes them. */
class Provider {
  constructor(core, session, { capabilities, root, tool }) {
    Object.assign(this, { core, session, capabilities, root, tool, sequence: 0 });
  }

  /** Sends one operation and returns its `requestCompleted` event. */
  async send(operation, args) {
    const operationId = `${operation}-${++this.sequence}`;
    await this.core.call('lsp.vcsRequest', {
      sessionId: this.session.id,
      operationId,
      vcs: VCS,
      operation,
      root: this.root,
      tool: this.tool,
      arguments: args,
    });
    // Every terminal outcome, cancellation included, is one requestCompleted.
    return this.session.awaitEvent(`operation ${operationId} to end`, (event) =>
      event.operationId === operationId && event.type === 'requestCompleted');
  }

  async request(operation, args = {}) {
    const completed = await this.send(operation, args);
    assert.equal(completed.error, undefined, `${operation} failed: ${JSON.stringify(completed)}`);
    const decoded = await this.core.call('vcs.decodeReply', {
      operation,
      capabilities: this.capabilities,
      request: args,
      reply: completed.result.value,
    });
    assert.equal(decoded.status, 'ok', `${operation}: ${JSON.stringify(decoded)}`);
    return decoded.result;
  }

  /** `[path, status, oldPath]` of each change, in Core's order. */
  async changes() {
    return (await this.request('status')).changes.map((item) => [item.path, item.status, item.oldPath]);
  }

  /** The execution report of the first `svn` subcommand named `subcommand`. */
  async execution(subcommand) {
    const event = await this.session.awaitEvent(`the ${subcommand} report`, (candidate) => {
      if (candidate.type !== 'log' || candidate.message !== 'lithe/vcs/execution') return false;
      try {
        return JSON.parse(candidate.detail ?? '{}').command?.[2] === subcommand;
      } catch {
        return false;
      }
    });
    return JSON.parse(event.detail);
  }
}

test('the plugin works on a real working copy through Lithe Core', { skip: integrationSkip, timeout: 120_000 }, async (t) => {
  const svnPath = svnExecutable();
  const scratch = await realpath(await mkdtemp(join(tmpdir(), 'lithe-svn-scenario-')));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const core = await Core.start(t);

  const { directory: packageDirectory } = await buildPackage(join(scratch, 'dist'));
  const packageBefore = await listing(packageDirectory);
  const manifest = JSON.parse(await readFile(join(packageDirectory, 'plugin.json'), 'utf8'));
  const validated = await core.call('plugins.declarative.validate', { manifest });
  assert.equal(validated.status, 'ok', JSON.stringify(validated));

  // Revision 1 creates trunk, revision 2 the files the scenario changes.
  const svn = svnRunner(svnPath, join(scratch, 'svn-config'));
  const repository = join(scratch, 'repository');
  execFileSync(join(dirname(svnPath), 'svnadmin'), ['create', repository], { timeout: 30_000 });
  const trunk = `file://${repository}/trunk`;
  svn(scratch, ['mkdir', '-m', 'Create trunk', '--username', 'alice', trunk]);
  const workspace = join(scratch, 'workspace');
  const other = join(scratch, 'other');
  svn(scratch, ['checkout', trunk, 'workspace']);
  await write(workspace, 'a.txt', 'one\ntwo\n');
  await write(workspace, 'docs/b.txt', 'bee\n');
  await write(workspace, 'keep.txt', 'keep\n');
  svn(workspace, ['add', 'a.txt', 'docs', 'keep.txt']);
  svn(workspace, ['commit', '-m', 'Initial', '--username', 'alice']);
  // A commit leaves the root directory at its old revision; a fresh
  // checkout, as users start from, has the whole tree at one revision.
  svn(workspace, ['update']);
  svn(scratch, ['checkout', trunk, 'other']);

  // Core finds the working copy root from the manifest's `.svn` marker.
  const detection = await core.call('vcs.detectRoots', { workspaceRoot: workspace, plugins: [{ manifest }] });
  assert.equal(detection.status, 'ok', JSON.stringify(detection));
  const root = detection.detection.roots.find((candidate) => candidate.vcs === VCS);
  assert.ok(root, `no Subversion root: ${JSON.stringify(detection)}`);
  assert.equal(root.path, workspace);

  const plan = await core.call('plugins.declarative.languageServerLaunchPlan', {
    manifest,
    vcsProviderID: VCS,
    request: {
      pluginDirectory: packageDirectory,
      stateDirectory: join(scratch, 'state'),
      workspaceStateDirectory: join(scratch, 'workspace-state'),
      architecture: process.arch === 'arm64' ? 'arm64' : 'x86_64',
    },
  });
  assert.equal(plan.status, 'ok', JSON.stringify(plan));
  assert.deepEqual(plan.plan.vcsProvider.tool.commands, ['svn']);
  const session = await core.startSession({
    providerId: `vcsProvider:${manifest.id}:${VCS}`,
    pluginId: manifest.id,
    executable: process.execPath,
    arguments: plan.plan.arguments,
    workspace,
    environment: NO_TIMESTAMP_SLEEP,
  });
  const negotiated = await session.awaitEvent('the VCS negotiation', (event) => event.type === 'vcsProvider');
  assert.equal(negotiated.result.vcs, VCS);
  // Subversion commits straight to the server and has no staging area.
  const capabilities = negotiated.result.capabilities;
  assert.deepEqual(capabilities, {
    annotate: 1, baseContent: 1, checkin: 1, cleanup: 1, conflicts: 1,
    fileHistory: 1, fileOperations: 1, history: 1, rollback: 1, status: 1, update: 1,
  });
  const provider = new Provider(core, session, { capabilities, root: workspace, tool: svnPath });

  // A client the host resolved but that cannot run is its own error.
  provider.tool = join(scratch, 'missing/svn');
  const unavailable = await provider.send('status', {});
  assert.equal(unavailable.error?.code, 'vcs.tool.unavailable', JSON.stringify(unavailable));
  provider.tool = svnPath;

  // Local edits, a file removed without svn, and a new file.
  await write(workspace, 'a.txt', 'one\nTWO\nthree\n');
  await unlink(join(workspace, 'docs/b.txt'));
  await write(workspace, 'c.txt', 'sea\n');
  assert.deepEqual(await provider.changes(), [
    change('a.txt', 'modified'),
    change('c.txt', 'unversioned'),
    change('docs/b.txt', 'missing'),
  ]);
  assert.deepEqual((await provider.request('status')).head, {
    revision: { id: '2', display: 'r2', kind: 'number' }, branch: null, location: trunk,
  });
  await provider.request('fileOperation', { kind: 'add', paths: ['c.txt'] });
  assert.deepEqual((await provider.changes())[1], change('c.txt', 'added'));
  assert.deepEqual(await provider.request('baseContent', { path: 'a.txt' }), { content: 'one\ntwo\n', binary: false });
  assert.deepEqual(await provider.request('baseContent', { path: 'c.txt' }), { content: null, binary: false });

  // A colleague commits keep.txt first; committing ours is out of date,
  // which the host shows as its own error.
  await write(other, 'keep.txt', 'theirs\n');
  svn(other, ['commit', '-m', 'Theirs', '--username', 'bob']);
  await write(workspace, 'keep.txt', 'mine, edited\n');
  const rejected = await provider.send('checkin', { paths: ['keep.txt'], message: 'Mine' });
  assert.equal(rejected.error?.code, 'vcs.outOfDate', JSON.stringify(rejected));
  await provider.request('rollback', { paths: ['keep.txt'] });
  assert.equal(await read(workspace, 'keep.txt'), 'keep\n');

  // Mutating commands are reported for the console; reads are not.
  await provider.request('cleanup');
  const report = await provider.execution('cleanup');
  assert.deepEqual(report.command, [svnPath, '--non-interactive', 'cleanup']);
  assert.equal(report.exitCode, 0, JSON.stringify(report));

  // The missing file is deleted through svn as part of the check-in.
  const checkedIn = await provider.request('checkin', {
    paths: ['a.txt', 'c.txt', 'docs/b.txt'], message: 'Second\n\nWith a body.',
  });
  assert.deepEqual(checkedIn.revision, { id: '4', display: 'r4', kind: 'number' });
  assert.deepEqual(await provider.changes(), []);
  assert.deepEqual(await provider.request('update'), {
    revision: { id: '4', display: 'r4', kind: 'number' }, conflicts: [],
  });
  assert.equal(await read(workspace, 'keep.txt'), 'theirs\n');

  // History pages run newest first and resume from the cursor.
  const first = await provider.request('history', { limit: 1 });
  assert.deepEqual(revisionIds(first.entries), ['4']);
  assert.equal(first.nextCursor, '3');
  assert.equal(first.entries[0].message, 'Second\n\nWith a body.');
  assert.deepEqual(first.entries[0].changes, [
    { path: 'a.txt', oldPath: null, status: 'modified', flags: [] },
    { path: 'c.txt', oldPath: null, status: 'added', flags: [] },
    { path: 'docs/b.txt', oldPath: null, status: 'deleted', flags: [] },
  ]);
  const rest = await provider.request('history', { limit: 2, cursor: '3' });
  assert.deepEqual(revisionIds(rest.entries), ['3', '2']);
  assert.equal(rest.entries[1].author, 'alice');
  assert.equal(rest.nextCursor, '1');
  const fileHistory = await provider.request('fileHistory', { path: 'a.txt' });
  assert.deepEqual(revisionIds(fileHistory.entries), ['4', '2']);
  assert.equal(fileHistory.nextCursor, null);

  // Annotation follows the working file: a local line has no revision.
  await write(workspace, 'a.txt', 'one\nTWO\nthree\nfour\n');
  const annotation = await provider.request('annotate', { path: 'a.txt' });
  assert.deepEqual(annotation.lines, ['2', '4', '4', null]);
  assert.deepEqual(revisionIds(annotation.revisions), ['2', '4']);
  assert.equal(annotation.revisions[0].message, 'Initial');
  await provider.request('rollback', { paths: ['a.txt'] });

  // A move is a rename from its source; rolling it back restores the source.
  await provider.request('fileOperation', { kind: 'move', from: 'c.txt', to: 'docs/c.txt' });
  assert.deepEqual(await provider.changes(), [change('docs/c.txt', 'renamed', 'c.txt')]);
  await provider.request('rollback', { paths: ['docs/c.txt'] });
  assert.equal(await exists(join(workspace, 'docs/c.txt')), false);
  assert.equal(await read(workspace, 'c.txt'), 'sea\n');
  assert.deepEqual(await provider.changes(), []);

  // An unversioned file moves on disk, but never over a file already there.
  await write(workspace, 'scratch.txt', 'scratch\n');
  const overwrite = await provider.send('fileOperation', { kind: 'move', from: 'scratch.txt', to: 'keep.txt' });
  assert.match(JSON.stringify(overwrite.error), /keep\.txt already exists/, JSON.stringify(overwrite));
  assert.equal(await read(workspace, 'keep.txt'), 'theirs\n');
  assert.equal(await read(workspace, 'scratch.txt'), 'scratch\n');
  await provider.request('fileOperation', { kind: 'move', from: 'scratch.txt', to: 'notes/scratch.txt' });
  assert.equal(await exists(join(workspace, 'scratch.txt')), false);
  assert.equal(await read(workspace, 'notes/scratch.txt'), 'scratch\n');
  await rm(join(workspace, 'notes'), { recursive: true });

  // Checking in the destination alone commits both halves of the move.
  await provider.request('fileOperation', { kind: 'move', from: 'c.txt', to: 'docs/c.txt' });
  const moved = await provider.request('checkin', { paths: ['docs/c.txt'], message: 'Move c' });
  assert.equal(moved.revision.id, '5');
  assert.deepEqual(await provider.changes(), []);
  const moveEntry = await provider.request('history', { limit: 1 });
  assert.deepEqual(moveEntry.entries[0].changes, [
    { path: 'docs/c.txt', oldPath: 'c.txt', status: 'renamed', flags: [] },
  ]);

  // An update that conflicts leaves the file conflicted until resolved.
  svn(other, ['update']);
  await write(other, 'docs/c.txt', 'sea from bob\n');
  svn(other, ['commit', '-m', "Bob's c", '--username', 'bob']);
  await write(workspace, 'docs/c.txt', 'sea from us\n');
  const updated = await provider.request('update');
  assert.equal(updated.revision.id, '6');
  assert.deepEqual(updated.conflicts, ['docs/c.txt']);
  const conflicted = await provider.send('checkin', { paths: ['docs/c.txt'], message: 'Too early' });
  assert.equal(conflicted.error?.code, 'vcs.conflict', JSON.stringify(conflicted));
  await writeFile(join(workspace, 'docs/c.txt'), 'sea from both\n');
  await provider.request('resolve', { paths: ['docs/c.txt'] });
  assert.deepEqual(await provider.changes(), [change('docs/c.txt', 'modified')]);
  assert.equal(await read(workspace, 'docs/c.txt'), 'sea from both\n');
  await provider.request('rollback', { paths: ['docs/c.txt'] });
  assert.equal(await read(workspace, 'docs/c.txt'), 'sea from bob\n');

  // A tracked delete removes the file; rollback brings it back.
  await provider.request('fileOperation', { kind: 'delete', paths: ['keep.txt'] });
  assert.equal(await exists(join(workspace, 'keep.txt')), false);
  assert.deepEqual(await provider.changes(), [change('keep.txt', 'deleted')]);
  await provider.request('rollback', { paths: ['keep.txt'] });
  assert.equal(await read(workspace, 'keep.txt'), 'theirs\n');

  // Paths in a changelist are still changes of the root.
  await write(workspace, 'a.txt', 'one\ntwo\nlisted\n');
  svn(workspace, ['changelist', 'review', 'a.txt']);
  assert.deepEqual(await provider.changes(), [change('a.txt', 'modified')]);
  svn(workspace, ['changelist', '--remove', 'a.txt']);
  await provider.request('rollback', { paths: ['a.txt'] });

  // New paths are added on check-in: a whole directory, a name svn would
  // read as a peg revision, and a binary file whose base is not sent.
  await write(workspace, 'new/x.txt', 'x\n');
  await write(workspace, 'new/sub/y.txt', 'y\n');
  await write(workspace, 'a@b.txt', 'at\n');
  await writeFile(join(workspace, 'image.bin'), Buffer.from('bin\0ary', 'binary'));
  assert.deepEqual(await provider.changes(), [
    change('a@b.txt', 'unversioned'),
    change('image.bin', 'unversioned'),
    change('new', 'unversioned'),
  ]);
  const added = await provider.request('checkin', { paths: ['new', 'a@b.txt', 'image.bin'], message: 'Add new files' });
  assert.equal(added.revision.id, '7');
  assert.deepEqual(await provider.changes(), []);
  assert.deepEqual(revisionIds((await provider.request('fileHistory', { path: 'new/sub/y.txt' })).entries), ['7']);
  assert.deepEqual(await provider.request('baseContent', { path: 'a@b.txt' }), { content: 'at\n', binary: false });
  assert.deepEqual(await provider.request('baseContent', { path: 'image.bin' }), { content: null, binary: true });

  await session.stop();
  await core.endSession(session.id);
  assert.deepEqual(await listing(packageDirectory), packageBefore, 'the plugin package changed at runtime');
});
