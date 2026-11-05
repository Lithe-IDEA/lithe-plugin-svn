#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';

export const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const sdkRepository = 'https://github.com/Lithe-IDEA/lithe-plugin-docs';
const sdkPackage = '@lithe/plugin-sdk';
const origins = new Set(['sdkArchive', 'sdkCommit', 'testSupport']);
const entryKeys = ['origin', 'path', 'sha256', 'upstream'];
const isSha256 = (value) => /^[0-9a-f]{64}$/.test(value);
const isCommit = (value) => /^[0-9a-f]{40}$/.test(value);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const fail = (message) => { throw new Error(message); };

/** Reject a path that could leave its directory or name something other than a plain relative file. */
function isPlainRelativePath(path) {
  return typeof path === 'string' && !isAbsolute(path) && !path.includes('\\')
    && !path.split('/').some((part) => !part || part === '.' || part === '..');
}

/**
 * Read the pinned release identity and per-file hashes from sdk.lock.json.
 * The lock names the released Node.js SDK archive (tag, commit, URL, SHA-256)
 * and records where every vendored file comes from.
 */
function validateLock(lock) {
  const sdk = lock?.sdk;
  if (lock?.schemaVersion !== 2 || !sdk || !Array.isArray(lock.files)) fail('Invalid SDK lock: expected schemaVersion 2 with an sdk release and files.');
  if (sdk.package !== sdkPackage || sdk.repository !== sdkRepository || !/^\d+\.\d+\.\d+$/.test(sdk.version)
    || sdk.tag !== `sdk-node-v${sdk.version}` || !isCommit(sdk.commit) || !isSha256(sdk.sha256)
    || sdk.url !== `${sdkRepository}/releases/download/${sdk.tag}/lithe-plugin-sdk-node-${sdk.version}.tgz`) {
    fail('Invalid SDK lock: sdk must pin the released Node.js SDK by version, tag, commit, release URL and SHA-256.');
  }
  const testSupport = lock.testSupport;
  if (!testSupport || typeof testSupport.repository !== 'string' || !testSupport.repository.startsWith('https://github.com/') || !isCommit(testSupport.revision)) {
    fail('Invalid SDK lock: testSupport must pin an exact source revision.');
  }
  const paths = new Set();
  for (const entry of lock.files) {
    const keys = Object.keys(entry).sort();
    if (keys.length !== entryKeys.length || keys.some((key, index) => key !== entryKeys[index])) fail(`Invalid SDK lock entry: ${entry.path ?? '(no path)'} may only record ${entryKeys.join(', ')}; vendored SDK files carry no local changes.`);
    if (!origins.has(entry.origin) || !isPlainRelativePath(entry.path) || !entry.path.startsWith('vendor/') || !isPlainRelativePath(entry.upstream)
      || !isSha256(entry.sha256) || paths.has(entry.path)
      || ((entry.path === 'vendor/LICENSE' || entry.path.startsWith('vendor/lithe-plugin-sdk/src/')) && entry.origin !== 'sdkArchive')) {
      fail(`Invalid or duplicate SDK lock entry: ${entry.path}`);
    }
    paths.add(entry.path);
  }
  return { sdk, files: lock.files, paths };
}

async function readLock(root) {
  return JSON.parse(await readFile(join(root, 'sdk.lock.json'), 'utf8'));
}

/** Offline check: the lock is well formed and every vendored file matches its recorded SHA-256. */
export async function verifySdk(root = repository) {
  const { sdk, files, paths } = validateLock(await readLock(root));
  const expected = new Set(paths);
  for (const entry of files) {
    const file = join(root, entry.path);
    if (!(await lstat(file)).isFile()) fail(`SDK input is not a regular file: ${entry.path}`);
    if (sha256(await readFile(file)) !== entry.sha256) fail(`SDK SHA-256 mismatch: ${entry.path}`);
  }
  async function walk(directory, prefix) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const name = `${prefix}/${entry.name}`;
      if (entry.isDirectory()) await walk(join(directory, entry.name), name);
      else if (!expected.delete(name)) fail(`Unpinned SDK input: ${name}`);
    }
  }
  await walk(join(root, 'vendor'), 'vendor');
  if (expected.size) fail('A pinned SDK input is missing.');
  return sdk;
}

/** Unpack the regular files of a gzip-compressed ustar archive in memory; nothing is written to disk. */
export function readTarGz(archive) {
  const tar = gunzipSync(archive, { maxOutputLength: 32 * 1024 * 1024 });
  const files = new Map();
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const text = (start, length) => {
      const field = header.subarray(start, start + length);
      const end = field.indexOf(0);
      return field.subarray(0, end < 0 ? length : end).toString('utf8');
    };
    const checksum = header.reduce((total, byte, index) => total + (index >= 148 && index < 156 ? 32 : byte), 0);
    if (checksum !== Number.parseInt(text(148, 8).trim(), 8)) fail('SDK archive has a corrupt tar header.');
    const size = Number.parseInt(text(124, 12).trim(), 8);
    const name = text(0, 100);
    const type = header[156] === 0 ? '0' : String.fromCharCode(header[156]);
    offset += 512;
    if (!Number.isSafeInteger(size) || size < 0 || offset + size > tar.length) fail(`SDK archive entry is truncated: ${name}`);
    if (type === '0') {
      if (!isPlainRelativePath(name) || files.has(name)) fail(`SDK archive entry has an unsafe or duplicate path: ${name}`);
      files.set(name, Buffer.from(tar.subarray(offset, offset + size)));
    } else if (type !== '5') {
      fail(`SDK archive entry has an unsupported type: ${name}`);
    }
    offset += Math.ceil(size / 512) * 512;
  }
  return files;
}

/** Fetch a small HTTPS asset with a bounded size and timeout, retrying transient failures. */
export async function downloadBytes(url, { attempts = 3, timeoutMs = 60000, maximumBytes = 8 * 1024 * 1024 } = {}) {
  if (!url.startsWith('https://')) fail(`Refusing to download a non-HTTPS URL: ${url}`);
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length > maximumBytes) throw new Error('response is larger than expected');
      return bytes;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await new Promise((done) => setTimeout(done, 1000 * attempt));
    }
  }
  throw new Error(`Could not download ${url}: ${lastError.message}`);
}

/**
 * Online check: download the released SDK archive, require its SHA-256 to match the lock, and
 * require every vendored file that came from it (or from the tagged commit) to match byte for byte.
 * `download` is injectable so tests never touch the network.
 */
export async function verifySdkDownload(root = repository, download = downloadBytes) {
  const sdk = await verifySdk(root);
  const { files } = validateLock(await readLock(root));
  const archive = await download(sdk.url);
  if (sha256(archive) !== sdk.sha256) fail(`SDK archive SHA-256 mismatch: expected ${sdk.sha256}, got ${sha256(archive)} (${sdk.url})`);
  const contents = readTarGz(archive);
  const manifest = JSON.parse(contents.get('package/package.json')?.toString('utf8') ?? 'null');
  if (manifest?.name !== sdkPackage || manifest.version !== sdk.version) fail('SDK archive is not the locked package version.');
  const repositoryPath = new URL(sdk.repository).pathname.slice(1);
  for (const entry of files) {
    if (entry.origin === 'testSupport') continue;
    const vendored = await readFile(join(root, entry.path));
    const upstream = entry.origin === 'sdkArchive'
      ? contents.get(entry.upstream)
      : await download(`https://raw.githubusercontent.com/${repositoryPath}/${sdk.commit}/${entry.upstream}`);
    if (!upstream) fail(`SDK archive does not contain ${entry.upstream}.`);
    if (!vendored.equals(upstream)) fail(`Vendored file does not match the released SDK: ${entry.path}`);
  }
  return sdk;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== '--download')) {
    console.error('Usage: node scripts/verify-sdk.mjs [--download]');
    process.exit(2);
  }
  const download = args.includes('--download');
  const sdk = download ? await verifySdkDownload() : await verifySdk();
  console.log(`Verified ${sdk.package} ${sdk.version} (${sdk.tag}, ${sdk.commit.slice(0, 7)})${download ? ` against ${sdk.url}` : ' offline'}`);
}
