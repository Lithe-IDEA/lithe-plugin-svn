import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import { readTarGz, repository, verifySdk, verifySdkDownload } from '../scripts/verify-sdk.mjs';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** A minimal ustar writer so the tests can build archives without the tar binary. */
function tarGz(entries) {
  const blocks = [];
  for (const { name, data = Buffer.alloc(0), type = '0' } of entries) {
    const header = Buffer.alloc(512);
    header.write(name, 0, 100, 'utf8');
    header.write('0000644\0', 100);
    header.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124);
    header.write('        ', 148);
    header.write(type, 156);
    header.write('ustar\0', 257);
    const sum = header.reduce((total, byte) => total + byte, 0);
    header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
    blocks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

const commit = '0123456789abcdef0123456789abcdef01234567';
const repositoryURL = 'https://github.com/Lithe-IDEA/lithe-plugin-docs';
const packageJSON = Buffer.from(JSON.stringify({ name: '@lithe/plugin-sdk', version: '9.9.9' }));

/** A small plugin checkout whose lock pins a synthetic release archive. */
async function fixture(t, { archiveFiles = {}, vendored = {} } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'lithe-sdk-lock-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sources = {
    'package/LICENSE': Buffer.from('license'),
    'package/src/index.mjs': Buffer.from('export {};'),
    ...archiveFiles,
  };
  const archive = tarGz([{ name: 'package/package.json', data: packageJSON }, ...Object.entries(sources).map(([name, data]) => ({ name, data }))]);
  const harness = Buffer.from('harness');
  const placed = {
    'vendor/LICENSE': sources['package/LICENSE'],
    'vendor/lithe-plugin-sdk/src/index.mjs': sources['package/src/index.mjs'],
    'vendor/lithe-plugin-sdk/test/harness.mjs': harness,
    'vendor/lithe-testing/test-timing-lib.mjs': Buffer.from('timing'),
    ...vendored,
  };
  for (const [path, data] of Object.entries(placed)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), data);
  }
  const entry = (origin, upstream, path) => ({ origin, upstream, path, sha256: sha256(placed[path]) });
  const lock = {
    schemaVersion: 2,
    sdk: {
      package: '@lithe/plugin-sdk', version: '9.9.9', repository: repositoryURL, tag: 'sdk-node-v9.9.9', commit,
      url: `${repositoryURL}/releases/download/sdk-node-v9.9.9/lithe-plugin-sdk-node-9.9.9.tgz`, sha256: sha256(archive),
    },
    files: [
      entry('sdkArchive', 'package/LICENSE', 'vendor/LICENSE'),
      entry('sdkArchive', 'package/src/index.mjs', 'vendor/lithe-plugin-sdk/src/index.mjs'),
      entry('sdkCommit', 'sdk/node/test/harness.mjs', 'vendor/lithe-plugin-sdk/test/harness.mjs'),
      entry('testSupport', '.agents/skills/write-stable-tests/scripts/test-timing-lib.mjs', 'vendor/lithe-testing/test-timing-lib.mjs'),
    ],
    testSupport: { repository: 'https://github.com/example/host', revision: commit },
  };
  await writeFile(join(root, 'sdk.lock.json'), JSON.stringify(lock));
  const downloads = new Map([
    [lock.sdk.url, archive],
    [`https://raw.githubusercontent.com/Lithe-IDEA/lithe-plugin-docs/${commit}/sdk/node/test/harness.mjs`, harness],
  ]);
  const download = async (url) => {
    if (!downloads.has(url)) throw new Error(`unexpected download ${url}`);
    return downloads.get(url);
  };
  return { root, lock, archive, downloads, download };
}

async function rewriteLock(root, change) {
  const lock = JSON.parse(await readFile(join(root, 'sdk.lock.json'), 'utf8'));
  change(lock);
  await writeFile(join(root, 'sdk.lock.json'), JSON.stringify(lock));
}

test('the checked-in lock pins the released Node.js SDK without local changes', { timeout: 5000 }, async () => {
  const lock = JSON.parse(await readFile(join(repository, 'sdk.lock.json'), 'utf8'));
  assert.equal(lock.schemaVersion, 2);
  assert.equal(lock.sdk.repository, repositoryURL);
  assert.equal(lock.sdk.tag, `sdk-node-v${lock.sdk.version}`);
  assert.equal(lock.sdk.url, `${repositoryURL}/releases/download/${lock.sdk.tag}/lithe-plugin-sdk-node-${lock.sdk.version}.tgz`);
  assert.match(lock.sdk.commit, /^[0-9a-f]{40}$/);
  assert.match(lock.sdk.sha256, /^[0-9a-f]{64}$/);
  for (const entry of lock.files) assert.deepEqual(Object.keys(entry).sort(), ['origin', 'path', 'sha256', 'upstream']);
  assert.equal(JSON.stringify(lock).includes('localChanges'), false);
  assert.equal((await verifySdk()).version, lock.sdk.version);
});

test('offline verification rejects a lock that does not name the official release', { timeout: 10000 }, async (t) => {
  const { root } = await fixture(t);
  assert.equal((await verifySdk(root)).version, '9.9.9');
  const rejected = [
    [/Invalid SDK lock: sdk/, (lock) => { lock.sdk.repository = 'https://github.com/example/fork'; }],
    [/Invalid SDK lock: sdk/, (lock) => { lock.sdk.tag = 'sdk-node-v0.0.1'; }],
    [/Invalid SDK lock: sdk/, (lock) => { lock.sdk.url = 'https://example.invalid/sdk.tgz'; }],
    [/Invalid SDK lock: sdk/, (lock) => { lock.sdk.commit = 'main'; }],
    [/Invalid SDK lock: sdk/, (lock) => { lock.sdk.sha256 = 'abc'; }],
    [/Invalid SDK lock: expected/, (lock) => { lock.schemaVersion = 1; }],
    [/carry no local changes/, (lock) => { lock.files[1].localChanges = true; }],
    [/Invalid or duplicate/, (lock) => { lock.files[1].origin = 'testSupport'; }],
    [/Invalid or duplicate/, (lock) => { lock.files[1].path = '../outside.mjs'; }],
    [/Invalid or duplicate/, (lock) => { lock.files[1].path = lock.files[0].path; }],
  ];
  for (const [pattern, change] of rejected) {
    const bad = await fixture(t);
    await rewriteLock(bad.root, change);
    await assert.rejects(verifySdk(bad.root), pattern);
  }
});

test('download verification accepts exactly the archive and tagged files the lock names', { timeout: 10000 }, async (t) => {
  const { root, download } = await fixture(t);
  assert.equal((await verifySdkDownload(root, download)).tag, 'sdk-node-v9.9.9');
});

test('download verification rejects an archive whose SHA-256 differs from the lock', { timeout: 10000 }, async (t) => {
  const { root, lock, downloads, download } = await fixture(t);
  downloads.set(lock.sdk.url, tarGz([{ name: 'package/package.json', data: packageJSON }]));
  await assert.rejects(verifySdkDownload(root, download), /archive SHA-256 mismatch/);
});

test('download verification rejects a vendored file that differs from the archive', { timeout: 10000 }, async (t) => {
  // The lock hash matches the edited vendored bytes, so only the archive comparison can catch it.
  const { root, download } = await fixture(t, { vendored: { 'vendor/lithe-plugin-sdk/src/index.mjs': Buffer.from('export const local = true;') } });
  await assert.rejects(verifySdkDownload(root, download), /does not match the released SDK: vendor\/lithe-plugin-sdk\/src\/index\.mjs/);
});

test('download verification rejects an archive that lacks a pinned file or a different package version', { timeout: 10000 }, async (t) => {
  const missing = await fixture(t);
  await rewriteLock(missing.root, (lock) => { lock.files[1].upstream = 'package/src/missing.mjs'; });
  await assert.rejects(verifySdkDownload(missing.root, missing.download), /does not contain package\/src\/missing\.mjs/);
  const wrongVersion = await fixture(t);
  const archive = tarGz([{ name: 'package/package.json', data: Buffer.from(JSON.stringify({ name: '@lithe/plugin-sdk', version: '1.0.0' })) }]);
  wrongVersion.downloads.set(wrongVersion.lock.sdk.url, archive);
  await rewriteLock(wrongVersion.root, (lock) => { lock.sdk.sha256 = sha256(archive); });
  await assert.rejects(verifySdkDownload(wrongVersion.root, wrongVersion.download), /not the locked package version/);
});

test('download verification rejects a tagged file that changed upstream', { timeout: 10000 }, async (t) => {
  const { root, downloads, download } = await fixture(t);
  downloads.set(`https://raw.githubusercontent.com/Lithe-IDEA/lithe-plugin-docs/${commit}/sdk/node/test/harness.mjs`, Buffer.from('changed'));
  await assert.rejects(verifySdkDownload(root, download), /does not match the released SDK: vendor\/lithe-plugin-sdk\/test\/harness\.mjs/);
});

test('the archive reader accepts regular files and refuses unsafe entries', { timeout: 5000 }, () => {
  const files = readTarGz(tarGz([{ name: 'package/', type: '5' }, { name: 'package/a.txt', data: Buffer.from('a') }]));
  assert.deepEqual([...files.keys()], ['package/a.txt']);
  assert.throws(() => readTarGz(tarGz([{ name: '../escape', data: Buffer.from('x') }])), /unsafe or duplicate/);
  assert.throws(() => readTarGz(tarGz([{ name: '/absolute', data: Buffer.from('x') }])), /unsafe or duplicate/);
  assert.throws(() => readTarGz(tarGz([{ name: 'package/a', data: Buffer.from('1') }, { name: 'package/a', data: Buffer.from('2') }])), /unsafe or duplicate/);
  assert.throws(() => readTarGz(tarGz([{ name: 'package/link', type: '2' }])), /unsupported type/);
});
